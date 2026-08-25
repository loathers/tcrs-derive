import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  COMPLETE_TOLERANCE,
  DeriveTracker,
  LineSplitter,
  isDeriveComplete,
} from "#core/parser";

function replay(fixture: string): DeriveTracker {
  const text = readFileSync(`tests/fixtures/logs/${fixture}.log`, "utf8");
  const splitter = new LineSplitter();
  const tracker = new DeriveTracker();
  for (const line of [...splitter.push(text), ...splitter.flush()]) {
    tracker.accept(line);
  }
  return tracker;
}

/** A tracker whose items phase ended at `done`/`total`. */
function atProgress(done: number, total = 12070): DeriveTracker {
  const t = new DeriveTracker();
  t.accept("Deriving TCRS item adjustments for all real items...");
  t.accept(`Progress: ${done}/${total}`);
  return t;
}

describe("isDeriveComplete on real fixtures", () => {
  it("accepts a real successful run (12001/12070, 69 short)", () => {
    const t = replay("happy");
    expect(t.itemsProgress).toEqual({ done: 12001, total: 12070 });
    expect(isDeriveComplete(t)).toBe(true);
  });

  it("accepts the benign-noise run, which completed despite an error line", () => {
    expect(isDeriveComplete(replay("benign-noise"))).toBe(true);
  });

  it("rejects a run that bailed at 4001/12070 despite writing 3 files", () => {
    // This is the whole reason the guard exists: mafia printed Done! and saved
    // truncated files. File existence alone would have accepted it.
    const t = replay("partial-bail");
    expect(t.wrote).toHaveLength(3);
    expect(t.itemsProgress).toEqual({ done: 4001, total: 12070 });
    expect(isDeriveComplete(t)).toBe(false);
  });

  it("accepts 11951/12070 (119 short, inside tolerance)", () => {
    expect(isDeriveComplete(replay("near-complete"))).toBe(true);
  });

  it("rejects 11900/12070 (170 short, outside tolerance)", () => {
    expect(isDeriveComplete(replay("just-short"))).toBe(false);
  });

  it("rejects a run that never started deriving", () => {
    expect(isDeriveComplete(replay("transient-login"))).toBe(false);
  });
});

describe("the tolerance boundary", () => {
  it("defaults to 150, which must exceed mafia's 100-item announce step", () => {
    expect(COMPLETE_TOLERANCE).toBe(150);
    // The last line mafia emits is always Progress: 12001/12070 — exactly 69
    // short. The comparison is inclusive, so 69 is the smallest tolerance that
    // still accepts a real successful run; 68 rejects all 54 of them.
    expect(isDeriveComplete(atProgress(12001), 68)).toBe(false);
    expect(isDeriveComplete(atProgress(12001), 69)).toBe(true);
  });

  it("is inclusive at exactly total - tolerance", () => {
    expect(isDeriveComplete(atProgress(12070 - 150))).toBe(true);
    expect(isDeriveComplete(atProgress(12070 - 151))).toBe(false);
  });

  it("rejects when no progress was ever seen, even with files present", () => {
    // "3 files present, no progress" must be discarded, not accepted.
    const t = new DeriveTracker();
    t.accept("Wrote file TCRS_Turtle_Tamer_Wallaby.txt");
    t.accept("Wrote file TCRS_Turtle_Tamer_Wallaby_cafe_booze.txt");
    t.accept("Wrote file TCRS_Turtle_Tamer_Wallaby_cafe_food.txt");
    expect(t.wrote).toHaveLength(3);
    expect(isDeriveComplete(t)).toBe(false);
  });
});

describe("progress is scoped to the items phase", () => {
  it("does not let a cafe phase overwrite the items progress", () => {
    // The bash scoped this with `awk '/for all cafe/{exit}'` (run-one.sh:52).
    // If a cafe phase could overwrite itemsProgress, a truncated items derive
    // followed by cafe phases could look complete.
    const t = replay("partial-bail");
    expect(t.phase).toBe("cafe_food");
    expect(t.itemsProgress).toEqual({ done: 4001, total: 12070 });
    expect(isDeriveComplete(t)).toBe(false);
  });

  it("clears the current-phase progress on a phase change", () => {
    // This is what makes a stale items percentage structurally impossible to
    // render during a cafe phase — see state.ts / present.ts.
    const t = atProgress(12001);
    expect(t.progress).toEqual({ done: 12001, total: 12070 });
    t.accept("Deriving TCRS item adjustments for all cafe booze items...");
    expect(t.progress).toBeNull();
    expect(t.itemsProgress).toEqual({ done: 12001, total: 12070 });
  });

  it("marks started on the real-items header alone, matching STARTED_RE", () => {
    const t = new DeriveTracker();
    t.accept("Deriving TCRS item adjustments for all real items...");
    expect(t.started).toBe(true);
  });

  it("does not mark started on a cafe header alone", () => {
    // A cafe header without an items header should not count as "login worked and
    // the real derive began" — STARTED_RE only matches the real-items header.
    const t = new DeriveTracker();
    t.accept("Deriving TCRS item adjustments for all cafe booze items...");
    expect(t.started).toBe(false);
  });
});
