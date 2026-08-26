import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, readlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  carryForward,
  createStaging,
  indexFiles,
  promote,
  pruneRuns,
  publishRun,
  readCurrentManifest,
  resolveCurrent,
  runIdFor,
  writeManifest,
  writeSums,
  type PermutationResult,
  type RunManifest,
} from "#core/staging.server";
import { permutationByUser } from "#core/permutations";

const AT = permutationByUser("at_blender")!;
const SC = permutationByUser("sc_mongoose")!;

function okResult(user: string): PermutationResult {
  return {
    user,
    ok: true,
    attempts: 1,
    filesCopied: 3,
    durationMs: 1,
    itemsDone: 12001,
    itemsTotal: 12070,
  };
}
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tcrs-staging-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function manifest(id: string, over: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    id,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1000).toISOString(),
    outcome: "success",
    durationMs: 1000,
    concurrency: 4,
    mafiaBuild: "r29131-M",
    results: [],
    entries: [],
    zip: null,
    totalBytes: 0,
    ...over,
  };
}

describe("runIdFor", () => {
  it("produces a filesystem- and URL-safe id", () => {
    const id = runIdFor(new Date("2026-08-24T09:15:03.123Z"));
    expect(id).toBe("2026-08-24T09-15-03-123Z");
    // No colons: legal on ext4 but breaks exfat/CIFS backups and needs shell
    // quoting.
    expect(id).not.toContain(":");
    expect(encodeURIComponent(id)).toBe(id);
  });
});

describe("the atomic swap", () => {
  it("publishes a run and resolves current to it", async () => {
    const data = tmp();
    const staging = await createStaging(data, "run-1");
    writeFileSync(join(staging.dataDir, AT.files[0]), "x");
    await promote(data, "run-1");

    expect(await resolveCurrent(data)).toBe(
      await realish(join(data, "runs", "run-1")),
    );
  });

  it("uses a RELATIVE symlink target, so the tree can be moved or bind-mounted", async () => {
    const data = tmp();
    await createStaging(data, "run-1");
    await promote(data, "run-1");
    expect(await readlink(join(data, "current"))).toBe(join("runs", "run-1"));
  });

  it("replaces an existing current with no window where it is absent", async () => {
    const data = tmp();
    await createStaging(data, "run-1");
    await promote(data, "run-1");
    await createStaging(data, "run-2");
    await promote(data, "run-2");

    expect(await readlink(join(data, "current"))).toBe(join("runs", "run-2"));
    // No leftover temp link.
    expect(existsSync(join(data, ".current.tmp"))).toBe(false);
  });

  it("returns null when nothing is published", async () => {
    expect(await resolveCurrent(tmp())).toBeNull();
  });

  it("returns null for a dangling current link", async () => {
    const data = tmp();
    await createStaging(data, "run-1");
    await promote(data, "run-1");
    await rm(join(data, "runs", "run-1"), { recursive: true, force: true });
    expect(await resolveCurrent(data)).toBeNull();
  });
});

describe("pruneRuns", () => {
  it("keeps only the named runs", async () => {
    const data = tmp();
    for (const id of ["run-1", "run-2", "run-3"]) await createStaging(data, id);
    const removed = await pruneRuns(data, ["run-3"]);
    expect(removed.sort()).toEqual(["run-1", "run-2"]);
    expect(await readdir(join(data, "runs"))).toEqual(["run-3"]);
  });

  it("is a no-op when there is no runs dir yet", async () => {
    expect(await pruneRuns(tmp(), [])).toEqual([]);
  });
});

describe("manifests", () => {
  it("round-trips through disk", async () => {
    const data = tmp();
    const staging = await createStaging(data, "run-1");
    await writeManifest(staging, manifest("run-1"));
    await promote(data, "run-1");

    const read = await readCurrentManifest(data);
    expect(read?.id).toBe("run-1");
    expect(read?.mafiaBuild).toBe("r29131-M");
  });

  it("is written atomically, leaving no temp file", async () => {
    const data = tmp();
    const staging = await createStaging(data, "run-1");
    await writeManifest(staging, manifest("run-1"));
    expect(existsSync(join(staging.dir, "manifest.json.tmp"))).toBe(false);
  });

  it("rejects a manifest of an unknown version", async () => {
    const data = tmp();
    const staging = await createStaging(data, "run-1");
    writeFileSync(
      join(staging.dir, "manifest.json"),
      JSON.stringify({ version: 99, id: "run-1" }),
    );
    await promote(data, "run-1");
    expect(await readCurrentManifest(data)).toBeNull();
  });
});

