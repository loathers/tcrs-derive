/**
 * Subscribe to a StateSource, coalescing renders to ~10fps.
 *
 * The one performance thing ink does not do for you: concurrent JVMs burst
 * `Progress:` lines, and re-rendering 54 rows per event is pure waste. A mutable
 * ref plus an interval folds a burst into one frame.
 */
import { useEffect, useRef, useState } from "react";
import type { RunState } from "#core/state";
import type { StateSource } from "../StateSource.ts";

export function useStateSource(source: StateSource, fps = 10): RunState {
  const [state, setState] = useState<RunState>(source.initial);
  const latest = useRef<RunState>(source.initial);

  useEffect(() => {
    const unsubscribe = source.subscribe((s) => {
      latest.current = s;
    });
    const timer = setInterval(() => {
      setState((current) =>
        current === latest.current ? current : latest.current,
      );
    }, Math.round(1000 / fps));

    return () => {
      unsubscribe();
      clearInterval(timer);
      // Flush the final frame, so the last state is what stays in scrollback.
      setState(latest.current);
    };
  }, [source, fps]);

  return state;
}
