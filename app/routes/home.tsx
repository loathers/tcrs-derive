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

import { useFetcher, useRevalidator } from "react-router";
import { useEffect } from "react";
import type { Route } from "./+types/home";
import type { GenerateResponse } from "../lib/api-types.ts";
import { Header } from "../components/Header.tsx";
import { GenerateButton } from "../components/GenerateButton.tsx";
import { ProgressPanel } from "../components/ProgressPanel.tsx";
import { DownloadPanel } from "../components/DownloadPanel.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { useRunStream } from "../hooks/useRunStream.ts";

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
  const fetcher = useFetcher<GenerateResponse>();
  const revalidator = useRevalidator();

  // The stream owns live state. The loader owns the initial paint.
  const { status, connection } = useRunStream(loaderData.status);

  // When a run finishes, refresh the loader so the download table and the
  // last-generated time update without a page reload.
  const runId = status.run?.runId ?? null;
  useEffect(() => {
    if (runId === null && revalidator.state === "idle") revalidator.revalidate();
    // Only when a run transitions away from being active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const submitting = fetcher.state !== "idle";
  const error = fetcher.data && !fetcher.data.accepted ? fetcher.data : null;

  return (
    <main className="wrap">
      <Header
        status={status}
        connection={connection}
        permutationCount={status.permutationCount}
      />

      {/* Posts to the resource route, so it works without JS and matches the
          documented POST /api/generate API. */}
      <fetcher.Form method="post" action="/api/generate">
        <GenerateButton
          cooldown={status.cooldown}
          serverNow={status.now}
          running={status.run !== null}
          submitting={submitting}
        />
        {error && <GenerateError error={error} />}
      </fetcher.Form>

      {status.run !== null && <ProgressPanel run={status.run} />}

      {loaderData.files === null ? (
        <EmptyState
          configOk={status.configOk}
          missingPasswordCount={status.missingPasswordCount}
        />
      ) : (
        <DownloadPanel
          files={loaderData.files}
          dataset={status.dataset}
          stale={status.dataset?.stalePermutations ?? []}
        />
      )}

      <hr />
      <footer className="muted small">
        <p>
          Tab-separated: <code>id · name · size · ? · modifiers</code>. URLs are
          stable and support <code>ETag</code> and <code>Range</code>.
        </p>
        <p>
          <code>curl -O .../api/download/file/TCRS_Sauceror_Vole.txt</code>
        </p>
      </footer>
    </main>
  );
}

function GenerateError({
  error,
}: {
  error: Extract<GenerateResponse, { accepted: false }>;
}) {
  const message =
    error.error === "already_running"
      ? "Already running."
      : error.error === "cooldown"
        ? "Too soon."
        : error.error === "misconfigured"
          ? `Misconfigured: ${error.detail}`
          : "Not enough free disk.";
  return (
    <p className="error" role="alert">
      {message}
    </p>
  );
}
