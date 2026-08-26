/**
 * The current time, corrected for the difference between this browser's clock and
 * the server's, and null until mount.
 *
 * Two problems, one hook.
 *
 * Skew. Every duration on this page is the gap between a server-issued instant and
 * "now". A laptop clock that is five minutes fast turns "generated 2 minutes ago"
 * into "generated 7 minutes ago" and shortens a 12h cooldown by five minutes.
 * Anchoring to the server's own `now`, captured at the same moment as those
 * instants, cancels the offset out.
 *
 * Hydration. Reading the wall clock during render makes the server and client
 * disagree, and React does not patch mismatched ATTRIBUTES, so a disabled button
 * or a title stays stuck at the server's value. Returning null until the effect
 * runs lets each caller render the server's own answer first and start ticking
 * afterwards, which is a value both sides agree on by construction.
 *
 * Callers pass the interval they need. A countdown reads seconds so it ticks at
 * 1000. A "6 hours ago" changes far too slowly to justify that, so it ticks at
 * 30000.
 */
import { useEffect, useState } from "react";

export function useServerClock(
  serverNowIso: string,
  intervalMs: number,
): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Sampled once, on mount, rather than per tick: the two clocks drift apart far
    // too slowly to matter over one page view, and re-measuring would make every
    // tick depend on how long the render took.
    const serverNow = Date.parse(serverNowIso);
    const skew = Number.isFinite(serverNow) ? serverNow - Date.now() : 0;
    const tick = () => setNow(Date.now() + skew);
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [serverNowIso, intervalMs]);

  return now;
}
