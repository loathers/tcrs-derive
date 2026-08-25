import { useEffect, useState } from "react";
import { summaryLine } from "#core/present";
import type { RunState } from "#core/state";
import { formatDuration } from "../lib/format.ts";

/**
 * The only aria-live region on the page. 54 live cells would be an accessibility
 * disaster, so the grid is silent and this one line announces progress.
 *
 * Elapsed time is computed only AFTER mount. Calling Date.now() during render
 * makes the server and the client disagree by a second, which React reports as a
 * hydration mismatch and cannot patch. The summary line itself is derived purely
 * from state, so it renders identically on both sides.
 */
export function RunSummary({ state }: { state: RunState }) {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

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
