/**
 * Tone to ink colour, for the terminal only.
 *
 * Lives here rather than in present.ts because a colour name is medium-specific:
 * the web maps the same tones to CSS in styles.css. It is shared between the bar
 * and the row label because they render side by side, and when the two files each
 * had their own copy they drifted, leaving a running permutation with a cyan bar
 * next to white text.
 */
import type { Tone } from "#core/present";

export const TONE_COLOR = {
  idle: "gray",
  active: "cyan",
  ok: "green",
  fail: "red",
  warn: "yellow",
} as const satisfies Record<Tone, string>;
