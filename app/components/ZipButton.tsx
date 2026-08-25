import type { DatasetSummary } from "../lib/api-types.ts";
import { formatBytes } from "../lib/format.ts";

/** A plain anchor, so the browser handles progress, resume and "save as". */
export function ZipButton({ dataset }: { dataset: DatasetSummary }) {
  if (dataset.zip === null) {
    return <p className="muted small">Zip unavailable for this run.</p>;
  }
  return (
    <p>
      <a href={dataset.zip.url} download>
        Download all {dataset.fileCount} files
      </a>{" "}
      ({formatBytes(dataset.zip.bytes)} zip)
    </p>
  );
}
