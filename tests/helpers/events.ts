import type { RunEvent, RunEventInit } from "#core/events";
import { ALL_PERMUTATIONS } from "#core/permutations";
import { initialRunState, type RunState } from "#core/state";

/** Fixed epoch so every snapshot is deterministic: 2026-08-24T09:15:03.123Z. */
export const T0 = 1_787_908_503_123;

/**
 * Stamp a list of event inits with monotonic seq and a synthetic clock, mirroring
 * what EventBus does at runtime. Each event advances the clock by 1s.
 */
export function stamp(inits: readonly RunEventInit[], t0 = T0): RunEvent[] {
	return inits.map(
		(init, i) => ({ ...init, seq: i + 1, at: t0 + i * 1000 }) as RunEvent,
	);
}

export function freshState(
	users?: readonly string[],
	overrides: Partial<{ concurrency: number; maxAttempts: number }> = {},
): RunState {
	const perms = users
		? ALL_PERMUTATIONS.filter((p) => users.includes(p.user))
		: ALL_PERMUTATIONS;
	return initialRunState(perms, {
		runId: "2026-08-24T09-15-03-123Z",
		concurrency: overrides.concurrency ?? 4,
		maxAttempts: overrides.maxAttempts ?? 3,
		startedAt: T0,
	});
}

/** The event sequence a permutation emits on a clean, successful derive. */
export function happyPath(user: string): RunEventInit[] {
	return [
		{ type: "perm:attempt", user, attempt: 1, maxAttempts: 3 },
		{ type: "perm:spawned", user, attempt: 1, pid: 4242 },
		{ type: "perm:phase", user, phase: "items" },
		{ type: "perm:progress", user, done: 1, total: 12070 },
		{ type: "perm:progress", user, done: 6001, total: 12070 },
		{ type: "perm:progress", user, done: 12001, total: 12070 },
		{ type: "perm:phase", user, phase: "cafe_booze" },
		{ type: "perm:phase", user, phase: "cafe_food" },
		{ type: "perm:wrote", user, file: `TCRS_X.txt` },
		{ type: "perm:collected", user, copied: 3, complete: true },
		{ type: "perm:done", user, attempts: 1 },
	];
}
