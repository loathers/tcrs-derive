import type { Connection } from "../hooks/useRunStream.ts";
import type { StatusResponse } from "../lib/api-types.ts";
import { formatBytes, formatAbsolute } from "../lib/format.ts";
import { Badge } from "./Badge.tsx";
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
    <header className="header">
      <div>
        <h1>TCRS data</h1>
        <p className="muted">
          KoLmafia Two Crazy Random Summer item modifiers, for all{" "}
          {permutationCount} class &times; sign permutations.
        </p>
      </div>

      <dl className="meta">
        <div>
          <dt>Last generated</dt>
          <dd>
            {d === null ? (
              <span className="muted">Never</span>
            ) : (
              <>
                <RelativeTime iso={d.generatedAt} />{" "}
                <span className="muted">({formatAbsolute(d.generatedAt)})</span>
              </>
            )}
          </dd>
        </div>

        {d !== null && (
          <div>
            <dt>Dataset</dt>
            <dd>
              {d.fileCount} files &middot; {formatBytes(d.totalBytes)}
              {d.outcome === "partial" && (
                <>
                  {" "}
                  <Badge tone="warn" title="Some permutations failed this run">
                    partial
                  </Badge>
                </>
              )}
              {d.stalePermutations.length > 0 && (
                <>
                  {" "}
                  <Badge
                    tone="warn"
                    title={`Carried forward from an earlier run: ${d.stalePermutations.join(", ")}`}
                  >
                    {d.stalePermutations.length} stale
                  </Badge>
                </>
              )}
            </dd>
          </div>
        )}

        {d?.mafiaBuild != null && (
          <div>
            <dt>KoLmafia</dt>
            <dd>
              <code>{d.mafiaBuild}</code>
            </dd>
          </div>
        )}
      </dl>

      {connection === "polling" && (
        <p className="muted small">
          Live updates unavailable — polling every 5s.
        </p>
      )}
    </header>
  );
}
