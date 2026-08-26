import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEventInit } from "#core/events";
import { permutationByUser } from "#core/permutations";
import { type RunOneOptions, runOne } from "#core/runOne.server";
import { present } from "../helpers/present.ts";

/**
 * Everything runOne does that a unit test cannot reach: real spawn/pipe plumbing,
 * the 'close'-vs-'exit' race, both watchdogs, process-group killing, the collect
 * size rule, discard-partials, retry backoff, and abort mid-derive.
 *
 * No JVM, no network, no KoL account, fake-java.mjs replays a committed fixture.
 */

const FAKE_JAVA = resolve("tests/fixtures/fake-java.mjs");
// at_blender is the permutation the happy/benign fixtures came from, so the
// filenames in their "Wrote file" lines match this permutation's expected files.
const AT_BLENDER = present(permutationByUser("at_blender"));

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "tcrs-e2e-"));
	dirs.push(d);
	return d;
}
afterEach(async () => {
	while (dirs.length)
		await rm(present(dirs.pop()), { recursive: true, force: true });
});

interface Harness {
	events: RunEventInit[];
	opts: RunOneOptions;
	outputDir: string;
	workDir: string;
	types(): string[];
	find<T extends RunEventInit["type"]>(
		type: T,
	): Extract<RunEventInit, { type: T }>[];
}

function harness(
	fakeFlags: string[] = [],
	over: Partial<RunOneOptions> = {},
): Harness {
	const root = tmp();
	const outputDir = join(root, "out");
	const workDir = join(root, "work", AT_BLENDER.user);
	mkdirSync(outputDir, { recursive: true });

	const events: RunEventInit[] = [];
	const opts: RunOneOptions = {
		permutation: AT_BLENDER,
		password: "hunter2",
		jarPath: "/nonexistent/KoLmafia.jar", // fake-java ignores it
		javaBin: process.execPath,
		// fake-java is configured through javaOpts, the same channel production uses
		// for -Xmx512m, because the child env is deliberately minimal.
		javaOpts: [FAKE_JAVA, ...fakeFlags],
		workDir,
		templateDir: null,
		outputDir,
		maxAttempts: 3,
		loginTimeoutMs: 60_000,
		timeoutMs: 60_000,
		retryBackoffMs: 10,
		emit: (e) => events.push(e),
		...over,
	};
	return {
		events,
		opts,
		outputDir,
		workDir,
		types: () => events.map((e) => e.type),
		find: (type) => events.filter((e) => e.type === type) as never,
	};
}

describe("the happy path", () => {
	it("derives, collects 3 files and reports done", async () => {
		const h = harness();
		const r = await runOne(h.opts);

		expect(r.ok).toBe(true);
		expect(r.copied).toBe(3);
		expect(r.attempts).toBe(1);
		expect(r.itemsDone).toBe(12001);
		expect(r.itemsTotal).toBe(12070);
		expect(r.mafiaBuild).toBe("r29131-M");

		for (const name of AT_BLENDER.files) {
			expect(existsSync(join(h.outputDir, name)), name).toBe(true);
		}
		// No `.part` files left behind: the rename must have completed.
		expect(
			readFileSync(join(h.outputDir, AT_BLENDER.files[0]), "utf8"),
		).toContain("fake item");
	});

	it("emits the full event sequence in order", async () => {
		const h = harness();
		await runOne(h.opts);
		const types = h.types();
		expect(types[0]).toBe("perm:attempt");
		expect(types[1]).toBe("perm:spawned");
		expect(types).toContain("perm:phase");
		expect(types).toContain("perm:progress");
		expect(types).toContain("perm:wrote");
		expect(types).toContain("perm:exited");
		expect(types.at(-2)).toBe("perm:collected");
		expect(types.at(-1)).toBe("perm:done");
		// Three phases, in order.
		expect(h.find("perm:phase").map((e) => e.phase)).toEqual([
			"items",
			"cafe_booze",
			"cafe_food",
		]);
		// 121 progress lines in the real fixture.
		expect(h.find("perm:progress")).toHaveLength(121);
	});

	it("does not decide on 'exit' before stdout is drained", async () => {
		// The highest-risk trap: deciding on 'exit' can miss the final
		// Progress: 12001/12070 and turn a success into a discarded partial.
		// A per-line delay widens the window between exit and close.
		const h = harness(["--fake-delay=1"]);
		const r = await runOne(h.opts);
		expect(r.ok).toBe(true);
		expect(r.itemsDone).toBe(12001);
		const progress = h.find("perm:progress");
		expect(present(progress.at(-1)).done).toBe(12001);
	});

	it("feeds the login script on stdin, never on argv", async () => {
		const h = harness([], { keepWorkdir: true });
		await runOne(h.opts);
		const received = readFileSync(
			join(h.workDir, "stdin-received.txt"),
			"utf8",
		).split("\n");
		expect(received.slice(0, 8)).toEqual([
			"at_blender",
			"hunter2",
			"no", // the two `no`s answer the login-time derive prompts; sending
			"no", // exactly two keeps the commands below in the right slots
			"tcrs reset",
			"tcrs derive",
			"tcrs save",
			"exit",
		]);
		// A trailing newline after `exit`, then EOF.
		expect(received.at(-1)).toBe("");
	});

	it("removes the work dir on success to reclaim disk", async () => {
		const h = harness();
		await runOne(h.opts);
		expect(existsSync(h.workDir)).toBe(false);
	});
});

