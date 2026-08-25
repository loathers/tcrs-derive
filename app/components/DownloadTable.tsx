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
      {files.groups.map((group, i) => (
        <ClassSection
          key={group.classToken}
          group={group}
          open={i === 0}
          stale={stale}
        />
      ))}
    </div>
  );
}
