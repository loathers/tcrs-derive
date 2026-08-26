/** One chart row: `%-12s [bar] status`, matching run-all.sh:200 byte for byte. */
import { Box, Text } from "ink";
import { rowView } from "#core/present";
import type { PermState } from "#core/state";
import { TONE_COLOR } from "../tone.ts";
import { Bar } from "./Bar.tsx";

export function PermutationRow({ perm }: { perm: PermState }) {
	const view = rowView(perm);
	return (
		<Box>
			<Text>{view.user.padEnd(12)} </Text>
			<Bar view={view} />
			<Text color={TONE_COLOR[view.tone]}> {view.status}</Text>
		</Box>
	);
}
