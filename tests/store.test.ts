import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hoursFor } from "#server/store.server";
import {
  createStaging,
  promote,
  writeManifest,
  type RunManifest,
} from "#core/staging.server";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tcrs-store-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const COOLDOWN = { successHours: 12, failedHours: 1 };
const HOUR = 3_600_000;

/** A controllable clock, so cooldown arithmetic is deterministic. */
function clock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function manifest(id: string, over: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    id,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1000).toISOString(),
    outcome: "success",
    durationMs: 1000,
    concurrency: 4,
    mafiaBuild: null,
    results: [],
    entries: [],
    zip: null,
    totalBytes: 0,
    ...over,
  };
}

describe("cooldown arithmetic", () => {
  it("allows the very first run", () => {
    const store = new Store(tmp(), COOLDOWN, () => 0);
    const info = store.cooldownInfo();
    expect(info.canGenerate).toBe(true);
    expect(info.remainingMs).toBe(0);
  });

  it("blocks for 12 hours after a success, measured from the START", async () => {
    // From the start, not the finish, so a 7.5-minute run does not drift the
    // window later on every cycle.
    const c = clock(1_000_000);
    const store = new Store(tmp(), COOLDOWN, c.now);
    await store.beginAttempt("r1", c.now());
    c.advance(8 * 60 * 1000); // the run takes 8 minutes
    await store.endAttempt("r1", "success");

    const info = store.cooldownInfo();
    expect(info.canGenerate).toBe(false);
    // 12h from the START means ~11h52m left, not a full 12h.
    expect(info.remainingMs).toBe(12 * HOUR - 8 * 60 * 1000);

    c.advance(info.remainingMs);
    expect(store.cooldownInfo().canGenerate).toBe(true);
  });

  it("uses the short window after a total failure", async () => {
    // A failure costs KoL nothing. Locking a public site for 12h over one is
    // user-hostile.
    const c = clock(0);
    const store = new Store(tmp(), COOLDOWN, c.now);
    await store.beginAttempt("r1", 0);
    await store.endAttempt("r1", "failed");
    expect(store.cooldownInfo().remainingMs).toBe(1 * HOUR);

    c.advance(1 * HOUR);
    expect(store.cooldownInfo().canGenerate).toBe(true);
  });

  it("ignores a crash in the first few minutes entirely", async () => {
    // A crash 10 seconds in must not lock the site for half a day.
    const store = new Store(tmp(), COOLDOWN, () => 0);
    await store.beginAttempt("r1", 0);
    await store.endAttempt("r1", "aborted-early");
    expect(store.cooldownInfo().canGenerate).toBe(true);
  });

  it("treats a late crash as a real run", async () => {
    const store = new Store(tmp(), COOLDOWN, () => 0);
    await store.beginAttempt("r1", 0);
    await store.endAttempt("r1", "aborted");
    expect(store.cooldownInfo().remainingMs).toBe(12 * HOUR);
  });

  it("maps every outcome to a window", () => {
    expect(hoursFor("success", COOLDOWN)).toBe(12);
    expect(hoursFor("partial", COOLDOWN)).toBe(12);
    expect(hoursFor("aborted", COOLDOWN)).toBe(12);
    expect(hoursFor("failed", COOLDOWN)).toBe(1);
    expect(hoursFor("aborted-early", COOLDOWN)).toBe(0);
  });

  it("survives a restart, because the cooldown is on disk", async () => {
    // Otherwise a crash-loop would let the button be pressed without limit.
    const data = tmp();
    const c = clock(5_000_000);
    const first = new Store(data, COOLDOWN, c.now);
    await first.init();
    await first.beginAttempt("r1", c.now());
    await first.endAttempt("r1", "success");

    const second = new Store(data, COOLDOWN, c.now);
    await second.init();
    expect(second.cooldownInfo().canGenerate).toBe(false);
    expect(second.lastAttempt?.id).toBe("r1");
  });
});

