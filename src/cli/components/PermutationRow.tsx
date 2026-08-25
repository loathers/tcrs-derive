/** One chart row: `%-12s [bar] status`, matching run-all.sh:200 byte for byte. */
import { Box, Text } from "ink";
import { rowView } from "#core/present";
import type { PermState } from "#core/state";
import { Bar } from "./Bar.tsx";

const TONE_COLOR = {
  idle: "gray",
  active: "white",
  ok: "green",
  fail: "red",
  warn: "yellow",
} as const;

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
