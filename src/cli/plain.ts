/**
 * Non-TTY / --no-progress / --json output.
 *
 * Port of the bash's `[ -t 2 ] && NO_PROGRESS != 1` branch. ink writes each frame
 * sequentially when stdout is a pipe, which is unusable output, so a non-interactive
 * run takes a completely different path: one line per state transition.
 *
 * TWO DELIBERATE FIXES to the bash's behaviour:
 *  - Human-readable output goes to STDOUT. Everything went to stderr before, so
 *    `./run-all.sh > out.txt` produced an empty file.
 *  - Retry/discard diagnostics are printed as they happen. The bash shunted them to
 *    logs/_run.log purely so they would not corrupt the chart, which hid
 *    "[user] retrying after incomplete attempt 1/3", the single most useful line
 *    when debugging flakiness.
 */

import type { RunEvent } from "#core/events";
import { summaryLine } from "#core/present";
import type { RunState } from "#core/state";

export interface PlainOptions {
	json: boolean;
	out?: (line: string) => void;
	err?: (line: string) => void;
}

export function createPlainReporter(o: PlainOptions) {
	const out = o.out ?? ((l: string) => process.stdout.write(`${l}\n`));
	const err = o.err ?? ((l: string) => process.stderr.write(`${l}\n`));

	return function report(event: RunEvent, state: RunState): void {
		if (o.json) {
			// NDJSON of the raw event stream: the same wire format the SSE endpoint and
			// `tcrs attach` consume.
			out(JSON.stringify(event));
			return;
		}

		switch (event.type) {
			case "batch:start":
				out(
					`Running ${event.users.length} permutation(s) with concurrency ${event.concurrency}`,
				);
				break;

			case "batch:warmup":
				if (event.status === "start") out("Warming up shared data files...");
				if (event.status === "ok") out("Warm-up complete.");
				if (event.status === "failed") {
					err("Warm-up failed; continuing without a template.");
				}
				break;

			case "batch:skipped":
				out(`  SKIP  ${event.user} (already complete)`);
				break;

			case "perm:attempt":
				if (event.attempt > 1) {
					out(
						`  ....  ${event.user} attempt ${event.attempt}/${event.maxAttempts}`,
					);
				}
				break;

			case "perm:phase":
				out(`  ....  ${event.user} ${event.phase}`);
				break;

			case "perm:discarded":
				// Was invisible during a bash run.
				err(
					`  WARN  ${event.user} derive did not complete (bailed early), discarding partial data`,
				);
				break;

			case "perm:retryWait":
				err(
					`  WARN  ${event.user} retrying in ${event.seconds}s (attempt ${event.nextAttempt})`,
				);
				break;

			case "perm:loginTimeout":
				err(`  WARN  ${event.user} login stuck after ${event.seconds}s`);
				break;

			case "perm:hardTimeout":
				err(`  WARN  ${event.user} timed out after ${event.seconds}s`);
				break;

			case "perm:done":
				out(
					`  OK    ${event.user} (3/3 files, attempt ${event.attempts}/${state.perms[event.user]?.maxAttempts ?? "?"})`,
				);
				break;

			case "perm:failed":
				err(
					`  FAIL  ${event.user} (${event.copied}/3 files after ${event.attempts} attempt(s)), ${event.reason}`,
				);
				break;

			case "warn":
				err(`  WARN  ${event.user ?? "batch"}: ${event.message}`);
				break;

			case "batch:end":
				out("");
				out(summaryLine(state.summary));
				break;

			default:
				break;
		}
	};
}

/** The final OK/FAIL block, port of run-all.sh:281-304. */
export function formatSummaryTable(state: RunState): string {
	const lines: string[] = [];
	lines.push("==================== SUMMARY ====================");
	for (const user of state.order) {
		const p = state.perms[user];
		if (!p) continue;
		switch (p.status.kind) {
			case "done":
				lines.push(
					`  OK    ${user.padEnd(16)} (${p.classToken} / ${p.signCap})`,
				);
				break;
			case "skipped":
				lines.push(`  SKIP  ${user.padEnd(16)} (already complete)`);
				break;
			case "failed":
				lines.push(
					`  FAIL  ${user.padEnd(16)} ${p.status.copied}/3 files, ${p.status.reason}`,
				);
				break;
			default:
				lines.push(`  ????  ${user.padEnd(16)} ${p.status.kind}`);
				break;
		}
	}
	lines.push("-------------------------------------------------");
	const s = state.summary;
	lines.push(
		`  ${s.done} ok, ${s.failed} failed${s.skipped > 0 ? `, ${s.skipped} skipped` : ""}, ${s.total} total`,
	);
	lines.push("=================================================");
	return lines.join("\n");
}
