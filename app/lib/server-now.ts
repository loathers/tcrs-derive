/**
 * The server's own idea of "now", as of the render that produced this page.
 *
 * Context rather than props because the two components that display a duration,
 * the download panel's "generated 6 hours ago" and the run summary's "elapsed",
 * sit two levels below the route and are otherwise given only the thing they
 * describe. Threading a clock reference through their parents would make every
 * component in between know about time for no reason.
 *
 * The value is a plain ISO string and changes only when the loader reloads, so a
 * memoised subtree is not re-rendered by the clock.
 */
import { createContext, useContext } from "react";

const ServerNowContext = createContext<string | null>(null);

export const ServerNowProvider = ServerNowContext.Provider;

export function useServerNowIso(): string {
	const iso = useContext(ServerNowContext);
	if (iso === null) {
		throw new Error("useServerNowIso used outside a ServerNowProvider");
	}
	return iso;
}
