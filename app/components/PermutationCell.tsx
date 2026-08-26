import { memo } from "react";
import { cellLabel, progressPercent, rowView } from "#core/present";
import type { PermState } from "#core/state";

/**
 * One cell of the 6x9 grid.
 *
 * Tone and status text come from the SHARED presenter, so the grid and the ink
 * chart cannot drift on what a state means. The fill uses progressPercent rather
 * than rowView's pct because the two media render progress differently: the ink
 * bar shows a full block during the cafe phases to match the original shell
 * chart, whereas this cell shows a number, and a gradient at 100% beside a label
 * reading 99% is the inconsistency that separation is here to avoid.
 */
export const PermutationCell = memo(function PermutationCell({
	perm,
}: {
	perm: PermState;
}) {
	const view = rowView(perm);
	const pct = progressPercent(perm);
	const label = `${perm.classLabel} / ${perm.signCap}: ${view.status}`;

	return (
		<div
			className={`cell cell-${view.tone}`}
			role="img"
			title={label}
			aria-label={label}
			style={
				view.tone === "active"
					? {
							backgroundImage: `linear-gradient(to right, var(--fill) ${pct}%, transparent ${pct}%)`,
						}
					: undefined
			}
		>
			{cellLabel(perm)}
		</div>
	);
});

/*
 * memo is load-bearing here, not decoration. reduceRunState structurally shares
 * every PermState it did not touch, so 53 of these 54 props are reference-equal
 * after each event. Without memo, ~8000 events per run each re-render all 54.
 */
