import type { RunSnapshot } from "../lib/api-types.ts";
import { CancelButton } from "./CancelButton.tsx";
import { ProgressGrid } from "./ProgressGrid.tsx";
import { RunSummary } from "./RunSummary.tsx";

export function ProgressPanel({ run }: { run: RunSnapshot }) {
  return (
    <section>
      <h2>Running</h2>
      <RunSummary state={run.state} />
      <ProgressGrid state={run.state} />
      {run.state.warmup === "running" && (
        <p className="muted small">Warming up shared data files.</p>
      )}
      <CancelButton />
    </section>
  );
}
