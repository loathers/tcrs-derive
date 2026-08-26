/** The `Overall: 12/54 done  (...)` line (run-all.sh:204-205). */
import { Text } from "ink";
import { summaryLine } from "#core/present";
import type { RunSummary } from "#core/state";

export function OverallSummary({
	summary,
	suffix = "",
}: {
	summary: RunSummary;
	suffix?: string;
}) {
	return (
		<Text bold>
			{summaryLine(summary)}
			{suffix}
		</Text>
	);
}
