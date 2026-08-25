import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SecretStore } from "#core/env.server";
import { ALL_PERMUTATIONS, passwordVarFor } from "#core/permutations";
import type { BatchConfig } from "#core/runBatch.server";
import { reduceRunState, type RunState } from "#core/state";
import { RunManager } from "#server/run-manager.server";
import { Store } from "#server/store.server";
import type { ServerEvent } from "../app/lib/api-types.ts";

const FAKE_JAVA = resolve("tests/fixtures/fake-java.mjs");
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tcrs-mgr-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const allSecrets: SecretStore = {
  passwordFor: () => "hunter2",
  missingFor: () => [],
  size: 54,
};

const noSecrets: SecretStore = {
  passwordFor: () => {
    throw new Error("no");
  },
  missingFor: (perms) => perms.map((p) => passwordVarFor(p)),
  size: 0,
};

/** A stand-in jar. fake-java ignores its contents; it only has to exist, so that
 *  ensureJar() resolves locally instead of reaching for the network. */
function stubJar(dataDir: string): string {
  const p = join(dataDir, "KoLmafia.jar");
  writeFileSync(p, "not really a jar");
  return p;
}

function config(dataDir: string, over: Partial<BatchConfig> = {}): BatchConfig {
  return {
    jarPath: stubJar(dataDir),
    javaBin: process.execPath,
    javaOpts: [FAKE_JAVA],
    concurrency: 2,
    resume: false,
    dataDir,
    maxAttempts: 1,
    loginTimeoutMs: 30_000,
    timeoutMs: 30_000,
    retryBackoffMs: 10,
    completeTolerance: 150,
    stallTimeoutMs: null,
    warmupTimeoutMs: 5_000,
    skipWarmup: true,
    keepWorkdirs: false,
    only: ["at_blender", "at_packrat"],
    ...over,
  };
}

async function manager(
  over: Partial<BatchConfig> = {},
  secrets = allSecrets,
): Promise<{ manager: RunManager; store: Store; dataDir: string }> {
  const dataDir = tmp();
  const store = new Store(dataDir, { successHours: 12, failedHours: 1 });
  const m = new RunManager({
    store,
    config: config(dataDir, over),
    secrets,
    minFreeBytes: 0,
    allowJarDownload: false,
  });
  await m.init();
  return { manager: m, store, dataDir };
}

describe("single-flight", () => {
  it("accepts exactly one of two simultaneous triggers", async () => {
    // trigger() is synchronous all the way to the #active assignment, so with no
    // await in that window two callers provably cannot both pass.
    const { manager: m } = await manager();
    const a = m.trigger();
    const b = m.trigger();

    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(false);
    if (!b.accepted) expect(b.error).toBe("already_running");
    await m.cancel();
  }, 60_000);

  it("rejects every one of many concurrent triggers but the first", async () => {
    const { manager: m } = await manager();
    const results = Array.from({ length: 20 }, () => m.trigger());
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    await m.cancel();
  }, 60_000);

  it("allows another run once the first has finished and cooldown is clear", async () => {
    const { manager: m, store } = await manager();
    expect(m.trigger().accepted).toBe(true);
    // Wait for the run to complete.
    for (let i = 0; i < 200; i++) {
      if ((await m.status()).run === null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await m.status()).run).toBeNull();
    // Cooldown now blocks it, which is the intended behaviour.
    const second = m.trigger();
    expect(second.accepted).toBe(false);
    if (!second.accepted) expect(second.error).toBe("cooldown");
    expect(store.lastAttempt?.outcome).toBe("success");
  }, 120_000);
});

