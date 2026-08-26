import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Locks the browser-safe boundary.
 *
 * React Router's Vite plugin strips `*.server.ts` from the client bundle, which
 * enforces this for the web app. This test additionally covers the ink CLI and the
 * tests themselves, which the plugin never sees, and it fails at test time with a
 * clear message rather than at build time with a bundler error.
 */
const PURE_FILES = [
	"permutations.ts",
	"events.ts",
	"parser.ts",
	"state.ts",
	"present.ts",
	"bus.ts",
];

const FORBIDDEN = [
	/from\s+["']node:/,
	/require\(\s*["']node:/,
	/from\s+["'](?:fs|path|child_process|os|crypto|http|https|net|stream|worker_threads)["']/,
	/\bprocess\.(?:env|cwd|exit|platform)\b/,
];

describe("core purity", () => {
	it.each(PURE_FILES)("%s imports nothing node-only", (file) => {
		const src = readFileSync(`src/core/${file}`, "utf8");
		// Strip comments so the prose above (which mentions node: and process.env)
		// doesn't trip the scan.
		const code = src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		for (const pattern of FORBIDDEN) {
			expect(code, `${file} must not match ${pattern}`).not.toMatch(pattern);
		}
	});

	it("keeps every non-.server.ts file in src/core pure", () => {
		// Catches a new pure file being added without being listed above.
		const actual = readdirSync("src/core")
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".server.ts"))
			.sort();
		expect(actual).toEqual([...PURE_FILES].sort());
	});

	it("has no Date.now or Math.random in the reducer or presenter", () => {
		// The reducer takes all time from event.at. That is what makes
		// reduceAll(initial, capturedEvents) a pure, snapshot-testable function.
		for (const file of ["state.ts", "present.ts"]) {
			const code = readFileSync(`src/core/${file}`, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "");
			expect(code, `${file} must not call Date.now()`).not.toMatch(
				/Date\.now\(/,
			);
			expect(code, `${file} must not call Math.random()`).not.toMatch(
				/Math\.random\(/,
			);
		}
	});
});

/**
 * The web app has exactly one wall clock.
 *
 * Four separate hydration mismatches on this page came from the same mistake:
 * reading the browser's clock while rendering, so the server and the client
 * disagreed. React silently declines to patch mismatched attributes, so a button
 * stayed disabled and a title stayed wrong. useServerClock is the single sanctioned
 * reader, it returns null until mount, and it corrects for skew. Anything else
 * calling Date.now() in a component has almost certainly reintroduced the bug.
 */
describe("web app time", () => {
	const CLOCK = "app/hooks/useServerClock.ts";

	it("reads the clock only inside useServerClock", () => {
		const offenders = walk("app")
			.filter((f) => f !== CLOCK)
			.filter((f) =>
				stripComments(readFileSync(f, "utf8")).includes("Date.now("),
			);
		expect(offenders).toEqual([]);
	});
});

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = `${dir}/${e.name}`;
		if (e.isDirectory()) return walk(path);
		return /\.tsx?$/.test(e.name) ? [path] : [];
	});
}
