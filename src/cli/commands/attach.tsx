/**
 * `tcrs attach` — watch a run happening on the server.
 *
 * Renders the IDENTICAL App as `tcrs run`; only the StateSource differs. Someone
 * else may have started the run from the web UI, which is exactly the case this
 * command exists for.
 */

import { render } from "ink";
import type { CliFlags } from "../index.ts";
import { App } from "../App.tsx";
import { remoteSource } from "../StateSource.ts";

export async function attachCommand(flags: CliFlags): Promise<number> {
  const baseUrl = (flags.url ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const controller = new AbortController();

  const source = remoteSource({ baseUrl, signal: controller.signal });

  // Verify the server is reachable before clearing the screen for a chart.
  try {
    const res = await fetch(`${baseUrl}/api/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    process.stderr.write(
      `Cannot reach ${baseUrl}: ${e instanceof Error ? e.message : String(e)}\n` +
        `Is the server running? Start it with \`yarn start\`.\n`,
    );
    return 2;
  }

  void source.start();

  const instance = render(<App source={source} />, { exitOnCtrlC: false });
  const onSignal = () => {
    controller.abort();
    instance.unmount();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  await instance.waitUntilExit();
  controller.abort();
  return 0;
}
