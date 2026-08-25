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
    <section>
      <h2>Downloads</h2>
      {dataset !== null && <ZipButton dataset={dataset} />}
      {stale.length > 0 && (
        <p className="muted small">
          {stale.length} marked <em>old</em> failed the last run and are carried
          over from the previous one.
        </p>
      )}
      <DownloadTable files={files} stale={stale} />
      {files.sums !== null && (
        <p className="small">
          Checksums: <a href={files.sums.url}>{files.sums.name}</a>
        </p>
      )}
    </section>
  );
}
