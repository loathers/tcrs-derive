import { useFetcher } from "react-router";

/**
 * Dev-only escape hatch for the 12-hour cooldown.
 *
 * The route it posts to does not exist in production, so this is safe even if the
 * flag that hides it were ever wrong.
 */
export function ResetCooldownButton() {
	const fetcher = useFetcher<{ reset: boolean }>();
	const pending = fetcher.state !== "idle";

	return (
		<fetcher.Form method="post" action="/api/reset-cooldown">
			<button
				type="submit"
				className="dev-only"
				disabled={pending}
				title="Development only"
			>
				{pending ? "Resetting..." : "Reset cooldown"}
				<span className="sr-only"> (development only)</span>
			</button>
		</fetcher.Form>
	);
}
