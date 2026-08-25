import { describe, expect, it } from "vitest";
import type { RunEvent } from "#core/events";
import { reduceAll, reduceRunState, orderedPerms } from "#core/state";
import { rowView } from "#core/present";
import { freshState, happyPath, stamp, T0 } from "./helpers/events.ts";

describe("reduceRunState", () => {
  it("starts every permutation queued", () => {
    const s = freshState();
    expect(s.summary).toEqual({
      total: 54,
      done: 0,
      running: 0,
      failed: 0,
      queued: 54,
      skipped: 0,
    });
  });

  it("walks a permutation through login -> items -> cafe -> done", () => {
    const events = stamp(happyPath("tt_wallaby"));
    const seen: string[] = [];
    let s = freshState();
    for (const e of events) {
      s = reduceRunState(s, e);
      // Assert on the rendered status line, which is what the operator sees.
      seen.push(rowView(s.perms["tt_wallaby"]!).status);
    }
    expect(seen).toEqual([
      "login",
      "login",
      "  0% items", // items header seen, no Progress: line yet -> 0%, not full
      "  0% items",
      " 49% items",
      " 99% items", // caps at 99: mafia's last line is always 12001/12070
      "cafe booze",
      "cafe food",
      "cafe food",
      "cafe food",
      "done",
    ]);
  });

  it("recomputes the summary rather than incrementing it", () => {
    // Replaying the same terminal event must not double-count.
    const done: RunEvent[] = stamp([
      { type: "perm:done", user: "tt_wallaby", attempts: 1 },
      { type: "perm:done", user: "tt_wallaby", attempts: 1 },
      { type: "perm:done", user: "tt_wallaby", attempts: 1 },
    ]);
    const s = reduceAll(freshState(), done);
    expect(s.summary.done).toBe(1);
    expect(s.summary.queued).toBe(53);
    expect(s.summary.done + s.summary.queued + s.summary.running +
           s.summary.failed + s.summary.skipped).toBe(54);
  });

  it("is total: an unknown event type leaves the state untouched", () => {
    // A browser holding a stale bundle after a deploy must not white-screen.
    const s = freshState();
    const bogus = { type: "perm:teleported", user: "tt_wallaby", seq: 1, at: T0 };
    expect(reduceRunState(s, bogus as unknown as RunEvent)).toBe(s);
  });

  it("ignores events for permutations this run isn't tracking", () => {
    const s = freshState(["tt_wallaby"]);
    const other = stamp([{ type: "perm:done", user: "sc_vole", attempts: 1 }]);
    expect(reduceRunState(s, other[0]!)).toBe(s);
  });

  it("shares structure for untouched permutations", () => {
    const s = freshState();
    const next = reduceAll(s, stamp(happyPath("tt_wallaby")));
    expect(next.perms["sc_vole"]).toBe(s.perms["sc_vole"]);
    expect(next.perms["tt_wallaby"]).not.toBe(s.perms["tt_wallaby"]);
  });

  it("never mutates the input state", () => {
    const s = freshState();
    const frozen = JSON.stringify(s);
    reduceAll(s, stamp(happyPath("tt_wallaby")));
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe("retries", () => {
  it("resets phase and progress when a new attempt begins", () => {
    // The bash scoped parsing to the current attempt block to get this right.
    const s = reduceAll(
      freshState(),
      stamp([
        { type: "perm:attempt", user: "tt_wallaby", attempt: 1, maxAttempts: 3 },
        { type: "perm:phase", user: "tt_wallaby", phase: "items" },
        { type: "perm:progress", user: "tt_wallaby", done: 4001, total: 12070 },
        { type: "perm:transient", user: "tt_wallaby", marker: "connect timed out" },
        { type: "perm:retryWait", user: "tt_wallaby", seconds: 15, nextAttempt: 2 },
        { type: "perm:attempt", user: "tt_wallaby", attempt: 2, maxAttempts: 3 },
      ]),
    );
    const p = s.perms["tt_wallaby"]!;
    expect(p.attempt).toBe(2);
    expect(p.status).toEqual({ kind: "login" });
    // sawTransient is attempt-scoped and must clear.
    expect(p.sawTransient).toBe(false);
  });

  it("surfaces an explicit retrying status during the backoff", () => {
    // The bash showed the stale previous phase for the whole 15/30s wait.
    const s = reduceAll(
      freshState(),
      stamp([
        { type: "perm:attempt", user: "tt_wallaby", attempt: 1, maxAttempts: 3 },
        { type: "perm:phase", user: "tt_wallaby", phase: "items" },
        { type: "perm:retryWait", user: "tt_wallaby", seconds: 15, nextAttempt: 2 },
      ]),
    );
    const status = s.perms["tt_wallaby"]!.status;
    expect(status.kind).toBe("retrying");
    // waitUntil is derived from the event's own `at`, never Date.now().
    if (status.kind === "retrying") {
      expect(status.waitUntil).toBe(T0 + 2000 + 15_000);
      expect(status.nextAttempt).toBe(2);
    }
  });

  it("shows stalled only before deriving starts", () => {
    const before = reduceAll(
      freshState(),
      stamp([
        { type: "perm:attempt", user: "tt_wallaby", attempt: 1, maxAttempts: 3 },
        { type: "perm:transient", user: "tt_wallaby", marker: "Connection reset" },
      ]),
    );
    expect(before.perms["tt_wallaby"]!.status.kind).toBe("stalled");

    // Once deriving is under way, a transient is noise: the bash only consulted
    // TRANSIENT_RE while !started, and the completeness guard handles the rest.
    const after = reduceAll(
      freshState(),
      stamp([
        { type: "perm:attempt", user: "tt_wallaby", attempt: 1, maxAttempts: 3 },
        { type: "perm:phase", user: "tt_wallaby", phase: "items" },
        { type: "perm:transient", user: "tt_wallaby", marker: "Connection reset" },
      ]),
    );
    expect(after.perms["tt_wallaby"]!.status.kind).toBe("deriving");
    expect(after.perms["tt_wallaby"]!.sawTransient).toBe(true);
  });

  it("clears filesWritten when partial output is discarded", () => {
    const s = reduceAll(
      freshState(),
      stamp([
        { type: "perm:wrote", user: "tt_wallaby", file: "TCRS_A.txt" },
        { type: "perm:discarded", user: "tt_wallaby", reason: "incomplete" },
      ]),
    );
    expect(s.perms["tt_wallaby"]!.filesWritten).toEqual([]);
  });
});

describe("skipped permutations stay visible", () => {
  it("counts resume-skipped rows instead of dropping them", () => {
    // The bash filtered them out of the task list, so resuming 52 of 54 displayed
    // "Overall: 0/2 done".
    const s = reduceAll(
      freshState(),
      stamp(
        ["sc_mongoose", "sc_wallaby"].map((user) => ({
          type: "batch:skipped" as const,
          user,
          reason: "resume" as const,
        })),
      ),
    );
    expect(s.summary.skipped).toBe(2);
    expect(s.summary.total).toBe(54);
    expect(orderedPerms(s)[0]!.status).toEqual({
      kind: "skipped",
      reason: "resume",
    });
  });
});

describe("run lifecycle", () => {
  it("tracks warm-up, start and end", () => {
    const s = reduceAll(
      freshState(),
      stamp([
        {
          type: "batch:start",
          runId: "R1",
          stagingDir: "/data/runs/R1",
          users: ["tt_wallaby"],
          concurrency: 4,
          maxAttempts: 3,
        },
        { type: "batch:warmup", status: "start" },
        { type: "batch:warmup", status: "ok" },
        {
          type: "batch:end",
          ok: 1,
          failed: 0,
          skipped: 0,
          total: 1,
          cancelled: false,
        },
      ]),
    );
    expect(s.runId).toBe("R1");
    expect(s.warmup).toBe("ok");
    expect(s.endedAt).not.toBeNull();
    expect(s.cancelled).toBe(false);
  });

  it("records lastSeq for SSE resume", () => {
    const s = reduceAll(freshState(), stamp(happyPath("tt_wallaby")));
    expect(s.lastSeq).toBe(11);
  });
});
