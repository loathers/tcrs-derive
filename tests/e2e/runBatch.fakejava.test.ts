import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretStore } from "#core/env.server";
import type { RunEvent } from "#core/events";
import {
	ALL_PERMUTATIONS,
	passwordVarFor,
	permutationByUser,
} from "#core/permutations";
import {
	type BatchConfig,
	MissingPasswordsError,
	startBatch,
	UnknownPermutationsError,
} from "#core/runBatch.server";
import {
	createStaging,
	promote,
	type RunManifest,
	writeManifest,
} from "#core/staging.server";
import { orderedPerms } from "#core/state";
import { present } from "../helpers/present.ts";

const FAKE_JAVA = resolve("tests/fixtures/fake-java.mjs");
const dirs: string[] = [];

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "tcrs-batch-"));
	dirs.push(d);
	return d;
}
afterEach(async () => {
	while (dirs.length)
		await rm(present(dirs.pop()), { recursive: true, force: true });
});

/** A store that knows every password, so preflight passes. */
const allSecrets: SecretStore = {
	passwordFor: () => "hunter2",
	missingFor: () => [],
	size: 54,
};

function config(dataDir: string, over: Partial<BatchConfig> = {}): BatchConfig {
	return {
		jarPath: "/nonexistent/KoLmafia.jar",
		javaBin: process.execPath,
		javaOpts: [FAKE_JAVA],
		concurrency: 4,
		resume: false,
		dataDir,
		maxAttempts: 1,
		loginTimeoutMs: 30_000,
		timeoutMs: 30_000,
		retryBackoffMs: 10,
		completeTolerance: 150,
		stallTimeoutMs: null,
		warmupTimeoutMs: 5_000,
		skipWarmup: true, // the warm-up is exercised separately; keep this fast
		keepWorkdirs: false,
		...over,
	};
}

describe("startBatch preflight", () => {
	it("throws synchronously on an unknown ONLY name", () => {
		// The bash silently ran zero permutations and printed "Nothing to do".
		expect(() =>
			startBatch(config(tmp(), { only: ["tt_walaby"] }), allSecrets),
		).toThrow(UnknownPermutationsError);
	});

	it("throws synchronously on missing passwords, before any JVM spawns", () => {
		// The bash discovered this inside the worker, so one .env typo failed one
		// permutation 40 minutes into a batch.
		const empty: SecretStore = {
			passwordFor: () => {
				throw new Error("nope");
			},
			missingFor: (perms) => perms.map((p) => passwordVarFor(p)),
			size: 0,
		};
		expect(() => startBatch(config(tmp()), empty)).toThrow(
			MissingPasswordsError,
		);
	});
});

