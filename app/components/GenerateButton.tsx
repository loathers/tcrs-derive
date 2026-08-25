import type { CooldownInfo } from "../lib/api-types.ts";
import { useCountdown } from "../hooks/useCountdown.ts";
import { formatCountdown } from "../lib/format.ts";

/**
 * Plain submit button in a form, so it works without JavaScript. The server
 * enforces the cooldown and single-flights concurrent presses regardless of
 * what this renders.
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
  const remaining = useCountdown(
    cooldown.nextAllowedAt,
    serverNow,
    cooldown.remainingMs,
  );
  const blocked = remaining > 0;

  return (
    <>
      <h2>Regenerate</h2>
      <p className="muted small">
        Takes approximately 8 minutes. Limited to one run every{" "}
        {cooldown.policyHours}h.
        {running && " A run is already in progress."}
        {cooldown.reason === "misconfigured" &&
          " Server is misconfigured. Unavailable."}
        {cooldown.reason === "low-disk" && " Not enough free disk."}
      </p>
      <button
        type="submit"
        disabled={running || submitting || !cooldown.canGenerate || blocked}
      >
        {running
          ? "Running"
          : submitting
            ? "Starting..."
            : blocked
              ? `Available in ${formatCountdown(remaining)}`
              : "Generate"}
      </button>
    </>
  );
}
