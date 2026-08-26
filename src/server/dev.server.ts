/**
 * The development-only guard, in one place so routes cannot drift apart.
 *
 * Controls that can interfere with a run, or with the gate protecting it, are
 * dev-only. The 12-hour cooldown is the sole thing limiting an unauthenticated
 * generate button, so anything that clears it or aborts a run must not be
 * reachable in production.
 */
export function isDev(): boolean {
	return process.env.NODE_ENV !== "production";
}

/**
 * Throws a 404 outside development.
 *
 * 404 rather than 403 deliberately: a deployed instance gives no hint that the
 * capability exists at all.
 */
export function requireDev(): void {
	if (!isDev()) throw new Response("Not found", { status: 404 });
}
