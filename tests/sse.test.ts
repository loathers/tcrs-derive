import { describe, expect, it, vi } from "vitest";
import { sseHandler } from "#server/sse-hub.server";
import type { ServerEvent } from "../app/lib/api-types.ts";
import { present } from "./helpers/present.ts";

/**
 * Pins the SSE wire format.
 *
 * REGRESSION: frames used to carry an `event: <type>` line. A named SSE event is
 * delivered only to addEventListener("<name>"), never to onmessage, so the browser
 * silently received nothing and the page updated only on a full reload. The type
 * is already in the JSON payload, so frames stay unnamed.
 */
/**
 * Feed a deliberately partial double into a typed slot. fakeRes() is not a
 * Response and is not trying to be: the handler only touches a handful of its
 * members, and naming the lie once beats repeating a cast at every call site.
 */
function fake<T>(value: unknown): T {
	return value as T;
}

function fakeRes() {
	const chunks: string[] = [];
	return {
		chunks,
		writableEnded: false,
		status: vi.fn().mockReturnThis(),
		setHeader: vi.fn(),
		flushHeaders: vi.fn(),
		write: vi.fn((s: string) => {
			chunks.push(s);
			return true;
		}),
		...emitter(),
		get body() {
			return chunks.join("");
		},
	};
}

/** A minimal EventEmitter stand-in: records handlers so a test can fire them. */
function emitter() {
	const handlers = new Map<string, (() => void)[]>();
	return {
		on: vi.fn((name: string, fn: () => void) => {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		}),
		fire(name: string) {
			for (const fn of handlers.get(name) ?? []) fn();
		},
	};
}

function fakeManager(status: unknown) {
	const listeners: ((e: ServerEvent) => void)[] = [];
	return {
		manager: {
			status: async () => status,
			activeState: null,
			subscribe: (fn: (e: ServerEvent) => void) => {
				listeners.push(fn);
				return () => {};
			},
		},
		emit: (e: ServerEvent) => {
			for (const l of listeners) l(e);
		},
	};
}

describe("the SSE wire format", () => {
	it("sends unnamed frames, so onmessage receives them", async () => {
		const res = fakeRes();
		const { manager, emit } = fakeManager({ now: "x", run: null });
		const req = { on: vi.fn() };

		await sseHandler(fake(manager))(fake(req), fake(res));
		emit({ type: "run-started", seq: 1, status: { now: "x" } as never });

		expect(res.body).toContain("data:");
		expect(res.body).not.toContain("event:");
	});

	it("opens with a retry hint and a full snapshot", async () => {
		// Every connection begins with a snapshot, including reconnects. That is what
		// makes a late joiner correct without the server keeping a replay buffer.
		const res = fakeRes();
		const { manager } = fakeManager({ now: "x", run: null });
		await sseHandler(fake(manager))(fake({ on: vi.fn() }), fake(res));

		expect(res.chunks[0]).toBe("retry: 3000\n\n");
		expect(res.body).toContain('"type":"snapshot"');
	});

	it("sets headers that survive a proxy", async () => {
		const res = fakeRes();
		const { manager } = fakeManager({ now: "x", run: null });
		await sseHandler(fake(manager))(fake({ on: vi.fn() }), fake(res));

		const set = Object.fromEntries(
			res.setHeader.mock.calls.map((c) => [c[0], c[1]]),
		);
		expect(set["content-type"]).toContain("text/event-stream");
		// Compression or buffering anywhere in the path would stall the stream.
		expect(set["cache-control"]).toContain("no-transform");
		expect(set["content-encoding"]).toBe("identity");
		expect(set["x-accel-buffering"]).toBe("no");
	});

	it("carries the event type in the payload, since frames are unnamed", async () => {
		const res = fakeRes();
		const { manager, emit } = fakeManager({ now: "x", run: null });
		await sseHandler(fake(manager))(fake({ on: vi.fn() }), fake(res));
		emit({
			type: "run-finished",
			seq: 2,
			runId: "r1",
			outcome: "success",
			status: {} as never,
		});

		const frames = res.body.split("\n\n").filter((f) => f.includes("data:"));
		for (const frame of frames) {
			const data = JSON.parse(present(frame.split("data: ")[1]));
			expect(typeof data.type).toBe("string");
		}
	});
});

describe("a client that goes away", () => {
	/**
	 * REGRESSION: the close handlers were registered AFTER `await manager.status()`,
	 * which does real fs I/O. A client dropping inside that window -- a navigation
	 * mid-load, or EventSource's own 3s reconnect churn -- had already fired `close`
	 * by the time they were attached, so the subscription and the 15s heartbeat that
	 * were created next were never cleaned up. Every dropped connection left one more
	 * permanent listener and timer.
	 */
	it("unsubscribes and stops its heartbeat if it drops during the snapshot", async () => {
		vi.useFakeTimers();
		try {
			const res = fakeRes();
			const req = emitter();

			let release!: () => void;
			const inFlight = new Promise<void>((r) => {
				release = r;
			});

			const listeners: ((e: ServerEvent) => void)[] = [];
			const manager = {
				status: async () => {
					await inFlight;
					return { now: "x", run: null };
				},
				activeState: null,
				subscribe: (fn: (e: ServerEvent) => void) => {
					listeners.push(fn);
					return () => {
						listeners.splice(listeners.indexOf(fn), 1);
					};
				},
			};

			const handled = sseHandler(fake(manager))(fake(req), fake(res));

			// The client goes while status() is still reading the manifest.
			req.fire("close");
			res.writableEnded = true;
			release();
			await handled;

			expect(listeners).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still cleans up when it drops after the stream is established", async () => {
		vi.useFakeTimers();
		try {
			const res = fakeRes();
			const req = emitter();
			const listeners: ((e: ServerEvent) => void)[] = [];
			const manager = {
				status: async () => ({ now: "x", run: null }),
				activeState: null,
				subscribe: (fn: (e: ServerEvent) => void) => {
					listeners.push(fn);
					return () => {
						listeners.splice(listeners.indexOf(fn), 1);
					};
				},
			};

			await sseHandler(fake(manager))(fake(req), fake(res));
			expect(listeners).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(1);

			req.fire("close");

			expect(listeners).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
