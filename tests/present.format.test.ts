import { describe, expect, it } from "vitest";
import {
	BAR_WIDTH,
	cellLabel,
	formatRow,
	makeBar,
	percentFor,
	rowView,
	summaryLine,
} from "#core/present";
import type { PermState, PermStatus } from "#core/state";

/**
 * Byte-exact assertions against the bash formats in run-all.sh:129-206. If these
 * pass, the ink chart shows the operator exactly what the shell script did.
 */

function perm(status: PermStatus, over: Partial<PermState> = {}): PermState {
	return {
		user: "tt_wallaby",
		classToken: "Turtle_Tamer",
		classLabel: "Turtle Tamer",
		signCap: "Wallaby",
		attempt: 1,
		maxAttempts: 3,
		status,
		startedAt: null,
		endedAt: null,
		sawTransient: false,
		filesWritten: [],
		...over,
	};
}

describe("makeBar", () => {
	it("is 10 cells wide", () => {
		expect(BAR_WIDTH).toBe(10);
		expect(makeBar(50, "█")).toHaveLength(10);
	});

	it("floor-divides like the bash arithmetic", () => {
		// filled = pct * 10 / 100, integer division.
		expect(makeBar(0, "█")).toBe("░".repeat(10));
		expect(makeBar(9, "█")).toBe("░".repeat(10));
		expect(makeBar(10, "█")).toBe(`█${"░".repeat(9)}`);
		expect(makeBar(49, "█")).toBe("█".repeat(4) + "░".repeat(6));
		expect(makeBar(99, "█")).toBe(`${"█".repeat(9)}░`);
		expect(makeBar(100, "█")).toBe("█".repeat(10));
	});

	it("clamps out-of-range percentages", () => {
		expect(makeBar(-5, "█")).toBe("░".repeat(10));
		expect(makeBar(1000, "█")).toBe("█".repeat(10));
	});
});

describe("percentFor", () => {
	it("caps at 99 for a real completed derive", () => {
		// mafia announces every 100 items and 12070 isn't a multiple of 100, so the
		// last line is always 12001/12070. Rounding up would be a worse lie.
		expect(percentFor({ done: 12001, total: 12070 })).toBe(99);
	});

	it("returns 0 rather than NaN for a zero total", () => {
		expect(percentFor({ done: 5, total: 0 })).toBe(0);
	});
});

describe("row status strings match the bash printf formats", () => {
	const cases: Array<[string, PermStatus, string, Partial<PermState>?]> = [
		["queued", { kind: "queued" }, "queued"],
		["done", { kind: "done" }, "done"],
		["failed 0/3", { kind: "failed", copied: 0, reason: "login" }, "FAIL 0/3"],
		[
			"failed 2/3",
			{ kind: "failed", copied: 2, reason: "incomplete" },
			"FAIL 2/3",
		],
		["login", { kind: "login" }, "login"],
		["stalled", { kind: "stalled" }, "stalled"],
		["skipped", { kind: "skipped", reason: "resume" }, "skipped"],
		[
			"items 0%",
			{ kind: "deriving", phase: "items", progress: null },
			"  0% items",
		],
		[
			"items 18%",
			{ kind: "deriving", phase: "items", progress: { done: 18, total: 100 } },
			" 18% items",
		],
		[
			"items 99%",
			{
				kind: "deriving",
				phase: "items",
				progress: { done: 12001, total: 12070 },
			},
			" 99% items",
		],
		[
			"cafe booze",
			{ kind: "deriving", phase: "cafe_booze", progress: null },
			"cafe booze",
		],
		[
			"cafe food",
			{ kind: "deriving", phase: "cafe_food", progress: null },
			"cafe food",
		],
		[
			"retrying",
			{ kind: "retrying", nextAttempt: 2, waitUntil: 0 },
			"retrying 2/3",
		],
	];

	it.each(cases)("%s renders as %j", (_label, status, expected, over) => {
		expect(rowView(perm(status, over)).status).toBe(expected);
	});

	it("appends the try suffix from attempt 2 onwards", () => {
		// run-all.sh:187, only shown when the attempt number exceeds 1.
		const items: PermStatus = {
			kind: "deriving",
			phase: "items",
			progress: { done: 12, total: 100 },
		};
		expect(rowView(perm(items, { attempt: 1 })).status).toBe(" 12% items");
		expect(rowView(perm(items, { attempt: 2 })).status).toBe(
			" 12% items try 2/3",
		);
		expect(rowView(perm({ kind: "login" }, { attempt: 3 })).status).toBe(
			"login try 3/3",
		);
		expect(
			rowView(
				perm(
					{ kind: "deriving", phase: "cafe_food", progress: null },
					{
						attempt: 2,
					},
				),
			).status,
		).toBe("cafe food try 2/3");
	});

	it("uses the dark-shade fill for failures and the empty fill for queued", () => {
		expect(
			rowView(perm({ kind: "failed", copied: 0, reason: "login" })).bar,
		).toBe("▓".repeat(10));
		expect(rowView(perm({ kind: "queued" })).bar).toBe("░".repeat(10));
		expect(rowView(perm({ kind: "done" })).bar).toBe("█".repeat(10));
	});
});

