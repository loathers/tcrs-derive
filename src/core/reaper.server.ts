/**
 * Process-group reaper. NODE-ONLY.
 *
 * Every JVM is spawned `detached: true`, which setsid()s it into its own process
 * group. That is what makes kill(-pgid) reap a whole JVM subtree atomically, but it
 * also means a SIGTERM to us does NOT reach them. This module is the obligation the
 * bash met with `disown` plus an EXIT trap.
 *
 * IN DOCKER THIS MATTERS TWICE OVER. A detached JVM that outlives its parent is
 * reparented to PID 1, and Node as PID 1 does not reap children, they become
 * zombies that accumulate across runs. Hence tini as the image ENTRYPOINT; this
 * reaper is the in-process half of the same concern.
 */

import { signalGroup } from "./runOne.server.ts";

const live = new Set<number>();
let installed = false;

export function track(pgid: number): void {
	live.add(pgid);
	install();
}

export function untrack(pgid: number): void {
	live.delete(pgid);
}

/** TERM every tracked group, then KILL after a grace period. */
export function reapAll(grace = 3000): void {
	for (const pgid of live) signalGroup(pgid, "SIGTERM");
	if (live.size === 0) return;
	const timer = setTimeout(() => {
		for (const pgid of live) signalGroup(pgid, "SIGKILL");
		live.clear();
	}, grace);
	// Do not hold the event loop open just to escalate.
	timer.unref?.();
}

/** Synchronous best-effort kill, for exit paths that cannot await. */
export function reapAllNow(): void {
	for (const pgid of live) signalGroup(pgid, "SIGKILL");
	live.clear();
}

function install(): void {
	if (installed) return;
	installed = true;
	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.once(sig, () => {
			reapAll();
		});
	}
	process.once("exit", reapAllNow);
	process.once("uncaughtException", (e) => {
		reapAllNow();
		throw e;
	});
}
