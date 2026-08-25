/**
 * The ink app. Renders a StateSource, so `tcrs run` and `tcrs attach` share this
 * component tree verbatim, the only difference is where the RunState comes from.
 *
 * What ink deletes relative to the bash: the cursor-up `\x1b[%dA` redraw, the
 * erase-to-EOL on every line, the fixed-frame-height contract, and the cursor
 * hide/show plus its EXIT trap, roughly 40 lines of ANSI arithmetic in
 * run-all.sh:129-273. ink's reconciler diffs frames for us.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { RunState } from "#core/state";
import { Chart } from "./components/Chart.tsx";
import { CompactChart } from "./components/CompactChart.tsx";
import { useTerminalRows } from "./hooks/useTerminalRows.ts";
import { useStateSource } from "./hooks/useStateSource.ts";
import type { StateSource } from "./StateSource.ts";

export function App({ source }: { source: StateSource }) {
  const state = useStateSource(source);
  const rows = useTerminalRows();
  const { exit } = useApp();
  const [cancelling, setCancelling] = useState(false);
  const [forceCompact, setForceCompact] = useState(false);

  // Ctrl-C / q: cancel, then let the run tear its JVMs down before unmounting.
  // ink's default exitOnCtrlC would exit IMMEDIATELY and orphan every JVM, which
  // is why render() passes exitOnCtrlC: false. This is the analogue of the bash's
  // stop_all trap and the single easiest thing to get wrong in this port.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      requestCancel();
    } else if (input === "q") {
      requestCancel();
    } else if (input === "f") {
      setForceCompact((v) => !v);
    }
  });

  function requestCancel() {
    if (cancelling) {
      // A second Ctrl-C means "I really mean it".
      exit();
      return;
    }
    setCancelling(true);
    source.cancel?.();
  }

  useEffect(() => {
    let alive = true;
    source.result
      ?.then(() => {
        if (alive) exit();
      })
      .catch(() => {
        if (alive) exit();
      });
    return () => {
      alive = false;
    };
  }, [source, exit]);

  const needed = state.order.length + 1 + (cancelling ? 1 : 0);
  const compact = forceCompact || needed > rows - 1;

  return (
    <Box flexDirection="column">
      {state.warmup === "running" && (
        <Text dimColor>Warming up shared data files…</Text>
      )}
      {compact ? <CompactChart state={state} rows={rows - 2} /> : <Chart state={state} />}
      {cancelling && (
        <Text color="yellow">
          Interrupted, stopping all permutations (Ctrl-C again to force)…
        </Text>
      )}
      {source.connection === "lost" && (
        <Text color="yellow">Connection lost, reconnecting…</Text>
      )}
    </Box>
  );
}

export type { RunState };
