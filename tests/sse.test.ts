import { describe, expect, it, vi } from "vitest";
import { sseHandler } from "#server/sse-hub.server";
import type { ServerEvent } from "../app/lib/api-types.ts";

/**
 * Pins the SSE wire format.
 *
 * REGRESSION: frames used to carry an `event: <type>` line. A named SSE event is
 * delivered only to addEventListener("<name>"), never to onmessage, so the browser
 * silently received nothing and the page updated only on a full reload. The type
 * is already in the JSON payload, so frames stay unnamed.
 */
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
    on: vi.fn(),
    get body() {
      return chunks.join("");
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
    emit: (e: ServerEvent) => listeners.forEach((l) => l(e)),
  };
}

describe("the SSE wire format", () => {
  it("sends unnamed frames, so onmessage receives them", async () => {
    const res = fakeRes();
    const { manager, emit } = fakeManager({ now: "x", run: null });
    const req = { on: vi.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sseHandler(manager as any)(req as any, res as any);
    emit({ type: "run-started", seq: 1, status: { now: "x" } as never });

    expect(res.body).toContain("data:");
    expect(res.body).not.toContain("event:");
  });

  it("opens with a retry hint and a full snapshot", async () => {
    // Every connection begins with a snapshot, including reconnects. That is what
    // makes a late joiner correct without the server keeping a replay buffer.
    const res = fakeRes();
    const { manager } = fakeManager({ now: "x", run: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sseHandler(manager as any)({ on: vi.fn() } as any, res as any);

    expect(res.chunks[0]).toBe("retry: 3000\n\n");
    expect(res.body).toContain('"type":"snapshot"');
  });

  it("sets headers that survive a proxy", async () => {
    const res = fakeRes();
    const { manager } = fakeManager({ now: "x", run: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sseHandler(manager as any)({ on: vi.fn() } as any, res as any);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sseHandler(manager as any)({ on: vi.fn() } as any, res as any);
    emit({ type: "run-finished", seq: 2, runId: "r1", outcome: "success", status: {} as never });

    const frames = res.body.split("\n\n").filter((f) => f.includes("data:"));
    for (const frame of frames) {
      const data = JSON.parse(frame.split("data: ")[1]!);
      expect(typeof data.type).toBe("string");
    }
  });
});
