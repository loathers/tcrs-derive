import type { RunSnapshot } from "../lib/api-types.ts";
import { CancelButton } from "./CancelButton.tsx";
import { ProgressGrid } from "./ProgressGrid.tsx";
import { RunSummary } from "./RunSummary.tsx";

export function ProgressPanel({ run }: { run: RunSnapshot }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Generating</h2>
        <CancelButton />
      </div>
      <RunSummary state={run.state} />
      <ProgressGrid state={run.state} />
      {run.state.warmup === "running" && (
        <p className="muted small">Warming up shared data files…</p>
      )}
    </section>
  );
}
