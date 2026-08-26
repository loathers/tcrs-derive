/** Presentation helpers for the web UI. */

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * `7m 42s`, `8h 12m`, `45s`.
 *
 * `round` picks the rounding for the seconds: elapsed time reads naturally to the
 * nearest second, a countdown to the next one up, so "available in 1s" does not
 * flick to 0s while there is still time left. One function so the two cannot
 * drift into different shapes while rendered next to each other.
 */
export function formatDuration(
	ms: number,
	round: (n: number) => number = Math.round,
): string {
	const total = Math.max(0, round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	if (h > 0) return `${h}h ${pad(m)}m`;
	if (m > 0) return `${m}m ${pad(s)}s`;
	return `${s}s`;
}

/** A duration that should never round down past its own deadline. */
export function formatCountdown(ms: number): string {
	return formatDuration(ms, Math.ceil);
}

export function formatRelative(iso: string, nowMs: number): string {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return "unknown";
	const deltaSec = Math.round((then - nowMs) / 1000);
	// Locale pinned: Node and the browser otherwise disagree, and this renders on
	// both sides.
	const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
	const table: [Intl.RelativeTimeFormatUnit, number][] = [
		["second", 60],
		["minute", 60],
		["hour", 24],
		["day", 30],
		["month", 12],
	];
	let value = deltaSec;
	for (const [unit, span] of table) {
		if (Math.abs(value) < span) return rtf.format(value, unit);
		value = Math.round(value / span);
	}
	return rtf.format(value, "year");
}

/**
 * A fixed UTC timestamp, deliberately NOT localised.
 *
 * toLocaleString() renders differently on the server and in the browser (Node's
 * locale versus the visitor's), which is a hydration mismatch React cannot patch.
 * It is also ambiguous: 8/25 and 25/08 are the same instant written two ways. A
 * single unambiguous UTC rendering avoids both problems, and the relative time
 * next to it already covers "how long ago".
 */
export function formatAbsolute(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "unknown";
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
		`${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
	);
}
