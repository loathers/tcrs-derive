import type { DatasetSummary, FileListResponse } from "../lib/api-types.ts";
import { formatBytes, formatDuration } from "../lib/format.ts";
import { DownloadTable } from "./DownloadTable.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
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

      {/* Describes this data, so it belongs with it rather than in the header. */}
      {dataset !== null && (
        <p>
          Generated <RelativeTime iso={dataset.generatedAt} />.{" "}
          {dataset.fileCount} files, {formatBytes(dataset.totalBytes)}
          {dataset.durationMs !== null && (
            <>, took {formatDuration(dataset.durationMs)}</>
          )}
          . KoLmafia {dataset.mafiaBuild ?? "version unknown"}.
        </p>
      )}

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
