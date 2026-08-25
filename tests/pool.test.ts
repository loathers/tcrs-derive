import { describe, expect, it } from "vitest";
import { pool } from "#core/runBatch.server";

const never = new AbortController().signal;

describe("pool", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);

    await pool(items, 4, never, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });

    expect(peak).toBe(4);
  });

  it("runs every item exactly once", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];
    await pool(items, 6, never, async (i) => {
      seen.push(i);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("admits in list order, matching xargs -P N -L1", async () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const admitted: string[] = [];
    await pool(items, 2, never, async (x) => {
      admitted.push(x);
      await new Promise((r) => setTimeout(r, 1));
    });
    // The first `limit` items must be the first admitted.
    expect(admitted.slice(0, 2).sort()).toEqual(["a", "b"]);
  });

  it("handles a limit larger than the item count", async () => {
    let count = 0;
    await pool([1, 2], 16, never, async () => {
      count++;
    });
    expect(count).toBe(2);
  });

  it("handles an empty item list", async () => {
    await expect(pool([], 4, never, async () => {})).resolves.toBeUndefined();
  });

  it("stops ADMITTING once aborted, without rejecting", async () => {
    // The point of the hand-rolled pool: a Ctrl-C must not launch more JVMs while
    // the current ones are being torn down. p-limit has no cancellation at all.
    const controller = new AbortController();
    const items = Array.from({ length: 40 }, (_, i) => i);
    const started: number[] = [];

    await pool(items, 4, controller.signal, async (i) => {
      started.push(i);
      if (started.length === 8) controller.abort();
      await new Promise((r) => setTimeout(r, 2));
    });

    // Some in-flight work completes after the abort, but admission stops promptly.
    expect(started.length).toBeGreaterThanOrEqual(8);
    expect(started.length).toBeLessThan(20);
  });

  it("throws AggregateError if a task leaks an exception", async () => {
    // A rejected worker silently reduces effective concurrency, so this must be
    // loud rather than swallowed. runOne is specified never to reject.
    await expect(
      pool([1, 2, 3], 2, never, async (i) => {
        if (i === 2) throw new Error("leaked");
      }),
    ).rejects.toThrow(AggregateError);
  });

  it("does not let one throwing task prevent others from being admitted", async () => {
    const done: number[] = [];
    await pool([1, 2, 3, 4], 1, never, async (i) => {
      try {
        if (i === 2) throw new Error("handled inside fn");
      } catch {
        // Swallowed by fn, as runOne does.
      }
      done.push(i);
    });
    expect(done).toEqual([1, 2, 3, 4]);
  });
});
