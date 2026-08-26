#!/usr/bin/env node
/**
 * A stand-in for the KoLmafia JVM, so runOne can be tested with no Java, no
 * network and no KoL account. This is the highest-leverage test asset in the repo:
 * it exercises the real spawn/pipe plumbing, the 'close'-vs-'exit' race, both
 * watchdogs, process-group killing, collect, discard-partials and retry.
 *
 * Invoked exactly as runOne invokes java, i.e.
 *   fake-java.mjs [--fake-*=...] -Djava.awt.headless=true -DuseCWDasROOT=true \
 *                 -jar <path> --CLI
 * All real JVM args are ignored. Configuration arrives as `--fake-*` flags, which
 * runOne passes through its `javaOpts` option (the same channel production uses for
 * -Xmx512m). Env vars would not work: runOne deliberately spawns with a minimal
 * allow-listed environment.
 *
 * Flags:
 *   --fake-fixture=NAME     replay tests/fixtures/logs/NAME.log (default: happy).
 *                           Comma-separated with --fake-run-log to vary by attempt.
 *   --fake-run-log=PATH     count invocations here, so --fake-fixture can be a list
 *   --fake-files=N          write N of the 3 TCRS files into ./data (default: 3).
 *                           Also comma-separated per attempt.
 *   --fake-perm=USER        which permutation's filenames to write (default derived
 *                           from the fixture's own "Wrote file" lines)
 *   --fake-exit=N           exit code (default 0)
 *   --fake-delay=MS         delay between emitted lines (default 0)
 *   --fake-truncate-at=N    stop replaying after the Progress: line reaching >= N
 *   --fake-stop-after=N     stop replaying after N lines, then idle
 *   --fake-hang-at-login    emit the pre-login banner then idle forever
 *   --fake-ignore-sigterm   ignore SIGTERM, forcing the TERM -> 3s -> KILL path
 *   --fake-spawn-grandchild spawn a child that outlives us unless the process
 *                           GROUP is killed — proves kill(-pgid) reaps descendants
 *   --fake-empty-file       write a zero-byte first file (tests the [ -s ] rule)
 *   --fake-subdir           write into data/TCRS/ instead of data/, as r29183+ does
 */

import { spawn } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function flag(name, fallback = undefined) {
	const hit = process.argv.find((a) => a.startsWith(`--fake-${name}=`));
	if (hit) return hit.slice(`--fake-${name}=`.length);
	return process.argv.includes(`--fake-${name}`) ? true : fallback;
}

/**
 * --fake-fixture and --fake-files take a COMMA-SEPARATED LIST, and with
 * --fake-run-log the Nth invocation uses the Nth entry (the last one repeating).
 * That is the only way to make a retry sequence behave differently on its second
 * attempt: every other flag is fixed for the life of the run, and seedWorkdir wipes
 * the work dir between attempts, so the counter has to live outside it.
 *
 * The counter is per-PROCESS-START, so a run with the warm-up enabled spends the
 * first entry on the warm-up. Tests using this either skip the warm-up or account
 * for it.
 */
const runLog = flag("run-log");
let invocation = 0;
if (runLog) {
	try {
		invocation = readFileSync(runLog, "utf8").length;
	} catch {
		invocation = 0; // first time through
	}
	appendFileSync(runLog, "x");
}
/** The entry for this invocation, the last one repeating once the list runs out. */
function nth(raw) {
	const parts = String(raw).split(",");
	return parts[Math.min(invocation, parts.length - 1)];
}

const fixture = nth(flag("fixture", "happy"));
const fileCount = Number(nth(flag("files", "3")));
const exitCode = Number(flag("exit", "0"));
const delayMs = Number(flag("delay", "0"));
const truncateAt = flag("truncate-at") ? Number(flag("truncate-at")) : null;
const stopAfter = flag("stop-after") ? Number(flag("stop-after")) : null;
const hangAtLogin = flag("hang-at-login") === true;
const ignoreSigterm = flag("ignore-sigterm") === true;
const spawnGrandchild = flag("spawn-grandchild") === true;
const emptyFile = flag("empty-file") === true;
// r29183+ writes into a TCRS/ subdirectory of the data dir; older jars wrote flat.
const subdir = flag("subdir") === true;

if (ignoreSigterm) {
	process.on("SIGTERM", () => {});
	process.on("SIGINT", () => {});
}

