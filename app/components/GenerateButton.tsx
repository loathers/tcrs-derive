import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useCountdown } from "../hooks/useCountdown.ts";
import type { CooldownInfo, GenerateResponse } from "../lib/api-types.ts";
import { formatCountdown } from "../lib/format.ts";

/**
 * The generate control, including its own form and rejection handling.
 *
 * `extra` is a slot for a sibling control (the dev-only cooldown reset). It sits
 * next to the button rather than inside the form, because a form cannot contain
 * another form.
 */
export function GenerateButton({
	cooldown,
	serverNow,
	extra,
}: {
	cooldown: CooldownInfo;
	serverNow: string;
	extra?: React.ReactNode;
}) {
	const fetcher = useFetcher<GenerateResponse>();
	const revalidator = useRevalidator();

	const remaining = useCountdown(
		cooldown.nextAllowedAt,
		serverNow,
		cooldown.remainingMs,
	);
	const blocked = remaining > 0;
	const submitting = fetcher.state !== "idle";

	// A rejection means this page was out of date, so resync rather than reporting
	// it. The button is disabled during a cooldown and a live run shows its own
	// panel, so "too soon" and "already running" tell the reader nothing new.
	const rejected = fetcher.data && !fetcher.data.accepted ? fetcher.data : null;
	// Depending on `rejected` or `revalidator` would re-fire this on every fetcher
	// transition, and revalidating is what produces those.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the error identity alone
	useEffect(() => {
		if (rejected && revalidator.state === "idle") revalidator.revalidate();
	}, [rejected?.error]);

	// Only what the reader cannot work out from the page itself.
	const blocker =
		rejected &&
		(rejected.error === "misconfigured" ||
			rejected.error === "insufficient_disk")
			? rejected
			: null;

	return (
		<>
			<h2>Regenerate</h2>
			<p className="muted small">
				Takes approximately 8 minutes. Limited to one run every {cooldown.hours}
				h.
				{cooldown.reason === "misconfigured" &&
					" Server is misconfigured. Unavailable."}
				{cooldown.reason === "low-disk" && " Not enough free disk."}
			</p>

			<div className="button-row">
				<fetcher.Form method="post" action="/api/generate">
					<button
						type="submit"
						disabled={submitting || !cooldown.canGenerate || blocked}
					>
						{submitting
							? "Starting..."
							: blocked
								? `Available in ${formatCountdown(remaining)}`
								: "Generate"}
					</button>
				</fetcher.Form>
				{extra}
			</div>

			{blocker && (
				<p className="error" role="alert">
					{blocker.error === "misconfigured"
						? `Cannot run: ${blocker.detail}`
						: "Cannot run: not enough free disk."}
				</p>
			)}
		</>
	);
}
