import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  TRANSIENT_RE,
  classifyLine,
  DeriveTracker,
  LineSplitter,
} from "#core/parser";

/**
 * THE HIGHEST-VALUE TEST IN THE SUITE.
 *
 * Every line below is taken verbatim from a run that SUCCEEDED. If the transient
 * classifier matches any of them, every permutation burns all 3 attempts and the
 * whole batch fails while looking like a network problem.
 */
const BENIGN_REAL_LINES = [
  // Present in 54/54 successful runs.
  "Error during session initialization",
  // 108x across successful runs — this is why TRANSIENT_RE must keep
  // `Unable to (establish|connect)` rather than a bare `Unable to`.
  "Unable to invoke no",
  " > Unable to invoke no",
  // Mid-derive in runs that completed.
  "Unexpected error, debug log printed.",
  // `IO Exception for` (with a space) vs the transient `IOException retrieving`.
  "IO Exception for TCRS_Accordion_Thief_Blender.txt: java.io.FileNotFoundException: /tmp/tcrs-work (No such file or directory)",
  "Local file TCRS_Accordion_Thief_Blender.txt does not exist.",
  "(file not found)",
  // The login-time prompts the `no no` pair answers.
  "No TCRS data is available for Accordion Thief/Blender. Would you like to derive it? (This will take a long time, but you only have to do it once.)",
  "(Y/N, leave blank to choose N)",
  "username: password: ",
];

describe("transient classification: false positives", () => {
  it.each(BENIGN_REAL_LINES)("does not treat %j as transient", (line) => {
    expect(classifyLine(line).kind).not.toBe("transient");
    expect(TRANSIENT_RE.test(line)).toBe(false);
  });

  it("finds nothing transient anywhere in two full successful runs", () => {
    // The strongest form of this assertion: sweep every line of the real logs.
    for (const fixture of ["happy", "benign-noise"]) {
      const text = readFileSync(`tests/fixtures/logs/${fixture}.log`, "utf8");
      const splitter = new LineSplitter();
      const lines = [...splitter.push(text), ...splitter.flush()];
      const offenders = lines.filter(
        (l) => classifyLine(l).kind === "transient",
      );
      expect(offenders, `${fixture}.log must contain no transient lines`).toEqual(
        [],
      );
    }
  });

  it("keeps a successful run's tracker free of transient flags", () => {
    const tracker = replay("happy");
    expect(tracker.sawTransient).toBe(false);
    expect(tracker.notInTcrs).toBe(false);
    expect(tracker.wrote).toHaveLength(3);
  });
});

describe("transient classification: true positives", () => {
  it.each([
    "IOException retrieving server reply (login.php).  Retrying...",
    "Connection timed out",
    "connect timed out",
    "Read timed out",
    "Connection reset",
    "Unable to establish a connection to KoL",
    "Unable to connect to www.kingdomofloathing.com",
  ])("treats %j as transient", (line) => {
    expect(classifyLine(line).kind).toBe("transient");
  });

  it("flags the transient-login fixture and never starts deriving", () => {
    const tracker = replay("transient-login");
    expect(tracker.sawTransient).toBe(true);
    expect(tracker.started).toBe(false);
    expect(tracker.itemsProgress).toBeNull();
  });

  it("flags not-in-tcrs separately, since it must never be retried", () => {
    const tracker = replay("not-in-tcrs");
    expect(tracker.notInTcrs).toBe(true);
    expect(tracker.sawTransient).toBe(false);
  });
});

function replay(fixture: string): DeriveTracker {
  const text = readFileSync(`tests/fixtures/logs/${fixture}.log`, "utf8");
  const splitter = new LineSplitter();
  const tracker = new DeriveTracker();
  for (const line of [...splitter.push(text), ...splitter.flush()]) {
    tracker.accept(line);
  }
  return tracker;
}
