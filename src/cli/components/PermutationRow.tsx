/** One chart row: `<user> [bar] status`. */
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
