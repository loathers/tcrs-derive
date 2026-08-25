import type { DatasetSummary } from "../lib/api-types.ts";
import { formatBytes } from "../lib/format.ts";

/**
 * A plain anchor, not a fetch() — so the browser gives native download progress,
 * resume, and "save as" for a ~14MB file.
 */
export function ZipButton({ dataset }: { dataset: DatasetSummary }) {
  if (dataset.zip === null) {
    return (
      <p className="muted small">
        The combined archive is unavailable for this run; individual files below
        still work.
      </p>
    );
  }
  return (
    <a className="primary" href={dataset.zip.url} download>
      Download all &middot; {formatBytes(dataset.zip.bytes)} (zip)
    </a>
  );
}
