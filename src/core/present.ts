/**
 * The shared presenter, PURE, and used by BOTH the ink CLI and the React web UI.
 *
 * This file is what makes "two views, one core" real, and it is the answer to the
 * ink-web question: rather than depending on an unmaintained shim to render ink
 * components into a browser canvas, both views render from the same computed
 * `RowView`. ink turns it into <Text>; the web turns it into styled DOM.
 *
 * The exact byte layout of every format below is frozen by
 * tests/present.snapshot.test.ts, so a change to what the operator sees has to be
 * a deliberate one rather than a side effect.
 */

import type { PermState, RunSummary } from "./state.ts";

export const BAR_WIDTH = 10;

export const FILL_ACTIVE = "█"; // full block
export const FILL_FAILED = "▓"; // dark shade
export const FILL_EMPTY = "░"; // light shade

export type Tone = "idle" | "active" | "ok" | "fail" | "warn";

export interface RowView {
	readonly user: string;
	/** 0-100. Caps near 99 for the items phase, see percentFor(). */
	readonly pct: number;
	readonly fill: string;
	readonly bar: string;
	readonly status: string;
	readonly tone: Tone;
}

/**
 * Floor-divide the percentage into BAR_WIDTH cells, clamp, then pad with the empty
 * glyph.
 */
export function makeBar(pct: number, fill: string, width = BAR_WIDTH): string {
	const filled = Math.min(width, Math.max(0, Math.floor((pct * width) / 100)));
	return fill.repeat(filled) + FILL_EMPTY.repeat(width - filled);
}

/**
 * The percentage for a progress pair.
 *
 * Deliberately NOT clamped up to 100. mafia announces every 100 items and 12070
 * isn't a multiple of 100, so the last line is always Progress: 12001/12070 and
 * this tops out at 99. A bar that reaches 100% and then sits there through both
 * cafe phases is a worse lie than 99%.
 */
export function percentFor(progress: { done: number; total: number }): number {
	if (progress.total <= 0) return 0;
	return Math.floor((progress.done * 100) / progress.total);
}

/**
 * How far along a permutation is, 0-100, as BOTH the bar and the label must show
 * it. One derivation: the cell renders a gradient from this and a percentage
 * label beside it, and when the two were derived separately the bar filled to
 * 100% while the text read 99%.
 */
export function progressPercent(p: PermState): number {
	const s = p.status;
	switch (s.kind) {
		case "done":
		case "failed":
		case "skipped":
			return 100;
		case "queued":
		case "login":
		case "stalled":
		case "retrying":
			return 0;
		case "deriving":
			// The cafe phases report nothing and are the last sliver of the work, so
			// they sit at the same near-complete number the items phase caps at.
			if (s.phase !== "items") return CAFE_PERCENT;
			return s.progress === null ? 0 : percentFor(s.progress);
	}
}

/** Where the cafe phases park. The items phase caps at 99 for the same reason:
 *  mafia announces every 100 items and the total is not a multiple of 100. */
const CAFE_PERCENT = 99;

/** ` try 2/3`, or "" on the first attempt. */
function trySuffix(p: PermState): string {
	return p.attempt > 1 ? ` try ${p.attempt}/${p.maxAttempts}` : "";
}

const PHASE_LABEL = {
	items: "items",
	cafe_booze: "cafe booze",
	cafe_food: "cafe food",
} as const;

/**
 * Compute one chart row.
 *
 * THE CAFE-PHASE RULE LIVES HERE, EXACTLY ONCE: the cafe phases report no
 * progress, so they render a full bar labelled with the phase rather than a
 * percentage. Belt and braces, the reducer also keeps `progress: null` for those
 * phases (see state.ts), so a stale items percentage is unrepresentable rather
 * than merely avoided.
 */
export function rowView(p: PermState): RowView {
	const t = trySuffix(p);
	const s = p.status;

	switch (s.kind) {
		case "done":
			return row(p, 100, FILL_ACTIVE, "done", "ok");

		case "failed":
			return row(p, 100, FILL_FAILED, `FAIL ${s.copied}/3`, "fail");

		case "queued":
			return row(p, 0, FILL_EMPTY, "queued", "idle");

		case "skipped":
			return row(p, 100, FILL_EMPTY, "skipped", "idle");

		case "deriving": {
			if (s.phase !== "items") {
				// A full bar labelled with the phase: mafia emits no Progress: lines for
				// the cafe phases, so there is no percentage to show. The web cell shows a
				// number instead via progressPercent(), hence the separate derivation.
				return row(
					p,
					100,
					FILL_ACTIVE,
					`${PHASE_LABEL[s.phase]}${t}`,
					"active",
				);
			}
			// The items phase is the bulk and its percentage is meaningful. Before the
			// first Progress: line it is legitimately 0, so the bar starts empty rather
			// than full.
			const pct = s.progress === null ? 0 : percentFor(s.progress);
			return row(
				p,
				pct,
				FILL_ACTIVE,
				`${String(pct).padStart(3)}% ${PHASE_LABEL[s.phase]}${t}`,
				"active",
			);
		}

		case "retrying":
			return row(
				p,
				0,
				FILL_ACTIVE,
				`retrying ${s.nextAttempt}/${p.maxAttempts}`,
				"warn",
			);

		case "stalled":
			return row(p, 0, FILL_ACTIVE, `stalled${t}`, "warn");

		case "login":
			return row(p, 0, FILL_ACTIVE, `login${t}`, "active");
	}
}

function row(
	p: PermState,
	pct: number,
	fill: string,
	status: string,
	tone: Tone,
): RowView {
	return { user: p.user, pct, fill, bar: makeBar(pct, fill), status, tone };
}

/**
 * A compact label for one cell of the web grid.
 *
 * A percentage where one is meaningful, a short word where it is not. The cell
 * used to show the sign abbreviation, which the column header already says, so it
 * carried no information. Colour already conveys the state, so the number is the
 * part that was missing. Full detail stays in the cell's title/aria-label.
 */
export function cellLabel(p: PermState): string {
	const s = p.status;
	switch (s.kind) {
		case "queued":
			return "";
		case "skipped":
			return "skip";
		case "done":
			return "100%";
		case "failed":
			return "fail";
		case "retrying":
			return "retry";
		case "stalled":
			return "stall";
		case "login":
			return "0%";
		case "deriving":
			return `${progressPercent(p)}%`;
	}
}

/**
 * `<user> [bar] status`. The longest username is 11 chars, so padEnd(12) always
 * pads and the bars always line up.
 */
export function formatRow(v: RowView): string {
	return `${v.user.padEnd(12)} [${v.bar}] ${v.status}`;
}

/**
 * Note the TWO spaces before the parenthesis. They are deliberate and the snapshot
 * test pins them, so a tidy-up here fails the suite rather than silently reflowing
 * every operator's chart.
 */
export function summaryLine(s: RunSummary): string {
	const skipped = s.skipped > 0 ? `, ${s.skipped} skipped` : "";
	return `Overall: ${s.done}/${s.total} done  (${s.running} running, ${s.failed} failed, ${s.queued} queued${skipped})`;
}
