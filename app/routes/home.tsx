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
import { useEffect, useRef } from "react";
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

  const submitting = fetcher.state !== "idle";
  // A rejection means this page was out of date, so resync rather than reporting
  // it. The button is disabled during a cooldown and a live run shows its own
  // panel, so "too soon" and "already running" tell the reader nothing new.
  const rejected = fetcher.data && !fetcher.data.accepted ? fetcher.data : null;
  useEffect(() => {
    if (rejected && revalidator.state === "idle") revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rejected?.error]);

  // Only what the reader cannot work out from the page itself.
  const blocker =
    rejected &&
    (rejected.error === "misconfigured" ||
      rejected.error === "insufficient_disk")
      ? rejected
      : null;

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
        {blocker && <GenerateError error={blocker} />}
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

    </main>
  );
}

function GenerateError({
  error,
}: {
  error: Extract<
    GenerateResponse,
    { accepted: false; error: "misconfigured" | "insufficient_disk" }
  >;
}) {
  return (
    <p className="error" role="alert">
      {error.error === "misconfigured"
        ? `Cannot run: ${error.detail}`
        : "Cannot run: not enough free disk."}
    </p>
  );
}