describe("partial output is discarded, not published", () => {
	it("rejects a derive that bailed early despite writing 3 files", async () => {
		// mafia prints Done! and saves truncated files. File existence alone would
		// accept this. The completeness guard must not.
		const h = harness(["--fake-fixture=partial-bail"], { maxAttempts: 1 });
		const r = await runOne(h.opts);

		expect(r.ok).toBe(false);
		expect(r.reason).toBe("incomplete");
		expect(h.types()).toContain("perm:discarded");
		// Critically: nothing left in the output dir for a later RESUME to adopt.
		for (const name of AT_BLENDER.files) {
			expect(existsSync(join(h.outputDir, name)), name).toBe(false);
		}
	});

	it("retries after an incomplete attempt and can then succeed", async () => {
		// First attempt truncates, so it retries. Fake-java is stateless, so use a
		// fixture that always truncates and assert the retry actually happened.
		const h = harness(["--fake-fixture=partial-bail"], { maxAttempts: 2 });
		const r = await runOne(h.opts);
		expect(r.attempts).toBe(2);
		expect(h.find("perm:retryWait")).toHaveLength(1);
		expect(present(h.find("perm:retryWait")[0]).nextAttempt).toBe(2);
		expect(h.find("perm:attempt").map((e) => e.attempt)).toEqual([1, 2]);
	});

	it("does not count a zero-byte file toward copied", async () => {
		// The bash used `[ -s ]`, not `[ -f ]`.
		const h = harness(["--fake-empty-file"], { maxAttempts: 1 });
		const r = await runOne(h.opts);
		expect(r.copied).toBe(2);
		expect(r.ok).toBe(false);
	});

	it("rejects files with no progress ever reported", async () => {
		const h = harness(
			["--fake-fixture=not-in-tcrs", "--fake-perm=Accordion_Thief_Blender"],
			{
				maxAttempts: 1,
			},
		);
		const r = await runOne(h.opts);
		expect(r.ok).toBe(false);
		// not-in-tcrs outranks incomplete and must NOT be retried: retrying a
		// permanently broken account burns three logins for nothing.
		expect(r.reason).toBe("not-in-tcrs");
		expect(r.attempts).toBe(1);
		// Partial output is still discarded, whatever the reason.
		for (const name of AT_BLENDER.files) {
			expect(existsSync(join(h.outputDir, name)), name).toBe(false);
		}
	});

	it("never retries not-in-tcrs even with attempts remaining", async () => {
		const h = harness(["--fake-fixture=not-in-tcrs", "--fake-files=0"], {
			maxAttempts: 3,
		});
		const r = await runOne(h.opts);
		expect(r.reason).toBe("not-in-tcrs");
		expect(h.find("perm:attempt")).toHaveLength(1);
		expect(h.find("perm:retryWait")).toHaveLength(0);
	});
});

