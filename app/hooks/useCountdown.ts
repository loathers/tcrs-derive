/**
 * A once-a-second countdown to an ISO instant.
 *
 * SSR-SAFE BY CONSTRUCTION. The first render, on the server AND during client
 * hydration, returns `serverRemainingMs` verbatim, so both trees agree. Only after
 * mount does it start computing from the wall clock.
 *
 * Doing it the obvious way (compute from Date.now() during render) produced a real
 * hydration mismatch: the server rendered the button enabled with "Generate now"
 * and the client wanted it disabled with "Available in 59m 37s". React does not
 * patch mismatched attributes, so the button was left in the wrong state.
 *
 * Once ticking, it corrects for clock skew using the server's own `now`, so a
 * mis-set laptop clock does not show a wrong "available in" time.
 */
import { useEffect, useState } from "react";

export function useCountdown(
  targetIso: string | null,
  serverNowIso: string,
  serverRemainingMs: number,
): number {
  // Identical on server and on first client render, this is what makes hydration
  // match. `mounted` stays false until the effect runs.
  const [remaining, setRemaining] = useState(serverRemainingMs);

  useEffect(() => {
    if (targetIso === null) {
      setRemaining(0);
      return;
    }
    const skew = Date.parse(serverNowIso) - Date.now();
    const tick = () => {
      const target = Date.parse(targetIso);
      setRemaining(
        Number.isFinite(target) ? Math.max(0, target - (Date.now() + skew)) : 0,
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [targetIso, serverNowIso]);

  return remaining;
}
