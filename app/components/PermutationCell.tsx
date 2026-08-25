import { rowView } from "#core/present";
import type { PermState } from "#core/state";

/**
 * One cell of the 6x9 grid.
 *
 * Uses the SHARED presenter, so the colour, fill and tooltip derive from exactly
 * the same RowView the ink chart renders as text.
 */
export function PermutationCell({ perm }: { perm: PermState }) {
  const view = rowView(perm);
  const label = `${perm.classLabel} / ${perm.signCap} — ${view.status}`;

  return (
    <div
      className={`cell cell-${view.tone}`}
      title={label}
      aria-label={label}
      style={
        view.tone === "active"
          ? {
              // Fill to pct with a gradient, so the cell doubles as a bar.
              backgroundImage: `linear-gradient(to right, var(--fill) ${view.pct}%, transparent ${view.pct}%)`,
            }
          : undefined
      }
    >
      <span className="cell-sign">{perm.signCap.slice(0, 3)}</span>
    </div>
  );
}
