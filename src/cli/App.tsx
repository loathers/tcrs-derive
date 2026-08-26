/**
 * The ink app. Renders a StateSource, so `tcrs run` and `tcrs attach` share this
 * component tree verbatim, the only difference is where the RunState comes from.
 *
 * ink's reconciler diffs frames, so none of the usual terminal-chart machinery is
 * here: no cursor-up redraw, no erase-to-EOL, no fixed-frame-height contract, and
 * no cursor hide/show trap.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { Chart } from "./components/Chart.tsx";
import { CompactChart } from "./components/CompactChart.tsx";
import { useStateSource } from "./hooks/useStateSource.ts";
import { useTerminalRows } from "./hooks/useTerminalRows.ts";
import type { StateSource } from "./StateSource.ts";

export function App({ source }: { source: StateSource }) {
	const state = useStateSource(source);
	const rows = useTerminalRows();
	const { exit } = useApp();
	const [cancelling, setCancelling] = useState(false);
	const [forceCompact, setForceCompact] = useState(false);

	// Ctrl-C / q: cancel, then let the run tear its JVMs down before unmounting.
	// ink's default exitOnCtrlC would exit IMMEDIATELY and orphan every JVM, which
	// is why render() passes exitOnCtrlC: false. The single easiest thing here to
	// get wrong.
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
			{compact ? (
				<CompactChart state={state} rows={rows - 2} />
			) : (
				<Chart state={state} />
			)}
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
