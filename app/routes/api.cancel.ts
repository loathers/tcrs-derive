/**
 * POST /api/cancel, stop the run that is currently in progress.
 *
 * Exists because the only way to stop a batch used to be SIGTERM-ing the server,
 * which is both awkward and dangerous: it is easy to kill a run you did not mean
 * to. A run is ~8 minutes and 54 KoL logins, so being able to stop a bad one
 * deliberately matters.
 *
 * DEVELOPMENT ONLY. A public cancel is griefable: any visitor could abort someone
 * else's eight-minute run, and there is no identity to check them against. In
 * production a bad run has to finish, which the 12-hour cooldown already bounds.
 *
 * Cancelling does not cost a cooldown that generating had not already spent. The
 * attempt is recorded when the run starts and the normal outcome rules apply, so
 * an abort in the first five minutes is treated as never having happened.
 */
import type { Route } from "./+types/api.cancel";
import { requireDev } from "#server/dev.server";

export async function action({ request }: Route.ActionArgs) {
  requireDev();

  if (request.method !== "POST") {
    return Response.json(
      { cancelled: false, error: "method_not_allowed" },
      { status: 405, headers: { allow: "POST" } },
    );
  }

  const { getRunManager } = await import("#server/singleton.server");
  const manager = await getRunManager();
  // Awaits teardown, so a 202 means "the JVMs are gone", not "asked nicely".
  // runBatch kills each process group on abort, so this returns quickly.
  const runId = await manager.cancel();

  if (runId === null) {
    return Response.json(
      { cancelled: false, error: "not_running" },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    { cancelled: true, runId },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}

export function loader() {
  requireDev();
  return Response.json(
    { error: "use POST to cancel a run" },
    { status: 405, headers: { allow: "POST" } },
  );
}
