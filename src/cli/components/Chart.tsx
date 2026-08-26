/** The full table: every permutation, then the summary. */
import { Box } from "ink";
import { orderedPerms, type RunState } from "#core/state";
import { OverallSummary } from "./OverallSummary.tsx";
import { PermutationRow } from "./PermutationRow.tsx";

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