describe("watchdogs", () => {
	it("fails fast on a stuck login instead of waiting out the hard timeout", async () => {
		const h = harness(["--fake-hang-at-login"], {
			loginTimeoutMs: 300,
			timeoutMs: 60_000,
			maxAttempts: 1,
		});
		const started = Date.now();
		const r = await runOne(h.opts);
		// Must return in ~300ms + teardown, not 60s.
		expect(Date.now() - started).toBeLessThan(20_000);
		expect(h.types()).toContain("perm:loginTimeout");
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("login");
	}, 30_000);

	it("does not fire the login watchdog once deriving has started", async () => {
		// The fixture reaches the items phase quickly, then idles.
		const h = harness(["--fake-stop-after=45"], {
			loginTimeoutMs: 300,
			timeoutMs: 2_000,
			maxAttempts: 1,
		});
		const r = await runOne(h.opts);
		expect(h.types()).not.toContain("perm:loginTimeout");
		expect(h.types()).toContain("perm:hardTimeout");
		expect(r.reason).toBe("timeout");
	}, 30_000);

	it("enforces the overall timeout from spawn, not from derive start", async () => {
		const h = harness(["--fake-stop-after=45"], {
			loginTimeoutMs: 60_000,
			timeoutMs: 500,
			maxAttempts: 1,
		});
		const started = Date.now();
		await runOne(h.opts);
		expect(Date.now() - started).toBeLessThan(20_000);
		expect(h.types()).toContain("perm:hardTimeout");
	}, 30_000);

	it("kills a child that ignores SIGTERM", async () => {
		const h = harness(["--fake-stop-after=45", "--fake-ignore-sigterm"], {
			loginTimeoutMs: 60_000,
			timeoutMs: 300,
			maxAttempts: 1,
		});
		const r = await runOne(h.opts);
		// The TERM -> 3s -> KILL escalation must complete rather than hang.
		expect(r.ok).toBe(false);
		const exited = h.find("perm:exited");
		expect(exited).toHaveLength(1);
		expect(present(exited[0]).signal).toBe("SIGKILL");
	}, 30_000);

	it("reaps descendants by killing the process group", async () => {
		// kill(-pgid) must reap a grandchild that the bash's recursive `pgrep -P` loop
		// could race past (fork happens between the enumeration and the kill).
		let log = "";
		const h = harness(["--fake-spawn-grandchild", "--fake-stop-after=45"], {
			loginTimeoutMs: 60_000,
			timeoutMs: 300,
			maxAttempts: 1,
			onLog: (chunk) => {
				log += chunk;
			},
		});
		await runOne(h.opts);

		const pid = Number(/grandchild pid (\d+)/.exec(log)?.[1]);
		expect(Number.isFinite(pid), `no grandchild pid in output: ${log}`).toBe(
			true,
		);

		// Give the group kill a moment to propagate, then assert the grandchild is
		// gone. kill(pid, 0) throws ESRCH once it no longer exists.
		await new Promise((r) => setTimeout(r, 500));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		expect(alive, `grandchild ${pid} survived the process-group kill`).toBe(
			false,
		);
	}, 30_000);
});

describe("cancellation", () => {
	it("aborts mid-derive without retrying", async () => {
		const controller = new AbortController();
		const h = harness(["--fake-delay=5"], {
			signal: controller.signal,
			maxAttempts: 3,
		});
		const p = runOne(h.opts);
		setTimeout(() => controller.abort(), 150);
		const r = await p;
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("cancelled");
		// No retry after a cancel.
		expect(h.find("perm:attempt")).toHaveLength(1);
		expect(h.find("perm:retryWait")).toHaveLength(0);
	}, 30_000);

	it("returns immediately if already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const h = harness([], { signal: controller.signal });
		const r = await runOne(h.opts);
		expect(r.reason).toBe("cancelled");
		expect(h.events).toHaveLength(0);
	});

	it("honours an abort that lands while the work dir is being seeded", async () => {
		// perm:attempt is emitted immediately before `await seedWorkdir`, which is a
		// rm -rf + cp -r of the template tree. Aborting from the emit handler lands in
		// that window deterministically: past the top-of-loop check, before any child
		// exists. A listener added to an already-aborted signal never fires, so getting
		// this wrong leaves a JVM nothing will kill until the 30-minute hard timeout.
		const controller = new AbortController();
		const h = harness(["--fake-delay=5"], {
			signal: controller.signal,
			maxAttempts: 3,
		});
		h.opts.emit = (e) => {
			h.events.push(e);
			if (e.type === "perm:attempt") controller.abort();
		};

		const r = await runOne(h.opts);

		expect(r.ok).toBe(false);
		expect(r.reason).toBe("cancelled");
		expect(h.find("perm:spawned")).toHaveLength(0);
		expect(h.find("perm:attempt")).toHaveLength(1);
	}, 30_000);
});