if (spawnGrandchild) {
	// A long-lived descendant in OUR process group. Killing only our pid leaves it
	// running; killing the group reaps it. The test asserts the latter.
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], {
		stdio: "ignore",
	});
	child.unref();
	process.stdout.write(`fake-java: grandchild pid ${child.pid}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Idle forever. A bare `new Promise(() => {})` is NOT enough: Node exits as soon
 * as the event loop has no pending handles, so the process would terminate
 * immediately and the watchdog under test would never fire. A long interval keeps
 * the loop alive until we are signalled.
 */
function idleForever() {
	const hold = setInterval(() => {}, 1_000_000);
	return new Promise(() => {
		void hold;
	});
}

async function main() {
	// Drain stdin so the writer's end() resolves, and verify the command sequence.
	const stdin = await readAll(process.stdin);
	const lines = stdin.split("\n");
	// [user, password, no, no, tcrs reset, tcrs derive, tcrs save, exit]
	writeFileSync(join(process.cwd(), "stdin-received.txt"), stdin);

	if (hangAtLogin) {
		process.stdout.write("KoLmafia r29131-M\n");
		process.stdout.write("username: password: ");
		await idleForever(); // the login watchdog must fire
	}

	const log = readFileSync(join(HERE, "logs", `${fixture}.log`), "utf8");
	let emitted = 0;
	for (const line of log.split("\n")) {
		// The `=== attempt N/M ===` marker is a harness artifact, not mafia output.
		if (line.startsWith("=== attempt ")) continue;

		// Rewrite the fixture's "Wrote file" lines to match the layout being emulated.
		const wrote = /^Wrote file (?:TCRS\/)?(TCRS_\S+\.txt)$/.exec(line);
		process.stdout.write(
			`${wrote ? `Wrote file ${subdir ? "TCRS/" : ""}${wrote[1]}` : line}\n`,
		);
		emitted++;

		if (stopAfter !== null && emitted >= stopAfter) {
			await idleForever(); // the hard/stall timeout must fire
		}
		if (truncateAt !== null) {
			const m = /^Progress: (\d+)\//.exec(line);
			if (m && Number(m[1]) >= truncateAt) break;
		}
		if (delayMs > 0) await sleep(delayMs);
	}

	writeDataFiles(log, lines[0]?.trim());
	process.exitCode = exitCode;
}

const CLASS_TOKENS = {
	sc: "Seal_Clubber",
	tt: "Turtle_Tamer",
	pm: "Pastamancer",
	sa: "Sauceror",
	db: "Disco_Bandit",
	at: "Accordion_Thief",
};

/**
 * Write N of the three files mafia would have saved, into ./data.
 *
 * The filenames are derived from the USERNAME RECEIVED ON STDIN, exactly as real
 * mafia writes files for whoever logged in. Deriving them from the fixture's own
 * "Wrote file" lines instead would pin every test to the one permutation the
 * fixture happened to come from.
 */
function writeDataFiles(log, user) {
	const explicit = flag("perm");
	let names;
	if (explicit) {
		names = suffixed(explicit);
	} else if (user && /^[a-z]{2}_[a-z]+$/.test(user)) {
		const [abbr, sign] = user.split("_");
		const token = CLASS_TOKENS[abbr];
		const signCap = sign.charAt(0).toUpperCase() + sign.slice(1);
		names = token ? suffixed(`${token}_${signCap}`) : [];
	} else {
		// No usable username (e.g. the warm-up's empty login): fall back to the
		// fixture's own "Wrote file" lines.
		names = [...log.matchAll(/^Wrote file (TCRS_\S+\.txt)/gm)].map((m) => m[1]);
	}
	if (names.length === 0) return;

	const dataDir = subdir
		? join(process.cwd(), "data", "TCRS")
		: join(process.cwd(), "data");
	mkdirSync(dataDir, { recursive: true });
	for (let i = 0; i < Math.min(fileCount, names.length); i++) {
		const body =
			emptyFile && i === 0
				? ""
				: `1\tfake item\t0\t\t\n2\tanother fake item\t0\t\t\n`;
		writeFileSync(join(dataDir, names[i]), body);
	}
}

function suffixed(token) {
	return [
		`TCRS_${token}.txt`,
		`TCRS_${token}_cafe_booze.txt`,
		`TCRS_${token}_cafe_food.txt`,
	];
}

function readAll(stream) {
	return new Promise((resolve) => {
		let buf = "";
		stream.setEncoding("utf8");
		stream.on("data", (c) => (buf += c));
		stream.on("end", () => resolve(buf));
		// If stdin never closes we still want to proceed; runOne always end()s it.
		stream.on("error", () => resolve(buf));
	});
}

await main();
