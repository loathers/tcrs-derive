import type { FileListResponse } from "../lib/api-types.ts";
import { ClassSection } from "./ClassSection.tsx";

export function DownloadTable({
  files,
  stale,
}: {
  files: FileListResponse;
  stale: readonly string[];
}) {
  return (
    <div className="downloads">
      {/* All collapsed: 54 rows of links is a wall, and the reader knows which
          class they want. */}
      {files.groups.map((group) => (
        <ClassSection key={group.classToken} group={group} stale={stale} />
      ))}
    </div>
  );
}
