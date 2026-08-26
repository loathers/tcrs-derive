import { describe, expect, it } from "vitest";
import type { RunEventInit } from "#core/events";
import { formatRow, rowView, summaryLine } from "#core/present";
import { orderedPerms, type RunState, reduceAll } from "#core/state";
import { freshState, happyPath, stamp } from "./helpers/events.ts";
import { present } from "./helpers/present.ts";

/**
 * Freezes the whole 54-row chart, so any change to what the operator sees has to
 * be a deliberate one rather than a side effect.
 */
function render(state: RunState): string {
	return [
		...orderedPerms(state).map((p) => formatRow(rowView(p))),
		summaryLine(state.summary),
	].join("\n");
}

describe("the 54-row chart", () => {
	it("renders a fresh run as all-queued", () => {
		expect(render(freshState())).toMatchSnapshot();
	});

	it("renders a mid-run frame covering every status at once", () => {
		// One permutation in each state, so the snapshot exercises the full vocabulary.
		const events: RunEventInit[] = [
			// done
			...happyPath("sc_mongoose"),
			// deriving items, mid-way
			{ type: "perm:attempt", user: "sc_wallaby", attempt: 1, maxAttempts: 3 },
			{ type: "perm:phase", user: "sc_wallaby", phase: "items" },
			{ type: "perm:progress", user: "sc_wallaby", done: 2200, total: 12070 },
			// deriving items on a retry
			{ type: "perm:attempt", user: "sc_vole", attempt: 2, maxAttempts: 3 },
			{ type: "perm:phase", user: "sc_vole", phase: "items" },
			{ type: "perm:progress", user: "sc_vole", done: 11000, total: 12070 },
			// cafe phase
			{ type: "perm:attempt", user: "sc_platypus", attempt: 1, maxAttempts: 3 },
			{ type: "perm:phase", user: "sc_platypus", phase: "cafe_booze" },
			// login
			{ type: "perm:attempt", user: "sc_opossum", attempt: 1, maxAttempts: 3 },
			// stalled
			{ type: "perm:attempt", user: "sc_marmot", attempt: 1, maxAttempts: 3 },
			{
				type: "perm:transient",
				user: "sc_marmot",
				marker: "connect timed out",
			},
			// retrying (in backoff)
			{ type: "perm:attempt", user: "sc_wombat", attempt: 1, maxAttempts: 3 },
			{
				type: "perm:retryWait",
				user: "sc_wombat",
				seconds: 15,
				nextAttempt: 2,
			},
			// failed
			{
				type: "perm:failed",
				user: "sc_blender",
				attempts: 3,
				copied: 0,
				reason: "login",
			},
			// failed with partial files
			{
				type: "perm:failed",
				user: "sc_packrat",
				attempts: 2,
				copied: 2,
				reason: "incomplete",
			},
			// skipped by resume
			{ type: "batch:skipped", user: "tt_mongoose", reason: "resume" },
		];
		expect(render(reduceAll(freshState(), stamp(events)))).toMatchSnapshot();
	});

	it("renders a completed run", () => {
		const events = orderedPerms(freshState()).flatMap((p) => happyPath(p.user));
		const final = reduceAll(freshState(), stamp(events));
		expect(final.summary).toEqual({
			total: 54,
			done: 54,
			running: 0,
			failed: 0,
			queued: 0,
			skipped: 0,
		});
		expect(render(final)).toMatchSnapshot();
	});
});

describe("chart geometry", () => {
	it("keeps every row the same width for a stable in-place redraw", () => {
		// ink diffs frames, so nothing depends on a fixed frame height, but
		// equal-width rows still matter for a tidy chart.
		const state = reduceAll(freshState(), stamp(happyPath("sc_mongoose")));
		const bars = orderedPerms(state).map((p) => rowView(p).bar.length);
		expect(new Set(bars)).toEqual(new Set([10]));

		const prefixes = orderedPerms(state).map((p) =>
			formatRow(rowView(p)).indexOf("["),
		);
		expect(new Set(prefixes).size).toBe(1);
	});

	it("matches the README's documented example format", () => {
		// README.md shows: `sc_mongoose  [█████████░]  91% real`
		// (the phase label is now `items`, matching mafia's own wording).
		const state = reduceAll(
			freshState(),
			stamp([
				{
					type: "perm:attempt",
					user: "sc_mongoose",
					attempt: 1,
					maxAttempts: 3,
				},
				{ type: "perm:phase", user: "sc_mongoose", phase: "items" },
				{ type: "perm:progress", user: "sc_mongoose", done: 91, total: 100 },
			]),
		);
		expect(formatRow(rowView(present(state.perms.sc_mongoose)))).toBe(
			"sc_mongoose  [█████████░]  91% items",
		);
	});
});