describe("a full batch", () => {
	it("runs a subset, publishes files and reports a manifest-ready result", async () => {
		const data = tmp();
		const only = ["at_blender", "at_packrat"];
		const handle = startBatch(
			config(data, { only, concurrency: 2 }),
			allSecrets,
		);

		// Subscribing after the synchronous return must still see batch:start, this
		// is why startBatch is synchronous.
		const events: RunEvent[] = [];
		handle.onEvent((e) => events.push(e));

		const result = await handle.result;

		expect(result.ok).toBe(2);
		expect(result.failed).toBe(0);
		expect(result.total).toBe(2);
		expect(result.cancelled).toBe(false);
		expect(result.mafiaBuild).toBe("r29131-M");

		expect(events[0]?.type).toBe("batch:start");
		expect(events.at(-1)?.type).toBe("batch:end");

		// 6 files for 2 permutations, plus the checksums file.
		for (const user of only) {
			for (const name of present(permutationByUser(user)).files) {
				expect(existsSync(join(handle.staging.dataDir, name)), name).toBe(true);
			}
		}
		// Checksums are written at PUBLISH time, not batch time, so they can cover
		// files that carry-forward fills gaps with. See publishRun.
		expect(existsSync(join(handle.staging.dataDir, "SHA256SUMS.txt"))).toBe(
			false,
		);
		expect(result.entries.map((e) => e.name).sort()).toEqual(
			only.flatMap((u) => [...present(permutationByUser(u)).files]).sort(),
		);
	}, 60_000);

	it("keeps the live state in sync with the event stream", async () => {
		const data = tmp();
		const handle = startBatch(
			config(data, { only: ["at_blender"] }),
			allSecrets,
		);
		await handle.result;

		// handle.state is the same reducer the browser and the ink CLI use.
		expect(handle.state.summary.done).toBe(1);
		expect(handle.state.summary.total).toBe(1);
		expect(present(orderedPerms(handle.state)[0]).status.kind).toBe("done");
		expect(handle.state.endedAt).not.toBeNull();
	}, 60_000);

	it("writes a per-permutation log inside the run's own staging dir", async () => {
		// Logs are never destructively wiped: run-all.sh:54 did `rm -f logs/*.log` at
		// the START of a run, exactly when you want the previous run's logs.
		const data = tmp();
		const handle = startBatch(
			config(data, { only: ["at_blender"] }),
			allSecrets,
		);
		await handle.result;

		const log = readFileSync(
			join(handle.staging.logDir, "at_blender.log"),
			"utf8",
		);
		expect(log).toContain("=== attempt 1/1 ===");
		expect(log).toContain("Deriving TCRS item adjustments for all real items");
		expect(log).toContain("Progress: 12001/12070");
	}, 60_000);

	it("records failures without aborting the rest of the batch", async () => {
		const data = tmp();
		// partial-bail always truncates, so both permutations fail, but the batch
		// still completes and reports them.
		const handle = startBatch(
			config(data, {
				only: ["at_blender", "at_packrat"],
				javaOpts: [FAKE_JAVA, "--fake-fixture=partial-bail"],
			}),
			allSecrets,
		);
		const result = await handle.result;

		expect(result.ok).toBe(0);
		expect(result.failed).toBe(2);
		expect(result.results.every((r) => r.reason === "incomplete")).toBe(true);
		// Partial output was discarded, so nothing was indexed to publish.
		expect(result.entries).toEqual([]);
	}, 60_000);

	it("respects the concurrency limit across the whole batch", async () => {
		const data = tmp();
		const handle = startBatch(
			config(data, {
				only: ALL_PERMUTATIONS.slice(0, 6).map((p) => p.user),
				concurrency: 2,
				javaOpts: [FAKE_JAVA, "--fake-delay=1"],
			}),
			allSecrets,
		);

		let live = 0;
		let peak = 0;
		handle.onEvent((e) => {
			if (e.type === "perm:spawned") peak = Math.max(peak, ++live);
			if (e.type === "perm:exited") live--;
		});
		await handle.result;
		expect(peak).toBeLessThanOrEqual(2);
	}, 120_000);
});

describe("cancellation", () => {
	it("stops admitting new permutations and reports cancelled", async () => {
		const data = tmp();
		const handle = startBatch(
			config(data, {
				only: ALL_PERMUTATIONS.slice(0, 8).map((p) => p.user),
				concurrency: 2,
				javaOpts: [FAKE_JAVA, "--fake-delay=3"],
			}),
			allSecrets,
		);

		let spawned = 0;
		handle.onEvent((e) => {
			if (e.type === "perm:spawned") spawned++;
		});

		setTimeout(() => handle.cancel(), 300);
		const result = await handle.result;

		expect(result.cancelled).toBe(true);
		// Far fewer than 8 JVMs were ever launched.
		expect(spawned).toBeLessThan(8);
	}, 120_000);
});

