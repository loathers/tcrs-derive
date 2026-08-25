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
      <p className="muted small">
        Three files per combination: items, cafe booze, cafe food. Goes in
        KoLmafia&rsquo;s <code>data/</code>.
        {stale.length > 0 && (
          <>
            {" "}
            {stale.length} marked <em>old</em> failed the last run and are
            carried over from the previous one.
          </>
        )}
      </p>
      <DownloadTable files={files} stale={stale} />
      {files.sums !== null && (
        <p className="small">
          <a href={files.sums.url}>{files.sums.name}</a> &mdash;{" "}
          <code>sha256sum -c</code> to verify.
        </p>
      )}
    </section>
  );
}
