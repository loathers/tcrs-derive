/**
 * Milliseconds remaining until an ISO instant, ticking once a second.
 *
 * Before mount this is `serverRemainingMs` verbatim, so the server and client
 * render the same button. Doing it the obvious way, computing from Date.now()
 * during render, produced a real mismatch: the server rendered the button enabled
 * saying "Generate" and the client wanted it disabled saying "Available in
 * 59m 37s", and React left the wrong one in place.
 */
import { useServerClock } from "./useServerClock.ts";

export function useCountdown(
  targetIso: string | null,
  serverNowIso: string,
  serverRemainingMs: number,
): number {
  const now = useServerClock(serverNowIso, 1000);
  if (targetIso === null) return 0;
  if (now === null) return serverRemainingMs;
  const target = Date.parse(targetIso);
  return Number.isFinite(target) ? Math.max(0, target - now) : 0;
}
