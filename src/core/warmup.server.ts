/**
 * The shared data-file warm-up. NODE-ONLY.
 *
 * One mafia run populates a template directory of common data files, which every
 * permutation then seeds its private work dir from, so the startup downloads
 * happen once rather than 54 times.
 */

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { minimalEnv } from "./env.server.ts";
import { signalGroup } from "./runOne.server.ts";

export interface WarmUpOptions {
	jarPath: string;
	javaBin: string;
	javaOpts?: readonly string[];
	templateDir: string;
	timeoutMs: number;
	onLog?: ((chunk: string) => void) | undefined;
	signal?: AbortSignal | undefined;
}

/**
 * Best-effort: on any failure the caller continues with templateDir = null and
 * each permutation downloads its own data.
 */
export async function warmUp(o: WarmUpOptions): Promise<boolean> {
	// Nothing below is worth doing for a run that has already been told to stop, and
	// the rm would destroy a usable template on the way out for nothing.
	if (o.signal?.aborted) return false;

	await rm(o.templateDir, { recursive: true, force: true });
	await mkdir(o.templateDir, { recursive: true });

	// Wiping and rebuilding the template tree is slow enough for a cancel to land
	// inside it. Checking here rather than relying on the listener below is what
	// stops the spawn: addEventListener on an already-aborted signal never fires.
	if (o.signal?.aborted) return false;

	const child = spawn(
		o.javaBin,
		[
			...(o.javaOpts ?? []),
			"-Djava.awt.headless=true",
			"-DuseCWDasROOT=true",
			"-jar",
			o.jarPath,
			"--CLI",
		],
		{
			cwd: o.templateDir,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: minimalEnv(),
		},
	);

	const pgid = child.pid ?? null;

	// ------------------------------------------------------------------------
	// THE EMPTY FIRST LINE IS LOAD-BEARING. DO NOT "FIX" IT.
	//
	// mafia prints `username: ` and reads one line. An EMPTY username makes
	// attemptLogin fail immediately with `Invalid login.` WITHOUT CONSUMING THE NEXT
	// LINE, so `exit` stays queued and is read as the next CLI command, cleanly
	// quitting the JVM *after* it has already downloaded and refreshed the shared
	// data files into <cwd>/data and <cwd>/settings.
	//
	// Verified by tests/fixtures/logs/warmup.log, whose entire body is
	// `username: Invalid login.`
	//
	// Drop the empty line and `exit` is consumed AS THE USERNAME, leaving mafia
	// parked at the `password:` prompt with stdin already at EOF. It then hangs until
	// the timeout below kills it and the template is never populated.
	// ------------------------------------------------------------------------
	child.stdin?.on("error", () => {});
	child.stdin?.end(`${["", "exit"].join("\n")}\n`);

	for (const stream of [child.stdout, child.stderr]) {
		if (!stream) continue;
		stream.setEncoding("utf8");
		stream.on("data", (c: string) => o.onLog?.(c));
	}

	// AbortSignal.timeout rather than a detached timer: it is cancelled by the same
	// signal plumbing as everything else, so nothing outlives the kill.
	const timeout = AbortSignal.timeout(o.timeoutMs);
	const signals = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;

	const onAbort = () => {
		if (pgid !== null) signalGroup(pgid, "SIGKILL");
	};
	signals.addEventListener("abort", onAbort, { once: true });
	// AbortSignal.any over an already-aborted input is itself already aborted, and
	// fires nothing. Replay by hand to cover the window spanning the spawn.
	if (signals.aborted) onAbort();

	try {
		const code = await new Promise<number | null>((resolve) => {
			child.on("close", (c) => resolve(c));
			child.on("error", () => resolve(null));
		});
		return code === 0 && !signals.aborted;
	} finally {
		signals.removeEventListener("abort", onAbort);
	}
}
