import type { CooldownInfo } from "../lib/api-types.ts";
import { useCountdown } from "../hooks/useCountdown.ts";
import { formatCountdown } from "../lib/format.ts";

/**
 * A real submit button inside a form, so it works without JavaScript.
 *
 * The 12-hour cooldown is the whole abuse protection, per the product decision; the
 * server enforces it (and single-flights concurrent presses) regardless of what
 * this button shows.
 */
export function GenerateButton({
  cooldown,
  serverNow,
  running,
  submitting,
}: {
  cooldown: CooldownInfo;
  serverNow: string;
  running: boolean;
  submitting: boolean;
}) {
  // The server's own remainingMs seeds the first render, so SSR and hydration
  // agree; it starts ticking from the wall clock only after mount.
  const remaining = useCountdown(
    cooldown.nextAllowedAt,
    serverNow,
    cooldown.remainingMs,
  );

  const label = running
    ? "Generating…"
    : submitting
      ? "Starting…"
      : cooldown.reason === "misconfigured"
        ? "Unavailable"
        : cooldown.reason === "low-disk"
          ? "Not enough disk"
          : remaining > 0
            ? `Available in ${formatCountdown(remaining)}`
            : "Generate now";

  const disabled =
    running || submitting || !cooldown.canGenerate || remaining > 0;

  return (
    <div className="actions">
      <button type="submit" disabled={disabled} className="primary">
        {label}
      </button>
      <p className="muted small">
        {running
          ? "A run is in progress — anyone watching sees the same progress."
          : remaining > 0
            ? `One run per ${cooldown.hours} hours. Deriving takes about 8 minutes.`
            : "Deriving all 54 permutations takes about 8 minutes."}
      </p>
    </div>
  );
}