describe("trigger refusals", () => {
  it("refuses when passwords are missing, and says so", async () => {
    const { manager: m } = await manager({}, noSecrets);
    const r = m.trigger();
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.error).toBe("misconfigured");
      if (r.error === "misconfigured") {
        expect(r.detail).toContain("PASSWORD_");
      }
    }
    const status = await m.status();
    expect(status.configOk).toBe(false);
    expect(status.missingPasswordCount).toBe(ALL_PERMUTATIONS.length);
    expect(status.cooldown.reason).toBe("misconfigured");
  });

  it("never reveals WHICH passwords are missing, only the count", async () => {
    const { manager: m } = await manager({}, noSecrets);
    const status = await m.status();
    expect(JSON.stringify(status)).not.toContain("PASSWORD_TT_WALLABY");
    expect(status.missingPasswordCount).toBe(54);
  });

  it("refuses on insufficient disk rather than publishing a truncated dataset", async () => {
    const dataDir = tmp();
    const store = new Store(dataDir, { successHours: 12, failedHours: 1 });
    const m = new RunManager({
      store,
      config: config(dataDir),
      secrets: allSecrets,
      // Absurdly high, so the real free space is always below it.
      minFreeBytes: Number.MAX_SAFE_INTEGER,
      allowJarDownload: false,
    });
    await m.init();
    const r = m.trigger();
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.error).toBe("insufficient_disk");
  });
});

describe("the SSE contract", () => {
  it("gives a late joiner the full current state, not a blank chart", async () => {
    // THE REQUIREMENT: someone else may have started the run. A client connecting
    // mid-run must be immediately correct, which is why every connection begins
    // with a snapshot and the server keeps no replay buffer.
    const { manager: m } = await manager({
      only: ALL_PERMUTATIONS.slice(0, 6).map((p) => p.user),
      concurrency: 2,
      javaOpts: [FAKE_JAVA, "--fake-delay=2"],
    });

    expect(m.trigger().accepted).toBe(true);

    // Let real progress accumulate before "connecting".
    await waitUntil(async () => {
      const s = await m.status();
      return (s.run?.state.summary.done ?? 0) >= 1;
    });

    const snapshot = await m.status();
    expect(snapshot.run).not.toBeNull();
    const state = snapshot.run!.state;
    // The late joiner sees genuine progress, not all-queued.
    expect(state.summary.done).toBeGreaterThanOrEqual(1);
    expect(state.summary.queued).toBeLessThan(6);

    await m.cancel();
  }, 120_000);

  it("lets a client fold snapshot + patches to the same state the server holds", async () => {
    // This is the proof that the browser and the ink CLI cannot drift: they apply
    // the core's own reduceRunState to the same event stream.
    const { manager: m } = await manager({
      only: ALL_PERMUTATIONS.slice(0, 4).map((p) => p.user),
      concurrency: 2,
    });

    let client: RunState | null = null;
    const unsubscribe = m.subscribe((e: ServerEvent) => {
      if (e.type === "run-started" || e.type === "run-finished") {
        client = e.status.run?.state ?? client;
      } else if (e.type === "patch" && client !== null) {
        client = reduceRunState(client, e.event);
      }
    });

    expect(m.trigger().accepted).toBe(true);
    await waitUntil(async () => (await m.status()).run === null, 60_000);
    unsubscribe();

    // The client's independently-folded state matches the authoritative summary.
    expect(client).not.toBeNull();
    expect(client!.summary.done).toBe(4);
    expect(client!.summary.total).toBe(4);
  }, 120_000);

  it("broadcasts run-started and run-finished around a run", async () => {
    const { manager: m } = await manager({ only: ["at_blender"] });
    const kinds: string[] = [];
    m.subscribe((e) => {
      if (e.type !== "patch") kinds.push(e.type);
    });

    expect(m.trigger().accepted).toBe(true);
    // Wait for the EVENT, not for status().run to clear: #active is nulled just
    // before run-finished is broadcast, so the latter can win the race.
    await waitUntil(async () => kinds.includes("run-finished"), 60_000);

    expect(kinds).toContain("run-started");
    expect(kinds).toContain("run-finished");
  }, 120_000);
});

