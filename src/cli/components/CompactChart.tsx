/**
 * The compact view: the summary, then as many running rows as fit.
 *
 * Capping at the terminal height is a CORRECTNESS requirement, not cosmetics: a
 * frame taller than the terminal breaks ink's frame diffing and produces repeating
 * frames.
 */
import { Box } from "ink";
import { orderedPerms, type RunState } from "#core/state";
import { OverallSummary } from "./OverallSummary.tsx";
import { PermutationRow } from "./PermutationRow.tsx";

const RUNNING = new Set(["login", "stalled", "introspecting", "retrying"]);

export function CompactChart({
	state,
	rows,
}: {
	state: RunState;
	rows: number;
}) {
	const running = orderedPerms(state).filter((p) => RUNNING.has(p.status.kind));
	const room = Math.max(1, rows - 1);
	return (
		<Box flexDirection="column">
			<OverallSummary summary={state.summary} suffix="  [running only]" />
			{running.slice(0, room).map((p) => (
				<PermutationRow key={p.user} perm={p} />
			))}
		</Box>
	);
}
