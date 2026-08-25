import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ensureJar, JarUnavailableError, resolveJar } from "#core/jar.server";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tcrs-jar-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/**
 * REGRESSION: the jar path must always come back ABSOLUTE.
 *
 * Every JVM is spawned with cwd set to its own private work dir. A relative
 * `-jar KoLmafia.jar` is therefore resolved against THAT directory, so all 54
 * permutations died instantly with "unable to open file KoLmafia.jar" — a run that
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
    expect(isAbsolute(found!)).toBe(true);
  });

  it("keeps an already-absolute path unchanged", async () => {
    const dir = tmp();
    const p = join(dir, "KoLmafia.jar");
    writeFileSync(p, "x");
    expect(await resolveJar({ explicit: p, searchDir: "/somewhere/else" })).toBe(p);
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
    expect(await resolveJar({ explicit: "KoLmafia.jar", searchDir: dir })).toBeNull();
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
