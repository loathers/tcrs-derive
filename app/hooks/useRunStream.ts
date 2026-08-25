/**
 * The live status stream.
 *
 * THE PAYOFF OF THE PURE REDUCER: a `patch` event is folded with the core's own
 * reduceRunState, the very same function the server and the ink CLI use. The
 * browser therefore has zero bespoke progress logic and cannot drift from the
 * terminal chart.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import { reduceRunState } from "#core/state";
import type { ServerEvent, StatusResponse } from "../lib/api-types.ts";

export type Connection = "connecting" | "open" | "polling";

interface State {
  status: StatusResponse;
  connection: Connection;
}

type Action =
  | { kind: "server"; event: ServerEvent }
  | { kind: "status"; status: StatusResponse }
  | { kind: "connection"; connection: Connection };

function reduce(state: State, action: Action): State {
  switch (action.kind) {
    case "connection":
      return { ...state, connection: action.connection };

    case "status":
      return { ...state, status: action.status };

    case "server": {
      const event = action.event;
      switch (event.type) {
        case "snapshot":
        case "run-started":
        case "run-finished":
          return { ...state, status: event.status };

        case "patch": {
          const run = state.status.run;
          // A patch for a run we are not tracking (a stale stream after a restart)
          // is ignored until the next snapshot arrives.
          if (run === null || run.runId !== event.runId) return state;
          return {
            ...state,
            status: {
              ...state.status,
              run: { ...run, state: reduceRunState(run.state, event.event) },
            },
          };
        }

        default:
          return state;
      }
    }
  }
}

export function useRunStream(initial: StatusResponse) {
  const [state, dispatch] = useReducer(reduce, {
    status: initial,
    connection: "connecting" as Connection,
  });

  /**
   * Until this flips, callers see EXACTLY what the server rendered.
   *
   * Hydration compares the first client render against the server HTML, and React
   * cannot patch mismatched attributes. Any live input reaching that first render
   * is therefore a bug, and this stream is live by definition: a snapshot can
   * arrive while hydration is still in flight and change the tree underneath it.
   * Gating on mount makes the first render deterministic by construction, which
   * is cheaper than auditing every consumer for non-determinism.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Buffer patches and flush on an animation frame. A burst from several
  // concurrent JVMs would otherwise re-render 54 cells per event. Only the folded
  // state is kept, so a tab left open for a whole run has flat memory.
  const pending = useRef<ServerEvent[]>([]);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    let failures = 0;
    let poller: ReturnType<typeof setInterval> | null = null;
    let source: EventSource | null = null;
    let closed = false;

    const flush = () => {
      frame.current = null;
      const batch = pending.current;
      pending.current = [];
      for (const event of batch) dispatch({ kind: "server", event });
    };

    const enqueue = (event: ServerEvent) => {
      pending.current.push(event);
      if (frame.current === null) {
        frame.current = requestAnimationFrame(flush);
      }
    };

    const startPolling = () => {
      if (poller !== null) return;
      dispatch({ kind: "connection", connection: "polling" });
      poller = setInterval(() => {
        void fetch("/api/status")
          .then((r) => (r.ok ? r.json() : null))
          .then((status: StatusResponse | null) => {
            if (status && !closed) dispatch({ kind: "status", status });
          })
          .catch(() => {});
      }, 5000);
    };

    const connect = () => {
      source = new EventSource("/api/events");

      source.onopen = () => {
        failures = 0;
        dispatch({ kind: "connection", connection: "open" });
      };

      source.onmessage = (e: MessageEvent<string>) => {
        try {
          enqueue(JSON.parse(e.data) as ServerEvent);
        } catch {
          // A malformed frame must never break the stream.
        }
      };

      source.onerror = () => {
        // EventSource reconnects on its own. After several failures assume the
        // stream is being blocked (a proxy eating text/event-stream) and poll.
        failures += 1;
        if (failures >= 3) {
          source?.close();
          source = null;
          startPolling();
        } else {
          dispatch({ kind: "connection", connection: "connecting" });
        }
      };
    };

    connect();

    return () => {
      closed = true;
      source?.close();
      if (poller !== null) clearInterval(poller);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return {
    status: mounted ? state.status : initial,
    connection: mounted ? state.connection : "connecting",
  };
}
