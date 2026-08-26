/**
 * POST /api/reset-cooldown, development only.
 *
 * The 12-hour cooldown is the ONLY thing gating an unauthenticated generate
 * button, so an endpoint that clears it must not exist in production. This route
 * 404s there rather than 403ing, so a deployed instance gives no hint that the
 * capability exists at all.
 *
 * Clears the attempt history only. The published dataset is untouched.
 */

import { requireDev } from "#server/dev.server";
import type { Route } from "./+types/api.reset-cooldown";

export async function action({ request }: Route.ActionArgs) {
	requireDev();

	if (request.method !== "POST") {
		return Response.json(
			{ reset: false, error: "method_not_allowed" },
			{ status: 405, headers: { allow: "POST" } },
		);
	}

	const { getRunManager } = await import("#server/singleton.server");
	const manager = await getRunManager();
	await manager.clearCooldown();

	return Response.json(
		{ reset: true },
		{ status: 200, headers: { "cache-control": "no-store" } },
	);
}

export function loader() {
	requireDev();
	return Response.json(
		{ error: "use POST to reset the cooldown" },
		{ status: 405, headers: { allow: "POST" } },
	);
}
