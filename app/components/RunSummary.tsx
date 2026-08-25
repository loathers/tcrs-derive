import { summaryLine } from "#core/present";
import type { RunState } from "#core/state";
import { formatDuration } from "../lib/format.ts";

/**
 * The only aria-live region on the page. 54 live cells would be an accessibility
 * disaster, so the grid is silent and this one line announces progress.
 */
export function RunSummary({ state }: { state: RunState }) {
  const s = state.summary;
  const elapsed =
    state.startedAt === null ? null : Date.now() - state.startedAt;
  // ETA from observed throughput; meaningless until something has finished.
  const eta =
    elapsed !== null && s.done > 0 && s.done < s.total
      ? (elapsed / s.done) * (s.total - s.done)
      : null;

  return (
    <p className="run-summary" aria-live="polite">
      <strong>{summaryLine(s)}</strong>
      {elapsed !== null && <> &middot; {formatDuration(elapsed)} elapsed</>}
      {eta !== null && <> &middot; ~{formatDuration(eta)} remaining</>}
    </p>
  );
}
