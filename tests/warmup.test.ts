import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type WarmUpOptions, warmUp } from "#core/warmup.server";
import { present } from "./helpers/present.ts";

const FAKE_JAVA = resolve("tests/fixtures/fake-java.mjs");

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "tcrs-warm-"));
	dirs.push(d);
	return d;
}
afterEach(async () => {
	while (dirs.length)
		await rm(present(dirs.pop()), { recursive: true, force: true });
});

function opts(over: Partial<WarmUpOptions> = {}): WarmUpOptions {
	return {
		jarPath: "/nonexistent/KoLmafia.jar", // fake-java ignores it
		javaBin: process.execPath,
		javaOpts: [FAKE_JAVA, "--fake-fixture=warmup"],
		templateDir: tmp(),
		timeoutMs: 10_000,
		...over,
	};
}

describe("the warm-up", () => {
	it("populates the template and reports success", async () => {
		const chunks: string[] = [];
		const ok = await warmUp(opts({ onLog: (c) => chunks.push(c) }));

		expect(ok).toBe(true);
		expect(chunks.join("")).toContain("Invalid login.");
	}, 30_000);

	/**
	 * REGRESSION: the abort listener went on AFTER the rm -rf and mkdir of the whole
	 * template tree, and after the spawn. addEventListener on an already-aborted
	 * signal never fires, so a cancel landing in that window left a warm-up JVM that
	 * nothing would kill until warmupTimeoutMs (300s in production).
	 */
	it("neither wipes the template nor spawns when already aborted", async () => {
		const templateDir = tmp();
		writeFileSync(join(templateDir, "marker"), "x");

		const controller = new AbortController();
		controller.abort();

		const chunks: string[] = [];
		const ok = await warmUp(
			opts({
				templateDir,
				signal: controller.signal,
				onLog: (c) => chunks.push(c),
			}),
		);

		expect(ok).toBe(false);
		// The previous template survives: a cancelled run must not destroy a usable
		// one on its way out.
		expect(existsSync(join(templateDir, "marker"))).toBe(true);
		// Nothing was spawned, so nothing logged.
		expect(chunks).toEqual([]);
	});
});
