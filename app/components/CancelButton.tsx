import { useFetcher } from "react-router";

/**
 * Stop the run in progress. Dev-only: the route it posts to does not exist in
 * production, where a bad run has to finish.
 */
export function CancelButton() {
	const fetcher = useFetcher<{ cancelled: boolean; error?: string }>();
	const pending = fetcher.state !== "idle";
	const failed = fetcher.data && !fetcher.data.cancelled;

	return (
		<fetcher.Form method="post" action="/api/cancel">
			<button
				type="submit"
				className="dev-only"
				disabled={pending}
				title="Development only"
			>
				{pending ? "Stopping..." : "Stop this run"}
				<span className="sr-only"> (development only)</span>
			</button>
			{failed && (
				<span className="muted small" role="status">
					{" "}
					{fetcher.data?.error === "not_running"
						? "It had already finished."
						: "Could not stop it."}
				</span>
			)}
		</fetcher.Form>
	);
}
