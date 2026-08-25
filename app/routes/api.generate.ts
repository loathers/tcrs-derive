/**
 * POST /api/generate — request a run.
 *
 * A dedicated resource route rather than the index route's action, for two
 * reasons: React Router needs a `?index` query param to disambiguate an index
 * action from its parent layout's, and a clean `POST /api/generate` is what a
 * curl user or a status page would expect.
 *
 * Real HTTP semantics come for free here, which is a large part of why the trigger
 * is a POST and the progress stream is one-way SSE:
 *   202 accepted · 409 already running · 429 cooldown (+ Retry-After) · 503 unable
 */
import type { Route } from "./+types/api.generate";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json(
      { accepted: false, error: "method_not_allowed" },
      { status: 405, headers: { allow: "POST" } },
    );
  }

  const { getRunManager } = await import("#server/singleton.server");
  const manager = await getRunManager();
  const result = manager.trigger();

  const status = result.accepted
    ? 202
    : result.error === "already_running"
      ? 409
      : result.error === "cooldown"
        ? 429
        : 503;

  const headers = new Headers({ "cache-control": "no-store" });
  if (!result.accepted && result.error === "cooldown") {
    headers.set("retry-after", String(Math.ceil(result.remainingMs / 1000)));
  }
  return Response.json(result, { status, headers });
}

/** A GET here is a mistake; say so rather than 404ing confusingly. */
export function loader() {
  return Response.json(
    { error: "use POST to request a generation" },
    { status: 405, headers: { allow: "POST" } },
  );
}
