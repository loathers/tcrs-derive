/**
 * Resource route (loader only, no default export) returning StatusResponse.
 *
 * Two consumers: the polling fallback when EventSource is blocked, and
 * `tcrs attach`'s reachability probe.
 */
import type { Route } from "./+types/api.status";

export async function loader(_: Route.LoaderArgs) {
	const { getRunManager } = await import("#server/singleton.server");
	const manager = await getRunManager();
	return Response.json(await manager.status(), {
		headers: { "cache-control": "no-store" },
	});
}
