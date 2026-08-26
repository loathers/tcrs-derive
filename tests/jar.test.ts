import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	detectTcrsCommand,
	ensureJar,
	JarUnavailableError,
	readJarTag,
	resolveJar,
	updateJar,
} from "#core/jar.server";
import { present } from "./helpers/present.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "tcrs-jar-"));
	dirs.push(d);
	return d;
}
afterEach(async () => {
	while (dirs.length)
		await rm(present(dirs.pop()), { recursive: true, force: true });
});

/**
 * REGRESSION: the jar path must always come back ABSOLUTE.
 *
 * Every JVM is spawned with cwd set to its own private work dir. A relative
 * `-jar KoLmafia.jar` is therefore resolved against THAT directory, so all 54
 * permutations died instantly with "unable to open file KoLmafia.jar", a run that
 * failed in under a second and looked like a KoL problem.
 *
 * The original tests all passed absolute paths, which is exactly why they missed it.
 */
describe("jar resolution is always absolute", () => {
	it("resolves a relative explicit path against the search dir", () => {
		const dir = tmp();
		writeFileSync(join(dir, "KoLmafia.jar"), "x");
		return expect(
			resolveJar({ explicit: "KoLmafia.jar", searchDir: dir }),
		).resolves.toBe(join(dir, "KoLmafia.jar"));
	});

	it("returns an absolute path when discovering a jar by glob", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "KoLmafia-29131.jar"), "x");
		const found = await resolveJar({ searchDir: dir });
		expect(found).not.toBeNull();
		expect(isAbsolute(present(found))).toBe(true);
	});

	it("keeps an already-absolute path unchanged", async () => {
		const dir = tmp();
		const p = join(dir, "KoLmafia.jar");
		writeFileSync(p, "x");
		expect(
			await resolveJar({ explicit: p, searchDir: "/somewhere/else" }),
		).toBe(p);
	});

	it("ensureJar returns an absolute path for a relative input", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "KoLmafia.jar"), "x");
		const p = await ensureJar({
			configured: "KoLmafia.jar",
			searchDir: dir,
			allowDownload: false,
		});
		expect(isAbsolute(p)).toBe(true);
		expect(p).toBe(join(dir, "KoLmafia.jar"));
	});

	it("rejects a zero-byte jar rather than handing it to the JVM", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "KoLmafia.jar"), "");
		expect(
			await resolveJar({ explicit: "KoLmafia.jar", searchDir: dir }),
		).toBeNull();
	});

	it("throws a typed error when no jar exists and downloading is off", async () => {
		await expect(
			ensureJar({
				configured: "KoLmafia.jar",
				searchDir: tmp(),
				allowDownload: false,
			}),
		).rejects.toThrow(JarUnavailableError);
	});
});

/**
 * The per-run version check. Releases only land between runs, so a run is the
 * natural moment to look, but the check must never be able to cost us a run.
 */
