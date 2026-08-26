/**
 * The whole site.
 *
 * The loader supplies status + the file listing SERVER-SIDE, so the first paint
 * already shows the correct last-generated time, cooldown and download table, no
 * spinner, no client fetch on load.
 *
 * The action triggers a run. Being a real form post, it works without JavaScript
 * and gets 409/429 semantics for free.
 */

import { useRevalidator } from "react-router";
import { useEffect, useRef } from "react";
import type { Route } from "./+types/home";
import { Header } from "../components/Header.tsx";
import { GenerateButton } from "../components/GenerateButton.tsx";
import { ResetCooldownButton } from "../components/ResetCooldownButton.tsx";
import { ProgressPanel } from "../components/ProgressPanel.tsx";
import { DownloadPanel } from "../components/DownloadPanel.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { useRunStream } from "../hooks/useRunStream.ts";
import { ServerNowProvider } from "../lib/server-now.ts";

/** Stable identity: a fresh [] each render would defeat the memo below it. */
const NO_STALE: readonly string[] = [];

export function meta(_: Route.MetaArgs) {
  return [
    { title: "TCRS data" },
    {
      name: "description",
      content:
        "Downloadable KoLmafia Two Crazy Random Summer item-modifier data for all 54 class and sign permutations.",
    },
  ];
}

export async function loader(_: Route.LoaderArgs) {
  // Imported inside the loader so the client bundle never pulls in server code.
  const { getRunManager } = await import("#server/singleton.server");
  const { buildFileList } = await import("#server/files.server");
  const { resolveBatchConfig } = await import("#core/config.server");

  const manager = await getRunManager();
  const [status, files] = await Promise.all([
    manager.status(),
    buildFileList(resolveBatchConfig().dataDir),
  ]);
  return { status, files };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const revalidator = useRevalidator();

  // The stream owns live state. The loader owns the initial paint.
  const { status, connection } = useRunStream(loaderData.status);

  // When a run FINISHES, refresh the loader so the download table and the
  // last-generated time update without a page reload. Keyed on the transition,
  // not on the current value: `runId === null` is also true on first load, so a
  // plain check revalidated once on every page view for nothing.
  const runId = status.run?.runId ?? null;
  const previousRunId = useRef(runId);
  useEffect(() => {
    const ended = previousRunId.current !== null && runId === null;
    previousRunId.current = runId;
    if (ended && revalidator.state === "idle") revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return (
    <ServerNowProvider value={status.now}>
      <main className="wrap">
        <Header
          connection={connection}
          permutationCount={status.permutationCount}
        />

        {loaderData.files === null ? (
          <EmptyState
            configOk={status.configOk}
            missingPasswordCount={status.missingPasswordCount}
            permutationCount={status.permutationCount}
          />
        ) : (
          <DownloadPanel
            files={loaderData.files}
            dataset={status.dataset}
            stale={status.dataset?.stalePermutations ?? NO_STALE}
          />
        )}

        {/* One section, two bodies. While a run is happening the progress replaces
          the controls rather than appearing below them. */}
        {status.run !== null ? (
          <ProgressPanel run={status.run} dev={status.dev} />
        ) : (
          <GenerateButton
            cooldown={status.cooldown}
            serverNow={status.now}
            extra={status.dev ? <ResetCooldownButton /> : null}
          />
        )}
      </main>
    </ServerNowProvider>
  );
}
