/** One progress bar. Delegates entirely to the shared presenter. */
import { Text } from "ink";
import type { RowView } from "#core/present";

const TONE_COLOR = {
  idle: "gray",
  active: "cyan",
  ok: "green",
  fail: "red",
  warn: "yellow",
} as const;

export function Bar({ view }: { view: RowView }) {
  return (
    <Text color={TONE_COLOR[view.tone]}>
      [{view.bar}]
    </Text>
  );
}
