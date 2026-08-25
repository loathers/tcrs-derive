import { useFetcher } from "react-router";

/**
 * Stop the run in progress. Its own form posting to /api/cancel, so it works
 * without JavaScript and is not entangled with the generate form.
 */
export function CancelButton() {
  const fetcher = useFetcher<{ cancelled: boolean; error?: string }>();
  const pending = fetcher.state !== "idle";
  const failed = fetcher.data && !fetcher.data.cancelled;

  return (
    <fetcher.Form method="post" action="/api/cancel" className="cancel">
      <button type="submit" disabled={pending}>
        {pending ? "Stopping..." : "Stop this run"}
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
