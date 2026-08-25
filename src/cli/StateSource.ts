/**
 * A source of RunState, so `tcrs run` and `tcrs attach` render the IDENTICAL App.
 *
 * remoteSource applies the same reduceRunState as the local runner and as the
 * browser, the working proof that the reducer is platform-free.
 */

import type { RunEvent } from "#core/events";
import { reduceRunState, type RunState } from "#core/state";
import type { RunHandle } from "#core/runBatch.server";

export type Connection = "local" | "connecting" | "open" | "lost";

export interface StateSource {
  readonly initial: RunState;
  subscribe(cb: (s: RunState) => void): () => void;
  cancel?: (() => void) | undefined;
  readonly result?: Promise<unknown> | undefined;
  readonly connection?: Connection;
}

/** Drive the UI from an in-process batch. */
export function localSource(handle: RunHandle): StateSource {
  return {
    initial: handle.state,
    subscribe(cb) {
      return handle.onEvent(() => cb(handle.state));
    },
    cancel: () => handle.cancel(),
    result: handle.result,
    connection: "local",
  };
}

export interface RemoteSourceOptions {
  baseUrl: string;
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Drive the UI from the server's SSE stream.
 *
 * Every connection begins with a full `snapshot`, so a late joiner, or a
 * reconnect, is correct immediately without any replay buffer on the server.
 */
export function remoteSource(o: RemoteSourceOptions): StateSource & {
  start(): Promise<void>;
} {
  let state: RunState | null = null;
  let connection: Connection = "connecting";
  const listeners = new Set<(s: RunState) => void>();
  const doFetch = o.fetchImpl ?? fetch;

  const emit = () => {
    if (state !== null) for (const l of listeners) l(state);
  };

  async function start(): Promise<void> {
    while (!o.signal?.aborted) {
      try {
        const res = await doFetch(`${o.baseUrl}/api/events`, {
          headers: { accept: "text/event-stream" },
          ...(o.signal ? { signal: o.signal } : {}),
        });
        if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);
        connection = "open";

        for await (const frame of sseFrames(res.body)) {
          const payload = JSON.parse(frame) as
            | { type: "snapshot"; state: RunState }
            | { type: "patch"; event: RunEvent }
            | { type: string };

          if (payload.type === "snapshot" && "state" in payload) {
            state = payload.state;
            emit();
          } else if (payload.type === "patch" && "event" in payload) {
            if (state !== null) {
              state = reduceRunState(state, payload.event);
              emit();
            }
          }
        }
      } catch {
        // fall through to reconnect
      }
      if (o.signal?.aborted) break;
      connection = "lost";
      emit();
      await new Promise((r) => setTimeout(r, 3000));
      connection = "connecting";
    }
  }

  return {
    get initial() {
      return (
        state ?? {
          runId: "",
          startedAt: null,
          endedAt: null,
          cancelled: false,
          warmup: "pending",
          concurrency: 0,
          order: [],
          perms: {},
          summary: {
            total: 0,
            done: 0,
            running: 0,
            failed: 0,
            queued: 0,
            skipped: 0,
          },
          lastSeq: 0,
          mafiaBuild: null,
        }
      );
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    get connection() {
      return connection;
    },
    start,
  };
}

/** Split a byte stream into SSE `data:` payloads. */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (data !== "") yield data;
    }
  }
}
