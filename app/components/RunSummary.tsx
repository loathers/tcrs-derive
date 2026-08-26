import { summaryLine } from "#core/present";
import type { RunState } from "#core/state";
import { useServerClock } from "../hooks/useServerClock.ts";
import { formatDuration } from "../lib/format.ts";
import { useServerNowIso } from "../lib/server-now.ts";

/**
 * The only aria-live region on the page. 54 live cells would be an accessibility
 * disaster, so the grid is silent and this one line announces progress.
 *
 * Elapsed is null until useServerClock mounts. Reading the wall clock during
 * render makes the server and the client disagree by a second, and the clock is
 * anchored to the server so a skewed browser cannot report a run as having taken
 * longer than it did. The summary line itself is derived purely from state, so it
 * renders identically on both sides.
 */
export function RunSummary({ state }: { state: RunState }) {
	const nowMs = useServerClock(useServerNowIso(), 1000);

	const s = state.summary;
	const elapsed =
		nowMs === null || state.startedAt === null ? null : nowMs - state.startedAt;
	// ETA from observed throughput. Meaningless until something has finished.
	const eta =
		elapsed !== null && s.done > 0 && s.done < s.total
			? (elapsed / s.done) * (s.total - s.done)
			: null;

	return (
		<p aria-live="polite">
			<strong>{summaryLine(s)}</strong>
			{elapsed !== null && <>, {formatDuration(elapsed)} elapsed</>}
			{eta !== null && <>, ~{formatDuration(eta)} left</>}
		</p>
	);
}