describe("indexFiles and writeSums", () => {
  it("hashes and measures the files that exist", async () => {
    const data = tmp();
    const staging = await createStaging(data, "run-1");
    writeFileSync(join(staging.dataDir, AT.files[0]), "hello");
    writeFileSync(join(staging.dataDir, AT.files[1]), "");

    const entries = await indexFiles(staging, "run-1");

    // The zero-byte file must be excluded, matching the collect rule.
    expect(entries.map((e) => e.name)).toEqual([AT.files[0]]);
    expect(entries[0]!.bytes).toBe(5);
    expect(entries[0]!.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(entries[0]!.sourceRunId).toBe("run-1");
  });

  it("writes SHA256SUMS.txt in sha256sum -c format", async () => {
    const data = tmp();
    const staging = await createStaging(data, "run-1");
    writeFileSync(join(staging.dataDir, AT.files[0]), "hello");
    const entries = await indexFiles(staging, "run-1");
    await writeSums(staging, entries);

    const sums = readFileSync(join(staging.dataDir, "SHA256SUMS.txt"), "utf8");
    expect(sums).toBe(`${entries[0]!.sha256}  ${AT.files[0]}\n`);
  });
});

describe("carryForward", () => {
  it("fills a gap from the previous run and records its source", async () => {
    // 53 fresh files plus one twelve-hour-old file beats a 404.
    const data = tmp();
    const prev = await createStaging(data, "run-1");
    writeFileSync(join(prev.dataDir, AT.files[0]), "old but valid");
    const prevManifest = manifest("run-1", {
      entries: [
        {
          name: AT.files[0],
          user: AT.user,
          kind: "items",
          bytes: 13,
          sha256: "deadbeef",
          sourceRunId: "run-1",
        },
      ],
    });

    const next = await createStaging(data, "run-2");
    const carried = await carryForward(
      next,
      { dir: prev.dir, manifest: prevManifest },
      [AT.files[0]],
    );

    expect(carried).toHaveLength(1);
    // sourceRunId still points at the run that actually derived it, so the UI can
    // mark the row stale.
    expect(carried[0]!.sourceRunId).toBe("run-1");
    expect(readFileSync(join(next.dataDir, AT.files[0]), "utf8")).toBe(
      "old but valid",
    );
  });

  it("carries nothing when there is no previous run", async () => {
    const data = tmp();
    const next = await createStaging(data, "run-1");
    expect(await carryForward(next, null, [AT.files[0]])).toEqual([]);
  });

  it("skips a file the previous run also lacked", async () => {
    const data = tmp();
    const prev = await createStaging(data, "run-1");
    const next = await createStaging(data, "run-2");
    const carried = await carryForward(
      next,
      { dir: prev.dir, manifest: manifest("run-1") },
      [AT.files[0]],
    );
    expect(carried).toEqual([]);
  });
});

/** realpath, resolving macOS's /var -> /private/var symlink like the code does. */
async function realish(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  await mkdir(p, { recursive: true });
  return realpath(p);
}

describe("publishRun", () => {
  const base = {
    mafiaBuild: "r29183",
    concurrency: 3,
    startedAt: 0,
    finishedAt: 1000,
    outcome: "success" as const,
  };

  it("marks carried-forward files as coming from the earlier run", async () => {
    // REGRESSION: publish used to re-index the staging dir AFTER carry-forward,
    // and indexFiles stamps everything it finds with the CURRENT run id. That
    // erased the only record that a file came from an older run, so
    // stalePermutations was permanently empty and the "old" badge never showed.
    const data = tmp();

    const prev = await createStaging(data, "run-1");
    writeFileSync(join(prev.dataDir, AT.files[0]), "older but valid");
    const prevEntries = await indexFiles(prev, "run-1");
    await writeManifest(prev, manifest("run-1", { entries: prevEntries }));
    await promote(data, "run-1");

    // run-2 produces only the second file, so the first has to be carried.
    const next = await createStaging(data, "run-2");
    writeFileSync(join(next.dataDir, AT.files[1]), "fresh");
    const freshEntries = await indexFiles(next, "run-2");

    const { manifest: published, carried } = await publishRun(data, {
      staging: next,
      runId: "run-2",
      entries: freshEntries,
      results: [],
      ...base,
    });

    expect(carried).toHaveLength(1);
    const byName = new Map(published.entries.map((e) => [e.name, e]));
    expect(byName.get(AT.files[0])!.sourceRunId).toBe("run-1");
    expect(byName.get(AT.files[1])!.sourceRunId).toBe("run-2");
  });

  it("checksums the carried files too, not just the fresh ones", async () => {
    const data = tmp();
    const prev = await createStaging(data, "run-1");
    writeFileSync(join(prev.dataDir, AT.files[0]), "older");
    await writeManifest(
      prev,
      manifest("run-1", { entries: await indexFiles(prev, "run-1") }),
    );
    await promote(data, "run-1");

    const next = await createStaging(data, "run-2");
    writeFileSync(join(next.dataDir, AT.files[1]), "fresh");
    await publishRun(data, {
      staging: next,
      runId: "run-2",
      entries: await indexFiles(next, "run-2"),
      results: [],
      ...base,
    });

    const sums = readFileSync(join(next.dataDir, "SHA256SUMS.txt"), "utf8");
    expect(sums).toContain(AT.files[0]);
    expect(sums).toContain(AT.files[1]);
  });

  it("publishes atomically: manifest, zip and symlink all land together", async () => {
    const data = tmp();
    const staging = await createStaging(data, "run-1");
    for (const name of AT.files) writeFileSync(join(staging.dataDir, name), "x");

    const { manifest: published } = await publishRun(data, {
      staging,
      runId: "run-1",
      entries: await indexFiles(staging, "run-1"),
      results: [],
      ...base,
    });

    expect(await readlink(join(data, "current"))).toBe(join("runs", "run-1"));
    expect(published.zip).not.toBeNull();
    expect(existsSync(join(data, "current", "tcrs-data.zip"))).toBe(true);
    expect((await readCurrentManifest(data))!.id).toBe("run-1");
    expect(published.totalBytes).toBe(3);
  });

  /*
   * run-1 derives both permutations. run-2 is `--only at_blender`: it re-derives
   * AT and never touches SC. Both tests below assert on what run-2 published, so
   * they share the setup and differ only in what they look at.
   */
  async function partialRerun(data: string): Promise<RunManifest> {
    const first = await createStaging(data, "run-1");
    for (const name of [...AT.files, ...SC.files]) {
      writeFileSync(join(first.dataDir, name), "from run 1");
    }
    await publishRun(data, {
      staging: first,
      runId: "run-1",
      entries: await indexFiles(first, "run-1"),
      results: [okResult(AT.user), okResult(SC.user)],
      ...base,
    });

    const second = await createStaging(data, "run-2");
    for (const name of AT.files) {
      writeFileSync(join(second.dataDir, name), "from run 2");
    }
    const { manifest } = await publishRun(data, {
      staging: second,
      runId: "run-2",
      entries: await indexFiles(second, "run-2"),
      results: [okResult(AT.user)],
      ...base,
    });
    return manifest;
  }

  it("keeps files no permutation in this run was even asked to produce", async () => {
    // REGRESSION: the gap list used to be scoped to the SELECTED permutations, so a
    // `--only sc_mongoose` run published its 3 files, pruned the previous run and
    // destroyed the other 159. A published dataset is all-or-nothing: anything this
    // run did not produce has to be carried, whether it failed or was never run.
    const data = tmp();
    const published = await partialRerun(data);

    expect(published.entries.map((e) => e.name).sort()).toEqual(
      [...AT.files, ...SC.files].sort(),
    );
    const byName = new Map(published.entries.map((e) => [e.name, e]));
    expect(byName.get(AT.files[0])!.sourceRunId).toBe("run-2");
    expect(byName.get(SC.files[0])!.sourceRunId).toBe("run-1");
    expect(readFileSync(join(data, "current", "data", SC.files[0]), "utf8")).toBe(
      "from run 1",
    );
  });

  it("carries the results of the permutations it carried files for", async () => {
    // resumableUsers joins entries against results, so carrying a permutation's
    // files without its result would silently make it un-resumable and it would be
    // re-derived from scratch on the next --resume.
    const published = await partialRerun(tmp());

    expect(published.results.map((r) => r.user).sort()).toEqual(
      [AT.user, SC.user].sort(),
    );
    expect(published.results.every((r) => r.ok)).toBe(true);
  });

  it("prunes the previous run once the swap has happened", async () => {
    const data = tmp();
    const first = await createStaging(data, "run-1");
    writeFileSync(join(first.dataDir, AT.files[0]), "x");
    await publishRun(data, {
      staging: first,
      runId: "run-1",
      entries: await indexFiles(first, "run-1"),
      results: [],
      ...base,
    });

    const second = await createStaging(data, "run-2");
    writeFileSync(join(second.dataDir, AT.files[0]), "y");
    await publishRun(data, {
      staging: second,
      runId: "run-2",
      entries: await indexFiles(second, "run-2"),
      results: [],
      ...base,
    });

    expect(await readdir(join(data, "runs"))).toEqual(["run-2"]);
  });
});
