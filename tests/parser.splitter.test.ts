import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyLine, DeriveTracker, LineSplitter } from "#core/parser";

const HAPPY = readFileSync("tests/fixtures/logs/happy.log", "utf8");

/** Deterministic PRNG (mulberry32) so a failure is reproducible from the seed. */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function feed(text: string, chunks: number[]): string[] {
	const splitter = new LineSplitter();
	const out: string[] = [];
	let i = 0;
	for (const n of chunks) {
		if (i >= text.length) break;
		out.push(...splitter.push(text.slice(i, i + n)));
		i += n;
	}
	if (i < text.length) out.push(...splitter.push(text.slice(i)));
	out.push(...splitter.flush());
	return out;
}

describe("LineSplitter is invariant to chunk boundaries", () => {
	const whole = feed(HAPPY, [HAPPY.length]);

	it("produces the same lines regardless of how the stream is sliced", () => {
		// The real risk: a `Progress: 12001/12070` line split across two socket reads.
		for (const seed of [1, 2, 3, 42, 1337, 99991]) {
			const next = rng(seed);
			const sizes = Array.from(
				{ length: 4000 },
				() => 1 + Math.floor(next() * 4096),
			);
			expect(feed(HAPPY, sizes), `seed ${seed}`).toEqual(whole);
		}
	});

	it("survives being fed one byte at a time", () => {
		expect(
			feed(
				HAPPY,
				Array.from({ length: HAPPY.length }, () => 1),
			),
		).toEqual(whole);
	});

	it("yields an identical event sequence however it is chunked", () => {
		const kindsFor = (lines: string[]) =>
			lines.map((l) => classifyLine(l)).filter((p) => p.kind !== "other");

		const expected = kindsFor(whole);
		const next = rng(7);
		const sizes = Array.from(
			{ length: 4000 },
			() => 1 + Math.floor(next() * 512),
		);
		expect(kindsFor(feed(HAPPY, sizes))).toEqual(expected);
		// Sanity: the fixture really does carry the events we think it does.
		expect(expected.filter((p) => p.kind === "progress")).toHaveLength(121);
		expect(expected.filter((p) => p.kind === "phase")).toHaveLength(3);
		expect(expected.filter((p) => p.kind === "wrote")).toHaveLength(3);
	});
});

describe("LineSplitter hygiene", () => {
	it("returns the unterminated tail only on flush", () => {
		const s = new LineSplitter();
		// mafia writes `username: password: ` with no trailing newline.
		expect(s.push("username: password: ")).toEqual([]);
		expect(s.flush()).toEqual(["username: password: "]);
		expect(s.flush()).toEqual([]);
	});

	it("strips NUL bytes, which corrupt any downstream rendering", () => {
		const s = new LineSplitter();
		expect(s.push("Prog\u0000ress: 1/2\u0000\n")).toEqual(["Progress: 1/2"]);
	});

	it("strips ANSI escapes and carriage returns", () => {
		const s = new LineSplitter();
		expect(s.push("\u001b[2KProgress: 1/2\r\n")).toEqual(["Progress: 1/2"]);
	});

	it("keeps blank lines, which the real logs contain", () => {
		const s = new LineSplitter();
		expect(s.push("a\n\nb\n")).toEqual(["a", "", "b"]);
	});
});

describe("the TCRS output path", () => {
	it("parses both the flat and the TCRS/ subdirectory forms", () => {
		// r29183 moved the output into a TCRS/ subdirectory. The old anchored pattern
		// silently stopped matching, so perm:wrote never fired AND collect() looked in
		// the wrong place, a run where all three phases succeeded collected 0 files.
		expect(classifyLine("Wrote file TCRS_Sauceror_Vole.txt")).toEqual({
			kind: "wrote",
			file: "TCRS_Sauceror_Vole.txt",
			dir: null,
		});
		expect(classifyLine("Wrote file TCRS/TCRS_Sauceror_Vole.txt")).toEqual({
			kind: "wrote",
			file: "TCRS_Sauceror_Vole.txt",
			dir: "TCRS",
		});
		expect(
			classifyLine("Wrote file TCRS/TCRS_Sauceror_Vole_cafe_food.txt"),
		).toEqual({
			kind: "wrote",
			file: "TCRS_Sauceror_Vole_cafe_food.txt",
			dir: "TCRS",
		});
	});

	it("records the basename in filesWritten regardless of layout", () => {
		const t = new DeriveTracker();
		t.accept("Wrote file TCRS/TCRS_Sauceror_Vole.txt");
		t.accept("Wrote file TCRS_Sauceror_Vole_cafe_booze.txt");
		expect(t.wrote).toEqual([
			"TCRS_Sauceror_Vole.txt",
			"TCRS_Sauceror_Vole_cafe_booze.txt",
		]);
	});
});

describe("classifyLine edge cases", () => {
	it("rejects a zero total rather than dividing by zero", () => {
		expect(classifyLine("Progress: 0/0").kind).toBe("other");
	});

	it("prefers the phase header over the transient sweep", () => {
		const p = classifyLine(
			"Deriving TCRS item adjustments for all cafe booze items...",
		);
		expect(p).toEqual({ kind: "phase", phase: "cafe_booze" });
	});

	it("reads mafia's build banner in both observed forms", () => {
		// Official release assets print a bare revision. The locally-built jar the
		// fixtures were captured from printed a `-M` suffix for the same revision.
		// Both must parse, or the manifest silently loses the build it ran against.
		expect(classifyLine("KoLmafia r29131")).toEqual({
			kind: "build",
			build: "r29131",
		});
		expect(classifyLine("KoLmafia r29131-M")).toEqual({
			kind: "build",
			build: "r29131-M",
		});
		expect(classifyLine("KoLmafia r29183")).toEqual({
			kind: "build",
			build: "r29183",
		});
	});

	it("records the build from a real log", () => {
		const t = new DeriveTracker();
		for (const l of HAPPY.split("\n")) t.accept(l);
		expect(t.build).toBe("r29131-M");
	});
});