describe("checking for a newer KoLmafia", () => {
	/** Route the release API and the asset download to canned responses. */
	function stubGitHub(tag: string, body = "jar bytes") {
		const calls = { api: 0, download: 0 };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.includes("api.github.com")) {
					calls.api++;
					return new Response(
						JSON.stringify({
							tag_name: tag,
							assets: [
								{
									name: `KoLmafia-${tag.replace(/^r/, "")}.jar`,
									browser_download_url: `https://example.invalid/${tag}.jar`,
								},
							],
						}),
						{ status: 200 },
					);
				}
				calls.download++;
				return new Response(body, { status: 200 });
			}),
		);
		return calls;
	}
	afterEach(() => vi.unstubAllGlobals());

	it("fetches a release newer than the one in use", async () => {
		const dir = tmp();
		const current = join(dir, "KoLmafia.jar");
		writeFileSync(current, "old");
		writeFileSync(`${current}.tag`, "r29131");
		const calls = stubGitHub("r29183");

		const update = await updateJar({ current, dir: join(dir, "mafia") });

		expect(present(update).tag).toBe("r29183");
		expect(present(update).downloaded).toBe(true);
		expect(calls.download).toBe(1);
		// The sidecar travels with the jar, so the next run knows what this one is.
		expect(await readJarTag(present(update).path)).toBe("r29183");
	});

	it("does nothing when the latest release is already in use", async () => {
		const dir = tmp();
		const current = join(dir, "KoLmafia.jar");
		writeFileSync(current, "x");
		writeFileSync(`${current}.tag`, "r29183");
		const calls = stubGitHub("r29183");

		expect(await updateJar({ current, dir: join(dir, "mafia") })).toBeNull();
		expect(calls.download).toBe(0);
	});

	it("refuses to move off a pinned tag", async () => {
		// MAFIA_TAG is how an operator says "this build, deliberately". Upgrading
		// past it would make the pin mean nothing.
		const dir = tmp();
		const current = join(dir, "KoLmafia.jar");
		writeFileSync(current, "x");
		writeFileSync(`${current}.tag`, "r29131");
		const calls = stubGitHub("r29183");

		const update = await updateJar({
			current,
			dir: join(dir, "mafia"),
			pinnedTag: "r29131",
		});

		expect(update).toBeNull();
		expect(calls.api).toBe(0);
	});

	it("reuses a release already on disk instead of downloading it again", async () => {
		const dir = tmp();
		const mafia = join(dir, "mafia");
		mkdirSync(mafia, { recursive: true });
		writeFileSync(join(mafia, "KoLmafia-29183.jar"), "already here");
		const current = join(dir, "KoLmafia.jar");
		writeFileSync(current, "old");
		const calls = stubGitHub("r29183");

		const update = await updateJar({ current, dir: mafia });

		expect(present(update).downloaded).toBe(false);
		expect(calls.download).toBe(0);
	});

	it("throws rather than returning null when the check fails", async () => {
		// The caller has to be able to tell "nothing to do" from "could not look",
		// because only one of those is worth warning about.
		const dir = tmp();
		const current = join(dir, "KoLmafia.jar");
		writeFileSync(current, "x");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 503 })),
		);

		await expect(
			updateJar({ current, dir: join(dir, "mafia") }),
		).rejects.toThrow();
	});
});

/**
 * Which command performs the full run is a property of the jar, not a setting.
 *
 * r29189 and earlier: `tcrs derive` runs all three phases. Later builds rename that
 * to `tcrs introspect` and give `derive` a narrower job, introspecting only items
 * missing from items.txt. Sending the wrong one either fails outright or quietly
 * produces a different dataset, and since runs now fetch their own jars, nobody is
 * around to choose.
 *
 * A jar is a zip and zip stores entry NAMES uncompressed, so the inner class name is
 * readable without unzipping anything. These fixtures stand in for that byte.
 */
describe("detecting the jar's tcrs command", () => {
	function fakeJar(marker: string): string {
		const path = join(tmp(), "KoLmafia.jar");
		writeFileSync(path, `PK\u0003\u0004...net/...${marker}.class...junk`);
		return path;
	}

	it("picks introspect when the jar has the introspect runnable", async () => {
		expect(await detectTcrsCommand(fakeJar("TCRSIntrospectRunnable"))).toEqual({
			command: "introspect",
			recognised: true,
		});
	});

	it("picks derive when the jar has the derive runnable", async () => {
		expect(await detectTcrsCommand(fakeJar("TCRSDeriveRunnable"))).toEqual({
			command: "derive",
			recognised: true,
		});
	});

	it("falls back to derive, and says so, when neither marker is there", async () => {
		// A future reorganisation lands here. derive is the one every released jar
		// has had, and a run that fails loudly beats a quietly partial dataset.
		expect(await detectTcrsCommand(fakeJar("TCRSSomethingElse"))).toEqual({
			command: "derive",
			recognised: false,
		});
	});

	it("throws when the jar cannot be read", async () => {
		await expect(
			detectTcrsCommand("/nonexistent/KoLmafia.jar"),
		).rejects.toThrow();
	});
});
