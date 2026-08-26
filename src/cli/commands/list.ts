/**
 * `tcrs list`, the 54 permutations, and optionally which passwords are missing.
 *
 * `--check-env` is the preflight the bash lacked: it discovered a missing password
 * inside run-one.sh:20, so one .env typo failed one permutation 40 minutes into a
 * batch.
 */

import { loadSecrets } from "#core/env.server";
import { ALL_PERMUTATIONS } from "#core/permutations";
import type { CliFlags } from "../index.ts";

export function listCommand(flags: CliFlags): number {
	const out = (l: string) => process.stdout.write(`${l}\n`);

	if (!flags["check-env"]) {
		out(`${ALL_PERMUTATIONS.length} permutations (class x sign):`);
		out("");
		for (const p of ALL_PERMUTATIONS) {
			out(`  ${p.user.padEnd(14)} ${p.classToken} / ${p.signCap}`);
		}
		out("");
		out("Add --check-env to see which PASSWORD_* variables are missing.");
		return 0;
	}

	const secrets = loadSecrets();
	const missing = secrets.missingFor(ALL_PERMUTATIONS);

	out(
		`${ALL_PERMUTATIONS.length - missing.length}/${ALL_PERMUTATIONS.length} permutations have a password.`,
	);
	if (missing.length === 0) {
		out("All set.");
		return 0;
	}
	out("");
	out("Missing:");
	for (const v of missing) out(`  ${v}`);
	out("");
	out("Set them in .env (see .env.example) or in the environment.");
	return 1;
}