describe("formatRow", () => {
	it("reproduces printf '%-12s [%s] %s'", () => {
		const v = rowView(perm({ kind: "done" }));
		expect(formatRow(v)).toBe("tt_wallaby   [██████████] done");
	});

	it("pads every real username, since the longest is 11 chars", () => {
		const longest = "sc_mongoose"; // 11
		expect(longest.length).toBeLessThan(12);
		const v = rowView(perm({ kind: "queued" }, { user: longest }));
		expect(formatRow(v).startsWith("sc_mongoose ")).toBe(true);
	});
});

describe("summaryLine", () => {
	it("keeps the bash's two spaces before the parenthesis", () => {
		expect(
			summaryLine({
				total: 54,
				done: 12,
				running: 4,
				failed: 0,
				queued: 38,
				skipped: 0,
			}),
		).toBe("Overall: 12/54 done  (4 running, 0 failed, 38 queued)");
	});

	it("mentions skipped only when there are some", () => {
		expect(
			summaryLine({
				total: 54,
				done: 0,
				running: 2,
				failed: 0,
				queued: 0,
				skipped: 52,
			}),
		).toBe("Overall: 0/54 done  (2 running, 0 failed, 0 queued, 52 skipped)");
	});
});

describe("cellLabel", () => {
	it("shows a percentage while deriving items", () => {
		expect(
			cellLabel(
				perm({
					kind: "deriving",
					phase: "items",
					progress: { done: 4530, total: 12076 },
				}),
			),
		).toBe("37%");
	});

	it("shows 0% before the first progress line, not a full bar", () => {
		expect(
			cellLabel(perm({ kind: "deriving", phase: "items", progress: null })),
		).toBe("0%");
	});

	it("shows near-complete for the cafe phases, which report no progress", () => {
		expect(
			cellLabel(
				perm({ kind: "deriving", phase: "cafe_booze", progress: null }),
			),
		).toBe("99%");
		expect(
			cellLabel(perm({ kind: "deriving", phase: "cafe_food", progress: null })),
		).toBe("99%");
	});

	it("uses words where a percentage would be meaningless", () => {
		expect(cellLabel(perm({ kind: "done" }))).toBe("100%");
		expect(
			cellLabel(perm({ kind: "failed", copied: 0, reason: "login" })),
		).toBe("fail");
		expect(
			cellLabel(perm({ kind: "retrying", nextAttempt: 2, waitUntil: 0 })),
		).toBe("retry");
		expect(cellLabel(perm({ kind: "stalled" }))).toBe("stall");
		expect(cellLabel(perm({ kind: "skipped", reason: "resume" }))).toBe("skip");
	});

	it("is empty when a permutation has not started", () => {
		// An empty cell reads as "nothing happening here" at a glance.
		expect(cellLabel(perm({ kind: "queued" }))).toBe("");
	});

	it("never just repeats the column header", () => {
		// The cell used to render the sign abbreviation, which the header already
		// says, so it carried no information.
		for (const status of [
			{ kind: "queued" } as const,
			{ kind: "done" } as const,
			{ kind: "deriving", phase: "items", progress: null } as const,
		]) {
			expect(cellLabel(perm(status))).not.toContain("Wal");
		}
	});
});
