/**
 * Streaming parser for KoLmafia's --CLI output.
 *
 * PURE: no `node:` imports. Every line each JVM writes is classified here, once,
 * as it arrives, and nothing downstream re-reads a log to work out what happened.
 *
 * THE REGEXES HERE ARE THE HIGHEST-RISK PART OF THIS FILE. Every pattern is
 * grounded in the real logs committed under tests/fixtures/logs/. Across two full
 * successful runs, exactly five distinct lines match
 * /error|exception|timed out|unable|fail/i, and ALL FIVE ARE BENIGN:
 *
 *   Error during session initialization           (in 54/54 successful runs)
 *   Unable to invoke no                           (108x across successes)
 *   Unexpected error, debug log printed.          (mid-run, run completed)
 *   IO Exception for TCRS_....txt: FileNotFound   (every run. Mafia probing)
 *   Local file TCRS_....txt does not exist.       (every run)
 *
 * Misclassifying any of them as transient burns all 3 attempts on all 54
 * permutations. tests/parser.falsePositives.test.ts exists to prevent exactly that.
 */

import type { Phase } from "./events.ts";

/**
 * "This attempt is doomed, but a retry might work", network blips where mafia's
 * Java client can't reach KoL even though the box can. Matched case-insensitively.
 *
 * Two single-character traps, both load-bearing:
 *  - `IOException retrieving` (no space) vs the benign `IO Exception for` (space).
 *  - `Unable to (establish|connect)` MUST keep its alternation. Loosening it to
 *    /Unable to/ matches the benign "Unable to invoke no", present 108 times
 *    across runs that all succeeded.
 */
export const TRANSIENT_RE =
	/connect timed out|connection timed out|read timed out|IOException retrieving server reply|Connection reset|Unable to (?:establish|connect)/i;

/**
 * The account genuinely started introspecting, login worked, don't kill it. Matched
 * case-sensitively: the capitalisation is mafia's own and is stable.
 */
export const STARTED_RE =
	/(?:Deriving|Introspecting) TCRS item adjustments for all real items|Progress: /;

/** Phase headers. Only the `real items` phase emits Progress: lines. */
// r29189 and earlier say "Deriving". Later builds say "Introspecting" for the same
// three phases, and keep a "Deriving" line for the narrower `tcrs derive`. Matching
// both means one parser works whichever jar a run happens to pick up.
const PHASE_RE =
	/(?:Deriving|Introspecting) TCRS item adjustments for all (real|cafe booze|cafe food) items/;

/** `Progress: 4001/12070` */
const PROGRESS_RE = /Progress: (\d+)\/(\d+)/;

/**
 * `Wrote file TCRS_Turtle_Tamer_Wallaby_cafe_food.txt` (older jars) or
 * `Wrote file TCRS/TCRS_Turtle_Tamer_Wallaby_cafe_food.txt` (r29183+, which moved
 * the output into a `TCRS/` subdirectory of the data dir).
 *
 * The optional directory prefix is load-bearing: an anchored `TCRS_` pattern
 * silently stopped matching when the path changed, so `perm:wrote` never fired and
 * filesWritten was always empty. Captured separately so callers know both the
 * basename and where mafia actually put it.
 */
const WROTE_RE = /^Wrote file (?:([^\s]*)[/\\])?(TCRS_[^\s/\\]+\.txt)/;

/** The account isn't in a TCRS run. Genuinely broken, never retry this. */
const NOT_IN_TCRS_RE = /You are not in a Two Crazy Random Summer run/i;

/** mafia's build banner, e.g. `KoLmafia r29131-M`. Recorded in the manifest so a
 *  release whose output strings changed can be correlated with a parse failure. */
const BUILD_RE = /^KoLmafia (r\d+\S*)/;

const PHASE_BY_LABEL: Record<string, Phase> = {
	real: "items",
	"cafe booze": "cafe_booze",
	"cafe food": "cafe_food",
};

export type ParsedLine =
	| { kind: "phase"; phase: Phase }
	| { kind: "progress"; done: number; total: number }
	| { kind: "transient"; marker: string }
	| { kind: "wrote"; file: string; dir: string | null }
	| { kind: "notInTcrs" }
	| { kind: "build"; build: string }
	| { kind: "other" };

/**
 * Classify one line of mafia output.
 *
 * Order matters: `phase`, `progress` and `wrote` are matched before `transient` so
 * a line can never be both, and the specific benign shapes win over the broad
 * transient sweep.
 */
