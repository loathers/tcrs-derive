/**
 * The per-permutation worker. NODE-ONLY.
 *
 * Runs one KoLmafia JVM to completion, retrying on transient failures, and reports
 * everything it learns as events. Per-attempt state is scoped by allocating a fresh
 * DeriveTracker; liveness is the child's 'close' event rather than any polling.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	copyFile,
	cp,
	mkdir,
	rename,
	rm,
	stat,
	unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { minimalEnv } from "./env.server.ts";
import type { FailureReason, RunEventInit } from "./events.ts";
import {
	COMPLETE_TOLERANCE,
	DeriveTracker,
	isDeriveComplete,
	LineSplitter,
} from "./parser.ts";
import type { Permutation } from "./permutations.ts";

export interface Clock {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve, reject) => {
			if (signal?.aborted) return reject(new AbortedError());
			const t = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			function onAbort() {
				clearTimeout(t);
				reject(new AbortedError());
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		}),
};

export class AbortedError extends Error {
	constructor() {
		super("aborted");
		this.name = "AbortedError";
	}
}

/**
 * Which mafia command derives the data.
 *
 * `derive` is the only one r29189 and earlier have. Later builds add `introspect`,
 * which does what `derive` used to, while `derive` narrows to "introspect only the
 * items missing from items.txt". They are NOT interchangeable, and sending
 * `introspect` to a jar that predates it fails the run.
 */
export type TcrsCommand = "derive" | "introspect";

export interface RunOneOptions {
	permutation: Permutation;
	password: string;
	jarPath: string;
	/** Defaults to `derive`, the one every jar has. */
	tcrsCommand?: TcrsCommand | undefined;
	javaBin: string;
	/** Extra JVM flags, prepended. Production: -Xmx512m -XX:+UseSerialGC. Tests use
	 *  it to configure fake-java, since the child env is deliberately minimal. */
	javaOpts?: readonly string[];
	/** Private working directory. The entire basis of safe concurrency. */
	workDir: string;
	/** Shared warm-up template, or null when the warm-up failed. */
	templateDir: string | null;
	/** Where collected files land, the staging dir, never a live published dir. */
	outputDir: string;
	maxAttempts: number;
	loginTimeoutMs: number;
	timeoutMs: number;
	retryBackoffMs: number;
	completeTolerance?: number;
	/** Opt-in, default off. Without it a wedged derive burns the full timeout. */
	stallTimeoutMs?: number | null;
	keepWorkdir?: boolean;
	signal?: AbortSignal | undefined;
	emit(event: RunEventInit): void;
	onLog?: ((chunk: string, attempt: number) => void) | undefined;
	clock?: Clock;
}

export interface RunOneResult {
	user: string;
	ok: boolean;
	copied: number;
	attempts: number;
	reason?: FailureReason;
	itemsDone: number;
	itemsTotal: number;
	filesWritten: string[];
	mafiaBuild: string | null;
}

