/**
 * The terminal's height, kept current.
 *
 * `measureElement` measures ink boxes, not the terminal, wrong tool. Reading the
 * height once at startup means a mid-run resize corrupts the display permanently,
 * so this recomputes on resize.
 */
import { useEffect, useState } from "react";

export function useTerminalRows(fallback = 24): number {
	const [rows, setRows] = useState(process.stdout.rows || fallback);

	useEffect(() => {
		const onResize = () => setRows(process.stdout.rows || fallback);
		process.stdout.on("resize", onResize);
		return () => {
			process.stdout.off("resize", onResize);
		};
	}, [fallback]);

	return rows;
}
