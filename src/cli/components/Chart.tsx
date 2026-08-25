/** The full table: every permutation, then the summary. */
import { Box } from "ink";
import { orderedPerms, type RunState } from "#core/state";
import { PermutationRow } from "./PermutationRow.tsx";
import { OverallSummary } from "./OverallSummary.tsx";

export function Chart({ state }: { state: RunState }) {
  return (
    <Box flexDirection="column">
      {orderedPerms(state).map((p) => (
        <PermutationRow key={p.user} perm={p} />
      ))}
      <OverallSummary summary={state.summary} />
    </Box>
  );
}