/** Never rejects: every failure is reported in the result. */
export async function runOne(o: RunOneOptions): Promise<RunOneResult> {
	const { permutation: p, maxAttempts, emit, signal, clock = realClock } = o;
	const tolerance = o.completeTolerance ?? COMPLETE_TOLERANCE;

	let copied = 0;
	let attempt = 0;
	let reason: FailureReason | undefined;
	let lastTracker: DeriveTracker | null = null;

	while (attempt < maxAttempts) {
		if (signal?.aborted) {
			return result(false, "cancelled");
		}
		attempt++;
		// Each attempt classifies itself. `reason` outlives the loop so the value the
		// LAST attempt reached is what gets reported, but carrying one forward means
		// the classifier below (guarded on `reason === undefined`) is skipped and this
		// attempt's failure is labelled with the previous one's cause.
		reason = undefined;
		emit({ type: "perm:attempt", user: p.user, attempt, maxAttempts });

		try {
			await seedWorkdir(o);
		} catch (e) {
			emit({
				type: "warn",
				user: p.user,
				message: `could not prepare work dir: ${errMessage(e)}`,
			});
			return result(false, "spawn");
		}

		// Seeding is a rm -rf + cp -r of the template tree, long enough for a cancel to
		// land inside it. The top-of-loop check has already passed by then, so without
		// this one the JVM is spawned after the run was told to stop.
		if (signal?.aborted) return result(false, "cancelled");

		const tracker = new DeriveTracker();
		lastTracker = tracker;
		const outcome = await runAttempt(o, attempt, tracker, clock);

		if (outcome === "cancelled") return result(false, "cancelled");

		// Collect the three files mafia should have written.
		const collected = await collect(o);
		copied = collected.copied;
		const complete = copied > 0 && isDeriveComplete(tracker, tolerance);
		emit({ type: "perm:collected", user: p.user, copied, complete });

		if (copied === 3 && complete) {
			if (!o.keepWorkdir) await rm(o.workDir, { recursive: true, force: true });
			emit({ type: "perm:done", user: p.user, attempts: attempt });
			return result(true);
		}

		let transient = outcome === "transient" || tracker.sawTransient;

		// Files present but the items derive bailed early means partial data. Discard
		// the copies so a later RESUME cannot adopt exactly the truncated file the
		// completeness guard exists to reject, and treat it as retryable, bails are
		// load-induced and often succeed on a quieter retry.
		if (copied > 0 && !complete) {
			await discard(o);
			copied = 0;
			transient = true;
			emit({ type: "perm:discarded", user: p.user, reason: "incomplete" });
			reason = "incomplete";
		}

		// Now classify. notInTcrs is checked FIRST and forces transient=false: the
		// account genuinely isn't in a TCRS run, so retrying cannot help and would
		// burn all maxAttempts (and three logins) on a permanent condition.
		if (tracker.notInTcrs) {
			reason = "not-in-tcrs";
			transient = false;
		} else if (outcome === "loginTimeout") {
			reason = "login";
			transient = true;
		} else if (outcome === "hardTimeout") {
			reason = "timeout";
		} else if (outcome === "stallTimeout") {
			reason = "stalled";
			transient = true;
		} else if (reason === undefined && copied === 0) {
			reason = tracker.started ? "no-files" : "login";
		}

		if (!o.keepWorkdir) await rm(o.workDir, { recursive: true, force: true });

		if (transient && attempt < maxAttempts) {
			const seconds = Math.round((o.retryBackoffMs * attempt) / 1000);
			emit({
				type: "perm:retryWait",
				user: p.user,
				seconds,
				nextAttempt: attempt + 1,
			});
			try {
				await clock.sleep(o.retryBackoffMs * attempt, signal);
			} catch {
				return result(false, "cancelled");
			}
			continue;
		}
		break;
	}

	emit({
		type: "perm:failed",
		user: p.user,
		attempts: attempt,
		copied,
		reason: reason ?? "no-files",
	});
	return result(false, reason ?? "no-files");

	function result(ok: boolean, why?: FailureReason): RunOneResult {
		const items = lastTracker?.itemsProgress;
		return {
			user: p.user,
			ok,
			copied,
			attempts: attempt,
			...(why === undefined ? {} : { reason: why }),
			itemsDone: items?.done ?? 0,
			itemsTotal: items?.total ?? 0,
			filesWritten: lastTracker ? [...lastTracker.wrote] : [],
			mafiaBuild: lastTracker?.build ?? null,
		};
	}
}

type AttemptOutcome =
	| "exited"
	| "transient"
	| "loginTimeout"
	| "hardTimeout"
	| "stallTimeout"
	| "cancelled";