describe("boot recovery", () => {
  it("cleans up an orphaned staging dir and closes the attempt", async () => {
    // The container was SIGKILLed mid-run: its staging dir is incomplete and must
    // never be published.
    const data = tmp();
    const c = clock(10 * HOUR);
    const first = new Store(data, COOLDOWN, c.now);
    await first.init();
    await createStaging(data, "orphan");
    await first.beginAttempt("orphan", c.now());
    expect(first.state.activeRunId).toBe("orphan");

    // Simulate a restart 10 minutes later.
    c.advance(10 * 60 * 1000);
    const second = new Store(data, COOLDOWN, c.now);
    const { recovered } = await second.init();

    expect(recovered).toBe("orphan");
    expect(second.state.activeRunId).toBeNull();
    expect(second.lastAttempt?.outcome).toBe("aborted");
    expect(existsSync(join(data, "runs", "orphan"))).toBe(false);
  });

  it("classifies a very early crash as aborted-early", async () => {
    const data = tmp();
    const c = clock(0);
    const first = new Store(data, COOLDOWN, c.now);
    await first.init();
    await first.beginAttempt("orphan", c.now());

    c.advance(10_000); // crashed 10 seconds in
    const second = new Store(data, COOLDOWN, c.now);
    await second.init();
    expect(second.lastAttempt?.outcome).toBe("aborted-early");
    // And therefore does not consume any cooldown.
    expect(second.cooldownInfo().canGenerate).toBe(true);
  });

  it("keeps a properly published run and adopts it as current", async () => {
    const data = tmp();
    const staging = await createStaging(data, "good");
    await writeManifest(staging, manifest("good"));
    await promote(data, "good");

    const store = new Store(data, COOLDOWN, () => 0);
    await store.init();
    expect(store.state.currentRunId).toBe("good");
    expect(existsSync(join(data, "runs", "good"))).toBe(true);
  });

  it("unlinks a current pointing at a run that never finished", async () => {
    // i.e. the process died between writing the in-progress manifest and the swap.
    const data = tmp();
    const staging = await createStaging(data, "halfway");
    await writeManifest(staging, manifest("halfway", { finishedAt: null }));
    await promote(data, "halfway");

    const store = new Store(data, COOLDOWN, () => 0);
    await store.init();
    expect(store.state.currentRunId).toBeNull();
    expect(existsSync(join(data, "current"))).toBe(false);
  });

  it("unlinks a dangling current", async () => {
    const data = tmp();
    await createStaging(data, "gone");
    await promote(data, "gone");
    await rm(join(data, "runs", "gone"), { recursive: true, force: true });

    const store = new Store(data, COOLDOWN, () => 0);
    await store.init();
    expect(store.state.currentRunId).toBeNull();
  });

  it("prunes run dirs that are neither current nor active", async () => {
    // Catches a kill inside the swap window.
    const data = tmp();
    const good = await createStaging(data, "good");
    await writeManifest(good, manifest("good"));
    await promote(data, "good");
    await createStaging(data, "stray-1");
    await createStaging(data, "stray-2");

    const store = new Store(data, COOLDOWN, () => 0);
    const { pruned } = await store.init();
    expect(pruned.sort()).toEqual(["stray-1", "stray-2"]);
    expect(await readdir(join(data, "runs"))).toEqual(["good"]);
  });

  it("clears the JVM scratch dir, which holds a full mafia tree per permutation", async () => {
    const data = tmp();
    await mkdir(join(data, "work", "tt_wallaby", "data"), { recursive: true });
    writeFileSync(join(data, "work", "tt_wallaby", "data", "big.txt"), "x");

    const store = new Store(data, COOLDOWN, () => 0);
    await store.init();
    expect(await readdir(join(data, "work"))).toEqual([]);
  });

  it("tolerates a corrupt state.json rather than refusing to boot", async () => {
    const data = tmp();
    writeFileSync(join(data, "state.json"), "{ not json");
    const store = new Store(data, COOLDOWN, () => 0);
    await expect(store.init()).resolves.toBeDefined();
    expect(store.lastAttempt).toBeNull();
  });

  it("ignores a state.json from a future version", async () => {
    const data = tmp();
    writeFileSync(
      join(data, "state.json"),
      JSON.stringify({ version: 99, activeRunId: "x", attempts: [] }),
    );
    const store = new Store(data, COOLDOWN, () => 0);
    await store.init();
    expect(store.state.activeRunId).toBeNull();
  });
});

describe("attempt history", () => {
  it("keeps newest first and caps the list", async () => {
    const store = new Store(tmp(), COOLDOWN, () => 0);
    for (let i = 0; i < 25; i++) {
      await store.beginAttempt(`r${i}`, 0);
      await store.endAttempt(`r${i}`, "success");
    }
    expect(store.state.attempts).toHaveLength(20);
    expect(store.state.attempts[0]!.id).toBe("r24");
  });
});