describe("publishing", () => {
  it("publishes a successful run and reports it as the dataset", async () => {
    const { manager: m } = await manager({ only: ["at_blender", "at_packrat"] });
    expect(m.trigger().accepted).toBe(true);
    await waitUntil(async () => (await m.status()).run === null, 60_000);

    const status = await m.status();
    expect(status.dataset).not.toBeNull();
    expect(status.dataset!.outcome).toBe("success");
    // 2 permutations x 3 files.
    expect(status.dataset!.fileCount).toBe(6);
    expect(status.dataset!.zip).not.toBeNull();
    expect(status.dataset!.stalePermutations).toEqual([]);
  }, 120_000);

  it("does not publish when every permutation failed", async () => {
    // Keep the previous dataset rather than replace it with nothing.
    const { manager: m } = await manager({
      only: ["at_blender"],
      javaOpts: [FAKE_JAVA, "--fake-fixture=partial-bail"],
    });
    expect(m.trigger().accepted).toBe(true);
    await waitUntil(async () => (await m.status()).run === null, 60_000);

    const status = await m.status();
    expect(status.dataset).toBeNull();
    expect(status.lastAttempt?.outcome).toBe("failed");
    // A failure gets the short cooldown, not 12 hours.
    expect(status.cooldown.hours).toBe(1);
  }, 120_000);
});

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitUntil timed out");
}

describe("the single-instance lock", () => {
  it("stops a second manager from sharing one data directory", async () => {
    // A rolling deploy would start the new container before stopping the old one,
    // and two batches against one volume could tear the published dataset. This is
    // why the deploy strategy must be stop-then-start.
    const { LockHeldError } = await import("#core/lock.server");
    const dataDir = tmp();

    const first = new RunManager({
      store: new Store(dataDir, { successHours: 12, failedHours: 1 }),
      config: config(dataDir),
      secrets: allSecrets,
      minFreeBytes: 0,
      allowJarDownload: false,
    });
    await first.init();

    const second = new RunManager({
      store: new Store(dataDir, { successHours: 12, failedHours: 1 }),
      config: config(dataDir),
      secrets: allSecrets,
      minFreeBytes: 0,
      allowJarDownload: false,
    });
    await expect(second.init()).rejects.toThrow(LockHeldError);

    // Releasing lets the next process in, so a normal restart is unaffected.
    await first.shutdown();
    await expect(second.init()).resolves.toBeUndefined();
    await second.shutdown();
  }, 60_000);

  it("reclaims a lock left by a process that is gone", async () => {
    // A SIGKILLed process must not wedge the next boot forever.
    const { writeFileSync } = await import("node:fs");
    const { hostname } = await import("node:os");
    const dataDir = tmp();
    // Same host, so the pid is directly comparable; 999999 will not exist.
    writeFileSync(
      join(dataDir, ".lock"),
      `${hostname()} 999999 2020-01-01T00:00:00.000Z\n`,
    );

    const m = new RunManager({
      store: new Store(dataDir, { successHours: 12, failedHours: 1 }),
      config: config(dataDir),
      secrets: allSecrets,
      minFreeBytes: 0,
      allowJarDownload: false,
    });
    await expect(m.init()).resolves.toBeUndefined();
    await m.shutdown();
  }, 60_000);
});

describe("the KoLmafia jar", () => {
  it("reports misconfigured when no jar is available, before any run starts", async () => {
    // Regression guard: the server used to hand an unresolved jar path straight to
    // spawn(), so a missing jar produced 54 identical spawn failures minutes into a
    // run instead of the site plainly saying it could not run.
    const dataDir = tmp();
    const m = new RunManager({
      store: new Store(dataDir, { successHours: 12, failedHours: 1 }),
      config: config(dataDir, { jarPath: join(dataDir, "definitely-absent.jar") }),
      secrets: allSecrets,
      minFreeBytes: 0,
      allowJarDownload: false, // do not reach for the network in a test
    });
    await m.init();

    const status = await m.status();
    expect(status.configOk).toBe(false);
    expect(status.cooldown.reason).toBe("misconfigured");

    const r = m.trigger();
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.error).toBe("misconfigured");
    await m.shutdown();
  }, 30_000);

  it("resolves the jar to an absolute path every run then uses", async () => {
    const dataDir = tmp();
    const cfg = config(dataDir);
    const m = new RunManager({
      store: new Store(dataDir, { successHours: 12, failedHours: 1 }),
      config: cfg,
      secrets: allSecrets,
      minFreeBytes: 0,
      allowJarDownload: false,
    });
    await m.init();
    expect((await m.status()).configOk).toBe(true);
    // The resolved path is fed back into the config the batch runner reads.
    expect(cfg.jarPath).toContain("KoLmafia.jar");
    await m.shutdown();
  }, 30_000);
});

