/** Mount the ink app for a local run. */
import { render } from "ink";
import type { RunHandle } from "#core/runBatch.server";
import { App } from "./App.tsx";
import { localSource } from "./StateSource.ts";

export async function renderChart(handle: RunHandle): Promise<void> {
	const instance = render(<App source={localSource(handle)} />, {
		// MANDATORY. The default exits immediately on Ctrl-C and ORPHANS every JVM;
		// App routes it through source.cancel() instead and waits for teardown.
		exitOnCtrlC: false,
	});
	await instance.waitUntilExit();
}
