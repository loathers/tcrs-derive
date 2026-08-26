import { memo } from "react";
import type { ClassGroup } from "../lib/api-types.ts";
import { FILE_KIND_LABELS } from "#core/permutations";
import { formatBytes } from "../lib/format.ts";
import { Badge } from "./Badge.tsx";

/**
 * One collapsible class: a 9-row table, one row per sign.
 *
 * This is the 162-link problem solved. Six <details> sections mirror the 6x9 grid
 * above, and every cell is a plain <a download> so right-click / curl / download
 * managers all behave normally.
 */
export const ClassSection = memo(function ClassSection({
  group,
  stale,
}: {
  group: ClassGroup;
  stale: readonly string[];
}) {
  const staleSet = new Set(stale);
  return (
    <details className="class-section">
      <summary>
        {group.classLabel}
      </summary>
      <div className="table-scroll">
        <table className="files">
          <thead>
            <tr>
              <th scope="col">Sign</th>
              <th scope="col">{FILE_KIND_LABELS.items}</th>
              <th scope="col">{FILE_KIND_LABELS.cafe_booze}</th>
              <th scope="col">{FILE_KIND_LABELS.cafe_food}</th>
            </tr>
          </thead>
          <tbody>
            {group.permutations.map((p) => (
                <tr key={p.user}>
                  <th scope="row">
                    {p.sign}
                    {staleSet.has(p.user) && (
                      <>
                        {" "}
                        <Badge title={`From run ${p.sourceRunId}`}>old</Badge>
                      </>
                    )}
                  </th>
                  {p.files.map((f) => (
                    <td key={f.kind}>
                      {/* The size is the link text: repeating the column header
                          would tell the reader nothing they cannot already see,
                          whereas the sizes differ by orders of magnitude (items
                          ~930KB vs ~2KB for the cafe files). The aria-label
                          restores the context a screen reader loses when tabbing
                          between links out of table order. */}
                      <a
                        href={f.url}
                        download
                        aria-label={`${f.name} (${formatBytes(f.bytes)})`}
                        title={f.name}
                      >
                        {formatBytes(f.bytes)}
                      </a>
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </details>
  );
});