/** Run one JVM to completion (or to a watchdog firing). */
async function runAttempt(
	o: RunOneOptions,
	attempt: number,
	tracker: DeriveTracker,
	clock: Clock,
): Promise<AttemptOutcome> {
	const { permutation: p, emit, signal } = o;

	const args = [
		...(o.javaOpts ?? []),
		"-Djava.awt.headless=true", // makes mafia read yes/no prompts from stdin
		"-DuseCWDasROOT=true", // roots mafia at cwd, so data/ lands where we collect
		"-jar",
		o.jarPath,
		"--CLI",
	];

	let child: ChildProcess;
	try {
		child = spawn(o.javaBin, args, {
			cwd: o.workDir,
			// detached: true calls setsid(2), so the child leads its own process group
			// and process.kill(-pid) reaps the JVM AND every descendant atomically.
			// Signalling the group is atomic, where walking the tree with repeated
			// pgrep -P races against a fork happening mid-enumeration.
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: minimalEnv(),
		});
	} catch (e) {
		emit({
			type: "warn",
			user: p.user,
			message: `spawn failed: ${errMessage(e)}`,
		});
		return "exited";
	}

	const pgid = child.pid ?? null;
	emit({ type: "perm:spawned", user: p.user, attempt, pid: pgid });

	// The password goes on stdin, never argv, argv is visible in ps and
	// /proc/<pid>/cmdline. The two `no`s answer the login-time "derive TCRS data?"
	// prompts. Sending exactly two keeps the following commands in the right slots
	// whether zero, one or two prompts appear. The trailing newline AND the EOF from
	// end() are both load-bearing: without EOF, an unexpected prompt blocks until the
	// hard timeout.
	const script = [
		p.user,
		o.password,
		"no",
		"no",
		"tcrs reset",
		`tcrs ${o.tcrsCommand ?? "derive"}`,
		"tcrs save",
		"exit",
	].join("\n");
	child.stdin?.on("error", () => {
		// EPIPE if the JVM died before reading the script. The watchdogs handle it.
	});
	child.stdin?.end(`${script}\n`);

	let outcome: AttemptOutcome | null = null;
	let lastProgressAt = clock.now();

	const finish = (o2: AttemptOutcome) => {
		outcome ??= o2;
	};

	// One splitter per stream. Merging them at fd level (`2>&1`) can splice two
	// half-written lines into a single nonsense one.
	const handle = (stream: NodeJS.ReadableStream | null) => {
		if (!stream) return;
		const splitter = new LineSplitter();
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			o.onLog?.(chunk, attempt);
			for (const line of splitter.push(chunk)) consume(line);
		});
		stream.on("end", () => {
			for (const line of splitter.flush()) consume(line);
		});
	};

	const consume = (line: string) => {
		const before = tracker.itemsProgress;
		const parsed = tracker.accept(line);
		switch (parsed.kind) {
			case "phase":
				emit({ type: "perm:phase", user: p.user, phase: parsed.phase });
				break;
			case "progress":
				if (tracker.itemsProgress !== before) lastProgressAt = clock.now();
				emit({
					type: "perm:progress",
					user: p.user,
					done: parsed.done,
					total: parsed.total,
				});
				break;
			case "wrote":
				emit({ type: "perm:wrote", user: p.user, file: parsed.file });
				break;
			case "transient":
				emit({ type: "perm:transient", user: p.user, marker: parsed.marker });
				// Transients count ONLY before deriving starts. Once it is under way they
				// are noise, and the completeness guard catches any real fallout.
				if (!tracker.started) finish("transient");
				break;
			case "notInTcrs":
			case "build":
			case "other":
				break;
		}
	};

	handle(child.stdout);
	handle(child.stderr);

	// Decide on 'close', never 'exit'. 'exit' fires while stdout may still hold
	// buffered lines, so deciding then can miss the final Progress: 12001/12070 and
	// turn a fully successful run into a discarded partial.
	const closed = new Promise<void>((resolve) => {
		child.on("close", (code, sig) => {
			emit({
				type: "perm:exited",
				user: p.user,
				code: code ?? null,
				signal: sig ?? null,
			});
			finish("exited");
			resolve();
		});
		child.on("error", (e) => {
			emit({
				type: "warn",
				user: p.user,
				message: `child error: ${e.message}`,
			});
			finish("exited");
			resolve();
		});
	});

	// --- Watchdogs ------------------------------------------------------------
	const timers: NodeJS.Timeout[] = [];

	// Armed AT SPAWN, not at derive start: login can itself wedge, and a timeout
	// that only starts counting once deriving begins would never fire for that.
	timers.push(
		setTimeout(() => {
			emit({
				type: "perm:hardTimeout",
				user: p.user,
				seconds: Math.round(o.timeoutMs / 1000),
			});
			finish("hardTimeout");
			void kill(child, pgid);
		}, o.timeoutMs),
	);

	// The login watchdog: disarmed by the first phase:items or progress, which is
	// exactly STARTED_RE.
	timers.push(
		setTimeout(() => {
			if (tracker.started) return;
			emit({
				type: "perm:loginTimeout",
				user: p.user,
				seconds: Math.round(o.loginTimeoutMs / 1000),
			});
			finish("loginTimeout");
			void kill(child, pgid);
		}, o.loginTimeoutMs),
	);

	const stallMs = o.stallTimeoutMs ?? null;
	let stallTimer: NodeJS.Timeout | null = null;
	if (stallMs !== null) {
		stallTimer = setInterval(
			() => {
				if (!tracker.started) return;
				if (clock.now() - lastProgressAt < stallMs) return;
				finish("stallTimeout");
				void kill(child, pgid);
			},
			Math.max(1000, Math.floor(stallMs / 4)),
		);
		timers.push(stallTimer);
	}

	const onAbort = () => {
		finish("cancelled");
		void kill(child, pgid, "SIGKILL");
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	// addEventListener on an ALREADY-aborted signal never fires, so the abort has to
	// be replayed by hand. Covers the window between the check above and here, which
	// spans the spawn itself.
	if (signal?.aborted) onAbort();

	await closed;

	for (const t of timers) clearTimeout(t);
	if (stallTimer) clearInterval(stallTimer);
	signal?.removeEventListener("abort", onAbort);

	return outcome ?? "exited";
}

