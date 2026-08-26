/**
 * `tcrs` CLI entry point.
 *
 * Arg parsing is node:util.parseArgs, three commands and ~18 flags do not justify
 * a dependency, and the help text below is the whole cost.
 *
 * Exit codes: 0 all ok, 1 any failure, 130 cancelled, 2 usage/preflight error.
 */

import { parseArgs } from "node:util";
import { attachCommand } from "./commands/attach.tsx";
import { listCommand } from "./commands/list.ts";
import { runCommand } from "./commands/run.ts";

const HELP = `tcrs, batch-introspect KoLmafia TCRS data for every class x sign permutation

Usage:
  tcrs run [options]        introspect locally, with a live progress chart
  tcrs attach [options]     watch a run happening on the server
  tcrs list [options]       list the 54 permutations
  tcrs serve                start the web server (see: yarn start)

Run options:
  --only a,b                only these permutations (e.g. tt_wallaby,sc_vole)
  --exclude a,b             skip these permutations
  --resume                  skip permutations the published manifest calls complete
  --concurrency N           permutations in parallel (default 3)
  --jar PATH                KoLmafia jar (default: $JAR, else ./KoLmafia*.jar)
  --data-dir DIR            data root (default ./data)
  --timeout S               per-permutation seconds before the JVM is killed
  --login-timeout S         seconds to wait for introspecting to start
  --max-attempts N          login attempts per permutation
  --retry-backoff S         base seconds between attempts
  --stall-timeout S         kill a run that reports no progress for S seconds
  --skip-warmup             do not populate the shared data template
  --keep-workdirs           keep per-JVM work dirs for forensics
  --promote MODE            success | always | never (default success)
  --no-progress             plain line output instead of the chart
  --json                    NDJSON of the raw event stream on stdout

Attach options:
  --url URL                 server base URL (default http://127.0.0.1:3000)

List options:
  --check-env               report which PASSWORD_* variables are missing

Exit codes: 0 ok, 1 some permutation failed, 2 usage error, 130 cancelled.
`;

const options = {
	help: { type: "boolean", short: "h" },
	only: { type: "string" },
	exclude: { type: "string" },
	resume: { type: "boolean" },
	concurrency: { type: "string" },
	jar: { type: "string" },
	"data-dir": { type: "string" },
	timeout: { type: "string" },
	"login-timeout": { type: "string" },
	"max-attempts": { type: "string" },
	"retry-backoff": { type: "string" },
	"stall-timeout": { type: "string" },
	"skip-warmup": { type: "boolean" },
	"keep-workdirs": { type: "boolean" },
	promote: { type: "string" },
	"no-progress": { type: "boolean" },
	json: { type: "boolean" },
	url: { type: "string" },
	"check-env": { type: "boolean" },
} as const;

export type CliFlags = {
	[K in keyof typeof options]?: (typeof options)[K]["type"] extends "boolean"
		? boolean
		: string;
};

function parseFlags(argv: string[]) {
	return parseArgs({
		args: argv,
		options,
		allowPositionals: true,
		strict: true,
	});
}

async function main(argv: string[]): Promise<number> {
	let parsed: ReturnType<typeof parseFlags>;
	try {
		parsed = parseFlags(argv);
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n`);
		process.stderr.write(HELP);
		return 2;
	}

	const flags = parsed.values as CliFlags;
	const command = parsed.positionals[0];

	if (flags.help || command === undefined || command === "help") {
		process.stdout.write(HELP);
		return command === undefined && !flags.help ? 2 : 0;
	}

	switch (command) {
		case "run":
			return runCommand(flags);
		case "attach":
			return attachCommand(flags);
		case "list":
			return listCommand(flags);
		case "serve":
			process.stderr.write(
				"`tcrs serve` is the web server; run it with `yarn start` (or node ./server.js).\n",
			);
			return 2;
		default:
			process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e: unknown) => {
		process.stderr.write(
			`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
		);
		process.exitCode = 1;
	});
