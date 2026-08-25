import type { DatasetSummary, FileListResponse } from "../lib/api-types.ts";
import { DownloadTable } from "./DownloadTable.tsx";
import { ZipButton } from "./ZipButton.tsx";

export function DownloadPanel({
  files,
  dataset,
  stale,
}: {
  files: FileListResponse;
  dataset: DatasetSummary | null;
  stale: readonly string[];
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Downloads</h2>
        {dataset !== null && <ZipButton dataset={dataset} />}
      </div>
      {stale.length > 0 && (
        <p className="muted small">
          {stale.length} permutation{stale.length === 1 ? "" : "s"} could not be
          re-derived in the latest run, so the previous data is served for
          {stale.length === 1 ? " it" : " them"} — marked{" "}
          <em>stale</em> below.
        </p>
      )}
      <DownloadTable files={files} stale={stale} />
      {files.sums !== null && (
        <p className="muted small">
          Checksums: <a href={files.sums.url}>{files.sums.name}</a> (also included
          in the zip).
        </p>
      )}
    </section>
  );
}
