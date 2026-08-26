import { describe, expect, it } from "vitest";
import { ALL_FILE_NAMES } from "#core/permutations";
import { allowedFileCount, isAllowedFile } from "#server/download.server";

/**
 * The download route is traversal-proof BY CONSTRUCTION: the requested name is
 * looked up in a closed set generated from the core's permutation table and is
 * never used to build a path until found there. These tests pin that closed set.
 */
describe("the download allow-list", () => {
	it("is exactly the 162 data files plus the checksums", () => {
		expect(allowedFileCount()).toBe(163);
		for (const name of ALL_FILE_NAMES) expect(isAllowedFile(name)).toBe(true);
		expect(isAllowedFile("SHA256SUMS.txt")).toBe(true);
	});

	it("rejects every traversal shape", () => {
		for (const attack of [
			"../../../etc/passwd",
			"..%2f..%2f..%2fetc%2fpasswd",
			"%2e%2e%2f%2e%2e%2fetc%2fpasswd",
			"....//....//etc/passwd",
			"/etc/passwd",
			"/../etc/passwd",
			"C:\\Windows\\System32\\config\\sam",
			"..\\..\\windows\\win.ini",
			"TCRS_Turtle_Tamer_Wallaby.txt/../../../etc/passwd",
			"TCRS_Turtle_Tamer_Wallaby.txt\0.png",
			"TCRS_Turtle_Tamer_Wallaby.txt%00.png",
			".",
			"..",
			"",
			"manifest.json",
			"state.json",
			".lock",
			"tcrs-data.zip",
		]) {
			expect(isAllowedFile(attack), attack).toBe(false);
		}
	});

	it("rejects a plausible-but-nonexistent permutation", () => {
		// Only real class/sign combinations exist in the set.
		expect(isAllowedFile("TCRS_Seal_Clubber_Dragon.txt")).toBe(false);
		expect(isAllowedFile("TCRS_Necromancer_Vole.txt")).toBe(false);
	});

	it("is case-sensitive, so a case-varied probe cannot slip through", () => {
		expect(isAllowedFile("tcrs_turtle_tamer_wallaby.txt")).toBe(false);
		expect(isAllowedFile("TCRS_TURTLE_TAMER_WALLABY.TXT")).toBe(false);
	});

	it("contains no name that could escape a join()", () => {
		for (const name of ALL_FILE_NAMES) {
			expect(name).not.toContain("/");
			expect(name).not.toContain("\\");
			expect(name).not.toContain("..");
			expect(name).not.toContain("\0");
			expect(name.startsWith(".")).toBe(false);
		}
	});
});
