import { describe, expect, it } from "vitest";
import {
	formatAbsolute,
	formatBytes,
	formatCountdown,
	formatDuration,
	formatRelative,
} from "../app/lib/format.ts";

/**
 * These functions render on BOTH the server and the client. Anything whose output
 * depends on the ambient locale or time zone is a hydration mismatch React cannot
 * patch, which has already bitten twice: once on the cooldown countdown and once
 * on the generated-at timestamp (Node rendered 25/08/2026, the browser 8/25/2026).
 */
describe("cross-environment determinism", () => {
	const ISO = "2026-08-25T15:06:40.787Z";

	it("formats the absolute time identically whatever the TZ and locale", () => {
		const original = { tz: process.env.TZ, lang: process.env.LANG };
		const seen = new Set<string>();
		try {
			for (const tz of [
				"UTC",
				"America/New_York",
				"Asia/Tokyo",
				"Pacific/Kiritimati",
			]) {
				for (const lang of ["en_US.UTF-8", "en_GB.UTF-8", "de_DE.UTF-8"]) {
					process.env.TZ = tz;
					process.env.LANG = lang;
					seen.add(formatAbsolute(ISO));
				}
			}
		} finally {
			if (original.tz === undefined) delete process.env.TZ;
			else process.env.TZ = original.tz;
			if (original.lang === undefined) delete process.env.LANG;
			else process.env.LANG = original.lang;
		}
		expect([...seen]).toEqual(["2026-08-25 15:06 UTC"]);
	});

	it("states its time zone, since an unlabelled date is ambiguous", () => {
		// 8/25 and 25/08 are the same instant written two ways.
		expect(formatAbsolute(ISO)).toContain("UTC");
		expect(formatAbsolute(ISO)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
	});

	it("handles an unparseable timestamp without throwing", () => {
		expect(formatAbsolute("not a date")).toBe("unknown");
		expect(formatRelative("not a date", Date.now())).toBe("unknown");
	});

	it("formats relative times from a pinned locale", () => {
		const now = Date.parse(ISO);
		expect(formatRelative(ISO, now + 3 * 3_600_000)).toBe("3 hours ago");
		expect(formatRelative(ISO, now + 45_000)).toBe("45 seconds ago");
		// 90s rounds to 1, not 2: JS rounds -1.5 towards zero.
		expect(formatRelative(ISO, now + 90_000)).toBe("1 minute ago");
		expect(formatRelative(ISO, now + 2 * 86_400_000)).toBe("2 days ago");
		expect(formatRelative(ISO, now)).toBe("now");
	});

	it("formats sizes, durations and countdowns without locale input", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(953_000)).toBe("931 KB");
		expect(formatDuration(462_000)).toBe("7m 42s");
		expect(formatCountdown(29_520_000)).toBe("8h 12m");
		expect(formatCountdown(0)).toBe("0s");
	});
});
