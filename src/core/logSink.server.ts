/**
 * Per-permutation log files. NODE-ONLY.
 *
 * Consumes the LogChunk channel (deliberately NOT RunEvent, raw output is ~50k
 * high-churn lines per batch and has no business going through the reducer or out
 * to every connected browser).
 *
 * Logs live inside the run's own staging dir, so nothing is ever destructively
 * overwritten. run-all.sh:54 did `rm -f "$LOG_DIR"/*.log` at the START of a run, * wiping the previous run's logs precisely when you are re-running because
 * something failed and you want them.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";

export class LogSink {
	#streams = new Map<string, WriteStream>();

	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	write(user: string, chunk: string): void {
		let stream = this.#streams.get(user);
		if (!stream) {
			stream = createWriteStream(join(this.#dir, `${user}.log`), {
				flags: "a",
			});
			// A log write failing must never take down a run.
			stream.on("error", () => {});
			this.#streams.set(user, stream);
		}
		stream.write(chunk);
	}

	/** Mark an attempt boundary, so a retried permutation's log stays readable. */
	markAttempt(user: string, attempt: number, maxAttempts: number): void {
		this.write(user, `\n=== attempt ${attempt}/${maxAttempts} ===\n`);
	}

	async close(): Promise<void> {
		const closing = [...this.#streams.values()].map(
			(s) =>
				new Promise<void>((resolve) => {
					s.end(() => resolve());
				}),
		);
		this.#streams.clear();
		await Promise.all(closing);
	}
}