export function classifyLine(line: string): ParsedLine {
	const label = PHASE_RE.exec(line)?.[1];
	const phase = label === undefined ? undefined : PHASE_BY_LABEL[label];
	if (phase !== undefined) return { kind: "phase", phase };

	const progress = PROGRESS_RE.exec(line);
	if (progress) {
		const done = Number(progress[1]);
		const total = Number(progress[2]);
		// A zero or absent total would make every percentage a division by zero.
		if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
			return { kind: "progress", done, total };
		}
		return { kind: "other" };
	}

	const wrote = WROTE_RE.exec(line);
	const wroteFile = wrote?.[2];
	if (wroteFile !== undefined) {
		return { kind: "wrote", file: wroteFile, dir: wrote?.[1] ?? null };
	}

	if (NOT_IN_TCRS_RE.test(line)) return { kind: "notInTcrs" };

	const build = BUILD_RE.exec(line)?.[1];
	if (build !== undefined) return { kind: "build", build };

	const transient = TRANSIENT_RE.exec(line);
	if (transient) return { kind: "transient", marker: transient[0] };

	return { kind: "other" };
}

/** ANSI CSI escapes. Real logs contain none (jansi stays dumb on a non-tty), but a
 *  future mafia or a tty-ish environment could emit them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point here
const ANSI_RE = /\u001B\[[0-9;?]*[A-Za-z]/g;

function clean(line: string): string {
	// NULs: mafia writes them occasionally, and they corrupt any downstream
	// rendering that assumes text.
	return line.replace(/\0/g, "").replace(ANSI_RE, "").replace(/\r/g, "");
}

/**
 * Incremental line splitter over a byte stream.
 *
 * One splitter per stream, never one shared between them: merging stdout and
 * stderr at fd level can splice two half-written lines into one nonsense line.
 */
export class LineSplitter {
	#pending = "";

	/** Feed a chunk; get back the complete lines it terminated. */
	push(chunk: string): string[] {
		this.#pending += chunk;
		const parts = this.#pending.split("\n");
		// The last element is an unterminated remainder, not a line.
		this.#pending = parts.pop() ?? "";
		return parts.map(clean);
	}

	/** Flush the unterminated tail at EOF. mafia writes prompts without a trailing
	 *  newline (`username: password: `), so the tail can carry real content. */
	flush(): string[] {
		if (this.#pending === "") return [];
		const tail = clean(this.#pending);
		this.#pending = "";
		return [tail];
	}
}

/**
 * Accumulates the state of one introspect attempt from classified lines.
 *
 * One tracker per attempt. Allocating a fresh one is what scopes this state to a
 * single attempt, so a retry can never inherit the previous attempt's progress.
 */
export class IntrospectTracker {
	phase: Phase | null = null;
	/** Progress for the CURRENT phase, reset on each phase change. */
	progress: { done: number; total: number } | null = null;
	/** Last progress seen during the `items` phase specifically. This, not the
	 *  current phase's progress, is what completeness is judged on: the cafe phases
	 *  run afterwards and would otherwise overwrite the number that matters. */
	itemsProgress: { done: number; total: number } | null = null;
	started = false;
	sawTransient = false;
	transientMarker: string | null = null;
	notInTcrs = false;
	build: string | null = null;
	readonly wrote: string[] = [];

	/** Apply one raw line. Returns its classification so callers can emit events. */
	accept(line: string): ParsedLine {
		const parsed = classifyLine(line);
		switch (parsed.kind) {
			case "phase":
				this.phase = parsed.phase;
				this.progress = null;
				// Matches STARTED_RE's first alternative: the real-items header alone
				// means login worked and introspecting has begun.
				if (parsed.phase === "items") this.started = true;
				break;
			case "progress":
				this.progress = { done: parsed.done, total: parsed.total };
				this.started = true;
				// Only the items phase emits Progress:. A progress line seen before any
				// phase header is attributed to items, since that is the only reporting
				// phase and STARTED_RE treats it as the start of introspecting.
				if (this.phase === "items" || this.phase === null) {
					this.itemsProgress = { done: parsed.done, total: parsed.total };
				}
				break;
			case "transient":
				this.sawTransient = true;
				this.transientMarker ??= parsed.marker;
				break;
			case "wrote":
				this.wrote.push(parsed.file);
				break;
			case "notInTcrs":
				this.notInTcrs = true;
				break;
			case "build":
				this.build ??= parsed.build;
				break;
			case "other":
				break;
		}
		return parsed;
	}
}

/** Default COMPLETE_TOLERANCE. */
export const COMPLETE_TOLERANCE = 150;

/**
 * Did the real-items introspect actually finish?
 *
 * A mafia parallel introspect bails out, but still prints "Done!" and saves a PARTIAL
 * file, if any single item's description fetch errors. So file existence is not
 * enough to conclude the introspect succeeded.
 *
 * The tolerance must exceed mafia's 100-item announce step. Observed across all the
 * real logs: the total is 12070 and the last line is always `Progress: 12001/12070`
 *, exactly 69 short. The comparison is inclusive, so 69 is the smallest tolerance
 * that still accepts a real run; 68 rejects all 54 of them, and anything >= 12070
 * disables the guard entirely.
 *
 * Returns false when no progress was ever seen: "3 files present, no progress" must
 * be discarded, not accepted.
 */
export function isIntrospectComplete(
	tracker: IntrospectTracker,
	tolerance = COMPLETE_TOLERANCE,
): boolean {
	const p = tracker.itemsProgress;
	if (!p) return false;
	return p.done >= p.total - tolerance;
}