describe("RESUME", () => {
	it("skips permutations the published manifest records as complete", async () => {
		const data = tmp();

		// Publish a run in which at_blender genuinely succeeded.
		const prev = await createStaging(data, "run-prev");
		const at = present(permutationByUser("at_blender"));
		const manifest: RunManifest = {
			version: 1,
			id: "run-prev",
			startedAt: new Date(0).toISOString(),
			finishedAt: new Date(1).toISOString(),
			outcome: "success",
			durationMs: 1,
			concurrency: 1,
			mafiaBuild: "r29131-M",
			results: [
				{
					user: "at_blender",
					ok: true,
					attempts: 1,
					filesCopied: 3,
					durationMs: 1,
					itemsDone: 12001,
					itemsTotal: 12070,
				},
			],
			entries: at.files.map((name, i) => ({
				name,
				user: "at_blender",
				kind: present((["items", "cafe_booze", "cafe_food"] as const)[i]),
				bytes: 10,
				sha256: "x",
				sourceRunId: "run-prev",
			})),
			zip: null,
			totalBytes: 30,
		};
		await writeManifest(prev, manifest);
		await promote(data, "run-prev");

		const handle = startBatch(
			config(data, {
				only: ["at_blender", "at_packrat"],
				resume: true,
				concurrency: 2,
			}),
			allSecrets,
		);

		const skipped: string[] = [];
		handle.onEvent((e) => {
			if (e.type === "batch:skipped") skipped.push(e.user);
		});
		const result = await handle.result;

		expect(skipped).toEqual(["at_blender"]);
		expect(result.skipped).toBe(1);
		// Skipped rows stay VISIBLE in the totals. The bash filtered them out of the
		// task list, so resuming 52 of 54 displayed "Overall: 0/2 done".
		expect(handle.state.summary.total).toBe(2);
		expect(handle.state.summary.skipped).toBe(1);
		expect(handle.state.summary.done).toBe(1);
	}, 60_000);

	it("does NOT skip a permutation whose recorded derive was incomplete", async () => {
		// The bash's already_done() trusted file existence + nonzero size, so it
		// re-adopted exactly the truncated output the guard exists to reject.
		const data = tmp();
		const at = present(permutationByUser("at_blender"));
		const prev = await createStaging(data, "run-prev");
		await writeManifest(prev, {
			version: 1,
			id: "run-prev",
			startedAt: new Date(0).toISOString(),
			finishedAt: new Date(1).toISOString(),
			outcome: "partial",
			durationMs: 1,
			concurrency: 1,
			mafiaBuild: null,
			results: [
				{
					user: "at_blender",
					ok: false, // <- the derive bailed
					attempts: 3,
					filesCopied: 3,
					durationMs: 1,
					itemsDone: 4001,
					itemsTotal: 12070,
					reason: "incomplete",
				},
			],
			entries: at.files.map((name, i) => ({
				name,
				user: "at_blender",
				kind: present((["items", "cafe_booze", "cafe_food"] as const)[i]),
				bytes: 10,
				sha256: "x",
				sourceRunId: "run-prev",
			})),
			zip: null,
			totalBytes: 30,
		});
		await promote(data, "run-prev");

		const handle = startBatch(
			config(data, { only: ["at_blender"], resume: true }),
			allSecrets,
		);
		const result = await handle.result;
		expect(result.skipped).toBe(0);
		expect(result.ok).toBe(1);
	}, 60_000);
});

describe("the warm-up", () => {
	it("populates a template and reports ok", async () => {
		const data = tmp();
		const handle = startBatch(
			config(data, {
				only: ["at_blender"],
				skipWarmup: false,
				// The warm-up sends ["", "exit"], which fake-java replays as a normal run.
				javaOpts: [FAKE_JAVA],
			}),
			allSecrets,
		);
		const statuses: string[] = [];
		handle.onEvent((e) => {
			if (e.type === "batch:warmup") statuses.push(e.status);
		});
		await handle.result;
		expect(statuses[0]).toBe("start");
		expect(statuses[1]).toBe("ok");
	}, 60_000);

	it("continues without a template when the warm-up fails", async () => {
		const data = tmp();
		const handle = startBatch(
			config(data, {
				only: ["at_blender"],
				skipWarmup: false,
				javaOpts: [FAKE_JAVA, "--fake-exit=1"],
			}),
			allSecrets,
		);
		const statuses: string[] = [];
		handle.onEvent((e) => {
			if (e.type === "batch:warmup") statuses.push(e.status);
		});
		const result = await handle.result;
		expect(statuses).toContain("failed");
		// Best-effort, exactly as the bash: the batch still runs.
		expect(result.total).toBe(1);
	}, 60_000);
});
