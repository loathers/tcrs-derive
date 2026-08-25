import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Chart } from "#cli/components/Chart";
import { CompactChart } from "#cli/components/CompactChart";
import { reduceAll, type RunState } from "#core/state";
import { freshState, happyPath, stamp } from "../helpers/events.ts";
import type { RunEventInit } from "#core/events";

/** Strip ANSI so assertions compare plain text. */
function plain(s: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? "").replace(/\[[0-9;]*m/g, "");
}

const MID_RUN: RunEventInit[] = [
  ...happyPath("sc_mongoose"),
  { type: "perm:attempt", user: "sc_wallaby", attempt: 1, maxAttempts: 3 },
  { type: "perm:phase", user: "sc_wallaby", phase: "items" },
  { type: "perm:progress", user: "sc_wallaby", done: 2200, total: 12070 },
  { type: "perm:attempt", user: "sc_vole", attempt: 2, maxAttempts: 3 },
  { type: "perm:phase", user: "sc_vole", phase: "cafe_booze" },
  {
    type: "perm:failed",
    user: "sc_platypus",
    attempts: 3,
    copied: 0,
    reason: "login",
  },
];

function midRun(): RunState {
  return reduceAll(freshState(), stamp(MID_RUN));
}

describe("Chart", () => {
  it("renders one row per permutation plus the summary", () => {
    const state = midRun();
    const { lastFrame } = render(<Chart state={state} />);
    const lines = plain(lastFrame()).split("\n");
    expect(lines).toHaveLength(55); // 54 rows + summary
    expect(lines.at(-1)).toBe(
      "Overall: 1/54 done  (2 running, 1 failed, 50 queued)",
    );
  });

  it("reproduces the bash row format byte for byte", () => {
    const state = midRun();
    const { lastFrame } = render(<Chart state={state} />);
    const lines = plain(lastFrame()).split("\n");
    expect(lines[0]).toBe("sc_mongoose  [██████████] done");
    expect(lines[1]).toBe("sc_wallaby   [█░░░░░░░░░]  18% items");
    expect(lines[2]).toBe("sc_vole      [██████████] cafe booze try 2/3");
    expect(lines[3]).toBe("sc_platypus  [▓▓▓▓▓▓▓▓▓▓] FAIL 0/3");
    expect(lines[4]).toBe("sc_opossum   [░░░░░░░░░░] queued");
  });

  it("never shows a stale items percentage during a cafe phase", () => {
    // The row went items -> cafe_booze. It must read "cafe booze", not "99% items".
    const state = reduceAll(
      freshState(),
      stamp([
        { type: "perm:attempt", user: "tt_wallaby", attempt: 1, maxAttempts: 3 },
        { type: "perm:phase", user: "tt_wallaby", phase: "items" },
        { type: "perm:progress", user: "tt_wallaby", done: 12001, total: 12070 },
        { type: "perm:phase", user: "tt_wallaby", phase: "cafe_booze" },
      ]),
    );
    const { lastFrame } = render(<Chart state={state} />);
    const row = plain(lastFrame())
      .split("\n")
      .find((l) => l.startsWith("tt_wallaby"));
    expect(row).toBe("tt_wallaby   [██████████] cafe booze");
    expect(row).not.toContain("%");
  });

  it("renders a fresh run as all queued", () => {
    const { lastFrame } = render(<Chart state={freshState()} />);
    const lines = plain(lastFrame()).split("\n");
    // Match the row form specifically: the summary line also says "N queued".
    expect(lines.filter((l) => l.endsWith("] queued"))).toHaveLength(54);
  });
});

describe("CompactChart", () => {
  it("shows the summary plus only the running rows", () => {
    const { lastFrame } = render(<CompactChart state={midRun()} rows={20} />);
    const lines = plain(lastFrame()).split("\n");
    expect(lines[0]).toBe(
      "Overall: 1/54 done  (2 running, 1 failed, 50 queued)  [running only]",
    );
    // Only the in-flight rows. No done/failed/queued rows.
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).map((l) => l.split(" ")[0])).toEqual([
      "sc_wallaby",
      "sc_vole",
    ]);
  });

  it("caps its height, which is a correctness requirement not cosmetics", () => {
    // A frame taller than the terminal breaks ink's frame diffing and produces
    // repeating frames. Direct port of the bash's `cap` (run-all.sh:253).
    const busy = reduceAll(
      freshState(),
      stamp(
        freshState().order.flatMap((user) => [
          {
            type: "perm:attempt" as const,
            user,
            attempt: 1,
            maxAttempts: 3,
          },
          { type: "perm:phase" as const, user, phase: "items" as const },
        ]),
      ),
    );
    expect(busy.summary.running).toBe(54);

    for (const rows of [5, 10, 24]) {
      const { lastFrame } = render(<CompactChart state={busy} rows={rows} />);
      const lines = plain(lastFrame()).split("\n");
      expect(lines.length, `rows=${rows}`).toBeLessThanOrEqual(rows);
    }
  });

  it("degrades gracefully in a tiny terminal", () => {
    const { lastFrame } = render(<CompactChart state={midRun()} rows={1} />);
    const lines = plain(lastFrame()).split("\n");
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toContain("Overall:");
  });
});