describe("cancelling a run", () => {
  it("stops the run and reports which one it stopped", async () => {
    const { manager: m } = await manager({
      only: ALL_PERMUTATIONS.slice(0, 6).map((p) => p.user),
      concurrency: 2,
      javaOpts: [FAKE_JAVA, "--fake-delay=5"],
    });

    const started = m.trigger();
    expect(started.accepted).toBe(true);

    const cancelled = await m.cancel();
    expect(cancelled).toBe(started.accepted ? started.runId : "");
    await waitUntil(async () => (await m.status()).run === null, 60_000);
    expect((await m.status()).run).toBeNull();
  }, 120_000);

  it("returns null when nothing is running, rather than throwing", async () => {
    const { manager: m } = await manager();
    expect(await m.cancel()).toBeNull();
  });

  it("requests cancellation synchronously, so it cannot race a finishing run", async () => {
    // cancel() must decide against #active before its first await. Otherwise two
    // callers, or a caller racing natural completion, could both act.
    const { manager: m } = await manager({ only: ["at_blender"] });
    const started = m.trigger();
    // Both are issued before either resolves. The cancel is requested
    // synchronously, so neither can act on a run the other already tore down.
    const [first, second] = await Promise.all([m.cancel(), m.cancel()]);
    const expected = started.accepted ? started.runId : "";
    expect([first, second]).toContain(expected);
  }, 60_000);

  it("does not leave a cancelled run publishable", async () => {
    const { manager: m } = await manager({
      only: ALL_PERMUTATIONS.slice(0, 4).map((p) => p.user),
      javaOpts: [FAKE_JAVA, "--fake-delay=5"],
    });
    m.trigger();
    await m.cancel();
    await waitUntil(async () => (await m.status()).run === null, 60_000);

    // A partial, cancelled run must never become the published dataset.
    expect((await m.status()).dataset).toBeNull();
  }, 120_000);
});

describe("what generatedAt means", () => {
  it("is when the dataset finished, not when the run started", async () => {
    // A batch takes ~12 minutes. Reporting startedAt made "generated N minutes
    // ago" overstate the age by the whole duration.
    const { manager: m, dataDir } = await manager({
      only: ["at_blender"],
    });
    expect(m.trigger().accepted).toBe(true);
    await waitUntil(async () => (await m.status()).run === null, 60_000);

    const status = await m.status();
    expect(status.dataset).not.toBeNull();

    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(join(dataDir, "current", "manifest.json"), "utf8"),
    ) as { startedAt: string; finishedAt: string };

    expect(status.dataset!.generatedAt).toBe(manifest.finishedAt);
    expect(status.dataset!.generatedAt).not.toBe(manifest.startedAt);
  }, 120_000);

  it("still measures the cooldown from the start, so a long run does not drift it", async () => {
    // The two timestamps serve different purposes and must not be conflated.
    const { manager: m, store } = await manager({ only: ["at_blender"] });
    expect(m.trigger().accepted).toBe(true);
    await waitUntil(async () => (await m.status()).run === null, 60_000);

    const status = await m.status();
    const started = Date.parse(store.lastAttempt!.startedAt);
    const nextAllowed = Date.parse(status.cooldown.nextAllowedAt!);
    expect(nextAllowed - started).toBe(12 * 60 * 60 * 1000);
  }, 120_000);
});
