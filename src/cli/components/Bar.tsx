/** One progress bar. Delegates entirely to the shared presenter. */
import { Text } from "ink";
import type { RowView } from "#core/present";
import { TONE_COLOR } from "../tone.ts";

export function Bar({ view }: { view: RowView }) {
  return <Text color={TONE_COLOR[view.tone]}>[{view.bar}]</Text>;
}
