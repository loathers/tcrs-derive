import { useServerClock } from "../hooks/useServerClock.ts";
import { formatAbsolute, formatRelative } from "../lib/format.ts";
import { useServerNowIso } from "../lib/server-now.ts";

/**
 * "6 hours ago", with the absolute UTC time on hover.
 *
 * Both sides render this against the SERVER's now until the clock mounts, so the
 * two trees agree without suppressHydrationWarning. It used to need that escape
 * hatch because it read Date.now() during render, which meant the text could
 * legitimately differ by a tick between server and client.
 */
export function RelativeTime({ iso }: { iso: string }) {
	const serverNowIso = useServerNowIso();
	const ticking = useServerClock(serverNowIso, 30_000);
	const now = ticking ?? Date.parse(serverNowIso);
	return (
		<time dateTime={iso} title={formatAbsolute(iso)}>
			{formatRelative(iso, now)}
		</time>
	);
}
