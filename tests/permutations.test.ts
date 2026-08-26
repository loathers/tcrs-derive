import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ALL_FILE_NAMES,
	ALL_PERMUTATIONS,
	CLASS_ORDER,
	passwordVarFor,
	permutationByUser,
	permutationForFile,
	SIGNS,
	selectPermutations,
	tcrsFiles,
} from "#core/permutations";
import { present } from "./helpers/present.ts";

describe("the permutation table", () => {
	it("is 54 permutations: 6 classes x 9 signs", () => {
		expect(ALL_PERMUTATIONS).toHaveLength(54);
		expect(new Set(ALL_PERMUTATIONS.map((p) => p.user)).size).toBe(54);
	});

	it("is ordered CLASS_ORDER x SIGNS, not alphabetically", () => {
		// Load-bearing: this is the chart's row order and the web grid's cell order.
		expect(ALL_PERMUTATIONS.slice(0, 3).map((p) => p.user)).toEqual([
			"sc_mongoose",
			"sc_wallaby",
			"sc_vole",
		]);
		expect(present(ALL_PERMUTATIONS.at(-1)).user).toBe("at_packrat");

		const alphabetical = [...ALL_PERMUTATIONS.map((p) => p.user)].sort();
		expect(ALL_PERMUTATIONS.map((p) => p.user)).not.toEqual(alphabetical);
	});

	it("derives password env vars in the .env.example casing", () => {
		expect(passwordVarFor(present(permutationByUser("tt_wallaby")))).toBe(
			"PASSWORD_TT_WALLABY",
		);
		// Every var must match what .env.example declares.
		const declared = new Set(
			readFileSync(".env.example", "utf8")
				.split("\n")
				.filter((l) => l.startsWith("PASSWORD_"))
				.map((l) => present(l.split("=")[0])),
		);
		expect(declared.size).toBe(54);
		for (const p of ALL_PERMUTATIONS) {
			expect(declared).toContain(passwordVarFor(p));
		}
	});
});

describe("the browser-safe boundary", () => {
	it("keeps password variable names off the Permutation object", () => {
		// Permutation is imported by the client bundle (the progress grid needs the
		// class/sign tables), so it must not carry anything password-shaped. This also
		// keeps a `grep PASSWORD_ build/client` leak-scan meaningful.
		const p = present(permutationByUser("tt_wallaby"));
		expect(JSON.stringify(p)).not.toContain("PASSWORD");
	});
});

describe("the filename scheme", () => {
	it("matches the 162 filenames a real run produced", () => {
		// Ground truth: `ls out/` from the last successful batch, committed as a fixture.
		const real = readFileSync("tests/fixtures/expected-files.txt", "utf8")
			.split("\n")
			.filter(Boolean)
			.sort();
		expect([...ALL_FILE_NAMES].sort()).toEqual(real);
		expect(ALL_FILE_NAMES).toHaveLength(162);
	});

	it("emits the three suffixes in order", () => {
		expect(tcrsFiles("Turtle_Tamer", "Wallaby")).toEqual([
			"TCRS_Turtle_Tamer_Wallaby.txt",
			"TCRS_Turtle_Tamer_Wallaby_cafe_booze.txt",
			"TCRS_Turtle_Tamer_Wallaby_cafe_food.txt",
		]);
	});

	it("round-trips a filename back to its permutation and kind", () => {
		const hit = permutationForFile("TCRS_Sauceror_Vole_cafe_booze.txt");
		expect(hit?.permutation.user).toBe("sa_vole");
		expect(hit?.kind).toBe("cafe_booze");
	});

	it("rejects anything outside the closed set of 162", () => {
		// This is what makes the download route traversal-proof by construction.
		for (const bad of [
			"../../../etc/passwd",
			"TCRS_Turtle_Tamer_Wallaby.txt/../../evil",
			"TCRS_Not_A_Class_Wallaby.txt",
			"",
			"TCRS_Turtle_Tamer_Wallaby.txt\0.png",
		]) {
			expect(permutationForFile(bad)).toBeUndefined();
		}
	});

	it("contains no path separators or traversal sequences", () => {
		for (const name of ALL_FILE_NAMES) {
			expect(name).toMatch(/^TCRS_[A-Za-z_]+\.txt$/);
			expect(name).not.toContain("/");
			expect(name).not.toContain("\\");
			expect(name).not.toContain("..");
		}
	});
});

describe("selectPermutations", () => {
	it("returns all 54 by default", () => {
		expect(selectPermutations().selected).toHaveLength(54);
	});

	it("honours only as an allow-list", () => {
		const { selected } = selectPermutations({
			only: ["tt_wallaby", "sc_vole"],
		});
		expect(selected.map((p) => p.user)).toEqual(["sc_vole", "tt_wallaby"]);
	});

	it("applies exclude before only, matching bash want_user order", () => {
		const { selected } = selectPermutations({
			only: ["tt_wallaby", "sc_vole"],
			exclude: ["sc_vole"],
		});
		expect(selected.map((p) => p.user)).toEqual(["tt_wallaby"]);
	});

	it("reports unknown names instead of silently running nothing", () => {
		// The bash ran zero permutations and printed "Nothing to do" for a typo.
		const { selected, unknown } = selectPermutations({ only: ["tt_walaby"] });
		expect(unknown).toEqual(["tt_walaby"]);
		expect(selected).toHaveLength(0);
	});

	it("treats empty filter strings as absent", () => {
		// ONLY="" / EXCLUDE="" is how the bash spelled "unset".
		expect(
			selectPermutations({ only: [""], exclude: [""] }).selected,
		).toHaveLength(54);
	});
});

describe("class and sign tables", () => {
	it("covers the six classes and nine signs", () => {
		expect(CLASS_ORDER).toHaveLength(6);
		expect(SIGNS).toHaveLength(9);
	});
});
