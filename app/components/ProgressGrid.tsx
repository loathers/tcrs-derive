import {
  CLASS_ORDER,
  CLASS_LABELS,
  SIGNS,
  userFor,
} from "#core/permutations";
import type { RunState } from "#core/state";
import { PermutationCell } from "./PermutationCell.tsx";

/**
 * The 54-row problem, solved as a 6x9 matrix: classes down, signs across.
 *
 * That is literally the shape of the data (a class x sign product), it fits in
 * ~200px with no scrolling, and it reads at a glance. 54 stacked bars is the right
 * answer in a terminal, where the ink chart does exactly that, and the wrong one
 * on a web page.
 */
export function ProgressGrid({ state }: { state: RunState }) {
  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Class</span>
            </th>
            {SIGNS.map((sign) => (
              <th key={sign} scope="col" title={sign}>
                {sign.slice(0, 3)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CLASS_ORDER.map((abbr) => (
            <tr key={abbr}>
              <th scope="row">{CLASS_LABELS[abbr]}</th>
              {SIGNS.map((sign) => {
                const user = userFor(abbr, sign);
                const perm = state.perms[user];
                return (
                  <td key={sign}>
                    {perm ? (
                      <PermutationCell perm={perm} />
                    ) : (
                      <div className="cell cell-idle" />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
