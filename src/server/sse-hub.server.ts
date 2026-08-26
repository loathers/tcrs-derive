/**
 * SSE fan-out. NODE-ONLY.
 *
 * Deliberately an Express route rather than a React Router resource route: a
 * 7.5-minute stream wants direct `res.write` + `res.flushHeaders()` control, with
 * no adapter between us and the socket.
 *
 * THE PROTOCOL DECISION THAT MATTERS: every connection begins with a full
 * `snapshot`, including reconnects. That is what makes a late joiner correct, * requirement 4, since someone else may have started the run, while letting the
 * server keep NO replay buffer and ignore Last-Event-ID entirely.
 */

import type { Request, Response } from "express";
import type { ServerEvent } from "../../app/lib/api-types.ts";
import type { RunManager } from "./run-manager.server.ts";

/** Against idle timeouts anywhere in the path (Coolify's proxy included). */
const HEARTBEAT_MS = 15_000;

export function sseHandler(manager: RunManager) {
	return async function handle(req: Request, res: Response): Promise<void> {
		res.status(200);
		res.setHeader("content-type", "text/event-stream; charset=utf-8");
		res.setHeader("cache-control", "no-cache, no-transform");
		res.setHeader("connection", "keep-alive");
		// Never compress an event stream. `no-transform` above and this header cover
		// Traefik (Coolify's default) and nginx respectively.
		res.setHeader("content-encoding", "identity");
		res.setHeader("x-accel-buffering", "no");
		res.flushHeaders();

		// Tell EventSource how fast to reconnect, before anything else.
		res.write("retry: 3000\n\n");

		const send = (event: ServerEvent) => {
			// If the client is gone, stop writing rather than buffering forever.
			if (res.writableEnded) return;
			// Deliberately NOT sending an `event:` line. A named SSE event is only
			// delivered to addEventListener("<name>"), never to onmessage, so naming
			// them meant the browser silently received nothing and the page only
			// updated on a full reload. The type is already in the payload, so leaving
			// frames unnamed gives one code path that cannot miss a future type.
			res.write(`id: ${event.seq}\n`);
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		};

		let unsubscribe: (() => void) | null = null;
		let heartbeat: NodeJS.Timeout | null = null;
		let gone = false;

		const cleanup = () => {
			gone = true;
			if (heartbeat) clearInterval(heartbeat);
			if (unsubscribe) unsubscribe();
			heartbeat = null;
			unsubscribe = null;
		};

		// BEFORE the first await, and that is the whole point. manager.status() below
		// does fs I/O, and a client dropping inside it -- a navigation mid-load, or
		// EventSource's own 3s reconnect churn -- fires `close` before handlers
		// registered afterwards exist. The subscription and heartbeat created further
		// down would then never be cleaned up, one more of each per dropped connection,
		// for the life of the process.
		req.on("close", cleanup);
		res.on("close", cleanup);
		res.on("error", cleanup);

		// The full snapshot, first.
		const status = await manager.status();
		// `close` may have fired during that await, in which case cleanup has already
		// run and nothing is left to run it again. Subscribing now would leak.
		if (gone) return;

		send({
			type: "snapshot",
			seq: 0,
			status,
			state: manager.activeState,
		});

		unsubscribe = manager.subscribe(send);
		heartbeat = setInterval(() => {
			if (!res.writableEnded) res.write(": hb\n\n");
		}, HEARTBEAT_MS);
	};
}