/**
 * TERM the whole process group, then KILL if it does not die within 3s. The grace
 * period lets mafia flush and exit cleanly rather than leaving a torn data dir.
 */
async function kill(
	child: ChildProcess,
	pgid: number | null,
	signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
	if (pgid === null || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	signalGroup(pgid, signal);
	if (signal === "SIGKILL") return;

	await new Promise<void>((resolve) => setTimeout(resolve, 3000));
	if (child.exitCode === null && child.signalCode === null) {
		signalGroup(pgid, "SIGKILL");
	}
}

/**
 * Signal a whole process group. The negated pid is what makes this reap every
 * descendant, with detached: true the child's pgid equals its pid.
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// ESRCH: already gone. EPERM: not ours. Neither is actionable.
	}
}

async function seedWorkdir(o: RunOneOptions): Promise<void> {
	await rm(o.workDir, { recursive: true, force: true });
	await mkdir(o.workDir, { recursive: true });
	if (o.templateDir === null) return;

	try {
		await cp(o.templateDir, o.workDir, {
			recursive: true,
			force: true,
			verbatimSymlinks: true,
		});
	} catch (e) {
		// Seeding is best-effort, but a failure here means the JVM re-downloads
		// everything, so it is worth surfacing rather than swallowing.
		o.emit({
			type: "warn",
			user: o.permutation.user,
			message: `template copy failed, continuing without it: ${errMessage(e)}`,
		});
		return;
	}

	// LOAD-BEARING: start with a clean data dir. If the template's data/ leaked in,
	// mafia would find an existing TCRS_<Class>_<Sign>.txt from the warm-up or
	// another permutation and SKIP DERIVING ENTIRELY, producing a wrong-but-plausible
	// output file.
	await rm(join(o.workDir, "data"), { recursive: true, force: true });
}

/**
 * Where mafia may have put the TCRS files, relative to the JVM's working dir.
 *
 * r29183 moved the output into a `TCRS/` subdirectory of the data dir. Older jars
 * wrote it flat. Both are searched, newest layout first, so the tool works across
 * jar versions rather than silently collecting nothing, which is exactly what
 * happened: all three phases completed, mafia reported "Wrote file TCRS/...", and
 * collect() found zero files because it only looked at `data/`.
 */
const OUTPUT_DIRS = ["data/TCRS", "data"] as const;

/**
 * Copy the three files into the staging output dir.
 *
 * Two rules, both load-bearing:
 *  - size > 0 is required, not merely existence: a zero-byte file must never count
 *    toward `copied`.
 *  - written to `.<name>.part` and then renamed, so a torn copy can never be
 *    mistaken for good data by anything reading the directory concurrently.
 */
async function collect(o: RunOneOptions): Promise<{ copied: number }> {
	let copied = 0;
	for (const name of o.permutation.files) {
		const src = await findOutput(o.workDir, name);
		if (src === null) continue;
		try {
			const tmp = join(o.outputDir, `.${name}.part`);
			const dest = join(o.outputDir, name);
			await copyFile(src, tmp);
			await rename(tmp, dest);
			copied++;
		} catch {
			// Unreadable or undeletable: simply not collected.
		}
	}
	return { copied };
}

/** The first candidate location holding a non-empty file, or null. */
async function findOutput(
	workDir: string,
	name: string,
): Promise<string | null> {
	for (const dir of OUTPUT_DIRS) {
		const candidate = join(workDir, dir, name);
		try {
			const st = await stat(candidate);
			// size > 0 required (`[ -s ]`, not `[ -f ]`): a zero-byte file must not count.
			if (st.isFile() && st.size > 0) return candidate;
		} catch {
			// Not here. Try the next layout.
		}
	}
	return null;
}

/** Remove this permutation's published files after an incomplete derive. */
async function discard(o: RunOneOptions): Promise<void> {
	for (const name of o.permutation.files) {
		await unlink(join(o.outputDir, name)).catch(() => {});
	}
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