describe("failure classification", () => {
	/**
	 * REGRESSION: `reason` was declared outside the retry loop and the final
	 * classifier was guarded by `reason === undefined`, so whatever attempt 1
	 * decided stuck. An attempt that discarded partial output set "incomplete", and
	 * a second attempt that then failed at login was still reported as "incomplete"
	 * with copied: 0 -- in the chart, the plain reporter and the manifest alike.
	 */
	it("classifies the last attempt, not the first", async () => {
		const runLog = join(tmp(), "runs");
		const h = harness(
			[
				`--fake-run-log=${runLog}`,
				"--fake-fixture=partial-bail,warmup",
				"--fake-files=3,0",
			],
			{ maxAttempts: 2 },
		);

		const r = await runOne(h.opts);

		// Attempt 1 wrote partial output and had it discarded; attempt 2 replayed
		// `username: Invalid login.` and never started deriving.
		expect(h.find("perm:attempt")).toHaveLength(2);
		expect(h.find("perm:discarded")).toHaveLength(1);
		expect(r.ok).toBe(false);
		expect(r.copied).toBe(0);
		expect(r.reason).toBe("login");
		expect(present(h.find("perm:failed")[0]).reason).toBe("login");
	}, 30_000);
});

describe("work dir seeding", () => {
	it("deletes a template's data/ so mafia cannot skip deriving", async () => {
		// LOAD-BEARING: a leaked TCRS file makes mafia find existing data and skip
		// the derive, producing a wrong-but-plausible output file.
		const template = tmp();
		mkdirSync(join(template, "data"), { recursive: true });
		writeFileSync(
			join(template, "data", AT_BLENDER.files[0]),
			"STALE DATA FROM ANOTHER PERMUTATION",
		);
		writeFileSync(join(template, "settings.txt"), "shared=1");

		const h = harness([], { templateDir: template, keepWorkdir: true });
		await runOne(h.opts);

		// The shared file survived. The stale data/ did not leak through.
		const collected = readFileSync(
			join(h.outputDir, AT_BLENDER.files[0]),
			"utf8",
		);
		expect(collected).not.toContain("STALE DATA");
		expect(collected).toContain("fake item");
	});

	it("warns but continues when the template cannot be copied", async () => {
		const h = harness([], { templateDir: "/nonexistent/template" });
		const r = await runOne(h.opts);
		expect(h.find("warn").some((w) => w.message.includes("template"))).toBe(
			true,
		);
		expect(r.ok).toBe(true);
	});
});

describe("the TCRS output location", () => {
	it("collects from data/TCRS/, as r29183+ writes it", async () => {
		// REGRESSION: r29183 moved the output into a TCRS/ subdirectory. collect()
		// only looked at data/, so a run where all three phases completed and mafia
		// reported "Wrote file TCRS/..." collected ZERO files and reported failure.
		const h = harness(["--fake-subdir"]);
		const r = await runOne(h.opts);

		expect(r.ok).toBe(true);
		expect(r.copied).toBe(3);
		for (const name of AT_BLENDER.files) {
			expect(existsSync(join(h.outputDir, name)), name).toBe(true);
		}
		// The reported basenames must still be recorded despite the path prefix.
		expect(
			h
				.find("perm:wrote")
				.map((e) => e.file)
				.sort(),
		).toEqual([...AT_BLENDER.files].sort());
	}, 30_000);

	it("still collects from a flat data/, as older jars wrote it", async () => {
		const h = harness();
		const r = await runOne(h.opts);
		expect(r.ok).toBe(true);
		expect(r.copied).toBe(3);
	}, 30_000);

	it("prefers the subdirectory when both exist", async () => {
		// A workdir seeded from a template could in principle hold both. The newer
		// layout is the authoritative one.
		const h = harness(["--fake-subdir"], { keepWorkdir: true });
		await runOne(h.opts);
		expect(
			existsSync(join(h.workDir, "data", "TCRS", AT_BLENDER.files[0])),
		).toBe(true);
	}, 30_000);
});
