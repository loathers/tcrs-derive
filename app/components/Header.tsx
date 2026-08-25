import type { Connection } from "../hooks/useRunStream.ts";
import type { StatusResponse } from "../lib/api-types.ts";
import { formatBytes, formatAbsolute, formatDuration } from "../lib/format.ts";
import { RelativeTime } from "./RelativeTime.tsx";

export function Header({
  status,
  connection,
  permutationCount,
}: {
  status: StatusResponse;
  connection: Connection;
  permutationCount: number;
}) {
  const d = status.dataset;

  return (
    <header>
      <h1>TCRS data</h1>
      <p>
        KoLmafia TCRS item modifiers for all {permutationCount} class &times;
        sign combinations.
      </p>

      {d === null ? (
        <p>Never generated.</p>
      ) : (
        <p>
          Generated <RelativeTime iso={d.generatedAt} /> (
          {formatAbsolute(d.generatedAt)}). {d.fileCount} files,{" "}
          {formatBytes(d.totalBytes)}
          {d.durationMs !== null && <>, took {formatDuration(d.durationMs)}</>}.
          KoLmafia {d.mafiaBuild ?? "version unknown"}.
        </p>
      )}

      {connection === "polling" && (
        <p className="muted small">
          Live updates blocked. Polling every 5s.
        </p>
      )}
    </header>
  );
}
