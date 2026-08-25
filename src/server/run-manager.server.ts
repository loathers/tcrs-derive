/**
 * The run manager: at most one run, ever. NODE-ONLY.
 *
 * THE SINGLE-FLIGHT LOCK IS `#active`, AND `trigger()` IS SYNCHRONOUS.
 * Read the comment on trigger() before changing anything in it.
 */

import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type {
  CooldownInfo,
  DatasetSummary,
  GenerateResponse,
  ServerEvent,
  StatusResponse,
} from "../../app/lib/api-types.ts";
import type { RunEvent } from "#core/events";
import type { SecretStore } from "#core/env.server";
import {
  ALL_PERMUTATIONS,
  permutationForFile,
} from "#core/permutations";
import {
  MissingPasswordsError,
  startBatch,
  type BatchConfig,
  type BatchResult,
  type RunHandle,
} from "#core/runBatch.server";
import {
  carryForward,
  clearWork,
  indexFiles,
  promote,
  pruneRuns,
  readCurrentManifest,
  readManifest,
  resolveCurrent,
  writeManifest,
  ZIP_NAME,
  type ManifestEntry,
  type RunManifest,
  type RunOutcome,
} from "#core/staging.server";
import { initialRunState, type RunState } from "#core/state";
import { acquireLock, type Lock } from "#core/lock.server";
import { ensureJar, JarUnavailableError } from "#core/jar.server";
import { Store } from "./store.server.ts";
import { buildZip } from "./zip.server.ts";

export interface RunManagerOptions {
  store: Store;
  config: BatchConfig;
  secrets: SecretStore;
  minFreeBytes: number;
  now?: () => number;
  /**
   * Fetch a pinned release when no jar is present. Default true, which is what
   * makes a fresh checkout or a fresh volume work unattended. Set false to require
   * the jar to be supplied (the container bakes one in, so it never downloads).
   */
  allowJarDownload?: boolean;
}

interface ActiveRun {
  runId: string;
  startedAt: number;
  handle: RunHandle;
  done: Promise<void>;
}

export class RunManager {
  /** THIS FIELD IS THE SINGLE-FLIGHT LOCK. */
  #active: ActiveRun | null = null;
  #listeners = new Set<(e: ServerEvent) => void>();
  #seq = 0;
  #freeBytes: number | null = null;
  #diskTimer: NodeJS.Timeout | null = null;
  #configError: string | null = null;
  #missingPasswords = 0;
  #lock: Lock | null = null;

  readonly #o: RunManagerOptions;

  constructor(o: RunManagerOptions) {
    this.#o = o;
  }

  get #now(): () => number {
    return this.#o.now ?? Date.now;
  }

  async init(): Promise<void> {
    await mkdir(this.#o.config.dataDir, { recursive: true });

    // Single-INSTANCE lock, distinct from the single-flight lock in trigger().
    // Two processes sharing one data volume — a rolling deploy that starts the new
    // container before stopping the old one — could otherwise both run a batch and
    // tear the published dataset. The loser throws LockHeldError and exits.
    // This is why the deploy strategy must be stop-then-start, not rolling.
    this.#lock = await acquireLock(join(this.#o.config.dataDir, ".lock"));

    await this.#o.store.init();

    // Preflight the configuration ONCE, so the site can say "misconfigured"
    // instead of offering a button that starts a doomed run.
    const missing = this.#o.secrets.missingFor(ALL_PERMUTATIONS);
    this.#missingPasswords = missing.length;
    if (missing.length > 0) {
      this.#configError = `${missing.length} of ${ALL_PERMUTATIONS.length} PASSWORD_* variables are missing`;
    }

    // Resolve (and if necessary fetch) the jar AT BOOT, not at spawn time. Doing it
    // here means a missing jar surfaces as a clear "misconfigured" on the site,
    // rather than 54 identical spawn failures eight minutes into a run.
    try {
      const resolved = await ensureJar({
        configured: this.#o.config.jarPath,
        searchDir: process.cwd(),
        tag: process.env["MAFIA_TAG"],
        allowDownload: this.#o.allowJarDownload ?? true,
        onProgress: (m) => process.stdout.write(`${m}\n`),
      });
      // Feed the resolved path back into the config every run will use.
      this.#o.config.jarPath = resolved;
      process.stdout.write(`KoLmafia jar: ${resolved}\n`);
    } catch (e) {
      const detail =
        e instanceof JarUnavailableError ? e.detail : String(e);
      this.#configError = this.#configError
        ? `${this.#configError}; ${detail}`
        : detail;
    }

    // Refreshed on a timer rather than inline, so trigger() can stay synchronous.
    await this.#refreshDisk();
    this.#diskTimer = setInterval(() => void this.#refreshDisk(), 60_000);
    this.#diskTimer.unref?.();
  }

  subscribe(listener: (e: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get activeState(): RunState | null {
    return this.#active?.handle.state ?? null;
  }

  /**
   * Start a run, or explain why not.
   *
   * SYNCHRONOUS ALL THE WAY TO THE `#active` ASSIGNMENT, AND THAT IS THE ENTIRE
   * SINGLE-FLIGHT MECHANISM. Node is single-threaded, so with no `await` between
   * the `if (this.#active)` check and the assignment, two simultaneous requests
   * provably cannot both pass.
   *
   * DO NOT INSERT AN `await` ANYWHERE ABOVE THE ASSIGNMENT. That is exactly why
   * the disk check reads a cached value refreshed on a timer instead of calling
   * statfs() inline — an `await fs.statfs(...)` here would silently reopen the
   * race and let two batches run at once against one data volume.
   */
  trigger(): GenerateResponse {
    if (this.#active !== null) {
      return {
        accepted: false,
        error: "already_running",
        runId: this.#active.runId,
      };
    }

    const cooldown = this.#o.store.cooldownInfo();
    if (!cooldown.canGenerate) {
      return {
        accepted: false,
        error: "cooldown",
        nextAllowedAt: cooldown.nextAllowedAt,
        remainingMs: cooldown.remainingMs,
      };
    }

    if (this.#configError !== null) {
      return {
        accepted: false,
        error: "misconfigured",
        detail: this.#configError,
      };
    }

    if (this.#freeBytes !== null && this.#freeBytes < this.#o.minFreeBytes) {
      // Fail loudly rather than produce a truncated dataset and publish it.
      return {
        accepted: false,
        error: "insufficient_disk",
        freeBytes: this.#freeBytes,
      };
    }

    let handle: RunHandle;
    try {
      handle = startBatch(this.#o.config, this.#o.secrets);
    } catch (e) {
      return {
        accepted: false,
        error: "misconfigured",
        detail: e instanceof MissingPasswordsError ? e.message : String(e),
      };
    }

    const startedAt = this.#now();
    // --- the lock is taken HERE, with no await above this line ---------------
    const active: ActiveRun = {
      runId: handle.runId,
      startedAt,
      handle,
      done: Promise.resolve(),
    };
    this.#active = active;
    // ------------------------------------------------------------------------

    handle.onEvent((event) => this.#onRunEvent(handle.runId, event));
    active.done = this.#finish(active);

    void this.#broadcastAsync("run-started");

    return {
      accepted: true,
      runId: handle.runId,
      startedAt: new Date(startedAt).toISOString(),
    };
  }

  /**
   * Cancel the active run, if any, and wait for its teardown.
   *
   * Returns the runId that was cancelled, or null if nothing was running. The
   * cancellation itself is requested SYNCHRONOUSLY (before the first await), so a
   * caller racing with a run that is finishing on its own cannot slip through.
   *
   * Cancelling does not create a cooldown that generating had not already spent:
   * the attempt was recorded when the run started, and the usual outcome rules
   * apply (an abort under five minutes in is treated as never having happened).
   */
  async cancel(graceMs = 45_000): Promise<string | null> {
    // Captured and signalled BEFORE the first await, so this is still race-safe
    // against a run finishing naturally or a second concurrent caller. Returning a
    // promise rather than an { settled } object is deliberate: an API where the
    // caller must remember to await a nested field is trivially misused, and was.
    const active = this.#active;
    if (active === null) return null;
    active.handle.cancel();

    await Promise.race([
      active.done,
      new Promise<void>((r) => setTimeout(r, graceMs)),
    ]);
    return active.runId;
  }

  async shutdown(): Promise<void> {
    if (this.#diskTimer !== null) clearInterval(this.#diskTimer);
    await this.cancel();
    await this.#lock?.release();
    this.#lock = null;
  }

  async status(): Promise<StatusResponse> {
    const dataset = await this.#dataset();
    return this.#statusFrom(dataset);
  }

  // --- internals ---------------------------------------------------------

  #onRunEvent(runId: string, event: RunEvent): void {
    this.#emit({ type: "patch", seq: ++this.#seq, runId, event });
  }

  #emit(e: ServerEvent): void {
    for (const l of [...this.#listeners]) l(e);
  }

  async #broadcastAsync(
    kind: "run-started" | "run-finished",
    extra?: { runId: string; outcome: RunOutcome },
  ): Promise<void> {
    const status = await this.status();
    if (kind === "run-started") {
      this.#emit({ type: "run-started", seq: ++this.#seq, status });
    } else if (extra) {
      this.#emit({
        type: "run-finished",
        seq: ++this.#seq,
        runId: extra.runId,
        outcome: extra.outcome,
        status,
      });
    }
  }

  /** Drive a run to completion, publish it, and always release the lock. */
  async #finish(active: ActiveRun): Promise<void> {
    const { handle, runId, startedAt } = active;
    let outcome: RunOutcome = "failed";

    try {
      await this.#o.store.beginAttempt(runId, startedAt);

      // A manifest with finishedAt: null marks the dir as in-progress, so boot
      // recovery can spot an orphan.
      await writeManifest(handle.staging, {
        version: 1,
        id: runId,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: null,
        outcome: null,
        durationMs: null,
        concurrency: this.#o.config.concurrency,
        mafiaBuild: null,
        results: [],
        entries: [],
        zip: null,
        totalBytes: 0,
      });

      const result = await handle.result;
      outcome = classify(result);

      if (await this.#shouldPublish(result, outcome)) {
        await this.#publish(result, outcome, startedAt);
      } else {
        await rm(handle.staging.dir, { recursive: true, force: true });
      }
    } catch (e) {
      outcome = "failed";
      await rm(handle.staging.dir, { recursive: true, force: true }).catch(
        () => {},
      );
      process.stderr.write(
        `run ${runId} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
      );
    } finally {
      await this.#o.store.endAttempt(runId, outcome).catch(() => {});
      await clearWork(this.#o.config.dataDir).catch(() => {});
      this.#active = null;
      await this.#broadcastAsync("run-finished", { runId, outcome }).catch(
        () => {},
      );
    }
  }

  /**
   * Publish only if coverage did not regress.
   *
   * 53 fresh files beat 54 twelve-hour-old ones; 12 fresh do not. Comparing
   * against the previous run captures both directions.
   */
  async #shouldPublish(
    result: BatchResult,
    outcome: RunOutcome,
  ): Promise<boolean> {
    if (result.cancelled) return false;
    if (result.ok === 0) return false;
    if (outcome === "success") return true;

    const previous = await readCurrentManifest(this.#o.config.dataDir);
    const previousOk =
      previous?.results.filter((r) => r.ok).length ?? 0;
    return result.ok >= Math.max(1, previousOk);
  }

  async #publish(
    result: BatchResult,
    outcome: RunOutcome,
    startedAt: number,
  ): Promise<void> {
    const dataDir = this.#o.config.dataDir;
    const previousDir = await resolveCurrent(dataDir);
    const previousManifest = previousDir
      ? await readManifest(previousDir)
      : null;

    // Fill gaps from the previous run, so the published set is always complete and
    // no download link 404s.
    const carried =
      previousDir && previousManifest
        ? await carryForward(
            result.staging,
            { dir: previousDir, manifest: previousManifest },
            result.missing,
          )
        : [];

    const fresh = await indexFiles(result.staging, result.runId, (name) => {
      const hit = permutationForFile(name);
      return hit ? { user: hit.permutation.user, kind: hit.kind } : undefined;
    });
    const entries = mergeEntries(fresh, carried);

    // Built INSIDE the staging dir, before the symlink flips, so the zip is part
    // of the atomic swap and is never missing or half-written.
    const zip = await buildZip(result.staging, entries).catch(() => null);

    const finishedAt = this.#now();
    const manifest: RunManifest = {
      version: 1,
      id: result.runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      outcome: outcome === "success" ? "success" : "partial",
      durationMs: finishedAt - startedAt,
      concurrency: this.#o.config.concurrency,
      mafiaBuild: result.mafiaBuild,
      results: result.results,
      entries,
      zip,
      totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    };

    await writeManifest(result.staging, manifest);
    await promote(dataDir, result.runId);
    await this.#o.store.setCurrent(result.runId);
    // Safe to delete the old dir immediately: an in-flight download holds an open
    // fd, and POSIX keeps that inode alive.
    await pruneRuns(dataDir, [result.runId]);
  }

  async #dataset(): Promise<DatasetSummary | null> {
    const manifest = await readCurrentManifest(this.#o.config.dataDir);
    if (manifest === null || manifest.finishedAt === null) return null;

    const stale = [
      ...new Set(
        manifest.entries
          .filter((e) => e.sourceRunId !== manifest.id)
          .map((e) => e.user),
      ),
    ].sort();

    return {
      runId: manifest.id,
      generatedAt: manifest.startedAt,
      outcome: manifest.outcome === "success" ? "success" : "partial",
      fileCount: manifest.entries.length,
      totalBytes: manifest.totalBytes,
      durationMs: manifest.durationMs,
      mafiaBuild: manifest.mafiaBuild,
      stalePermutations: stale,
      zip:
        manifest.zip === null
          ? null
          : { url: "/api/download/zip", bytes: manifest.zip.bytes },
    };
  }

  #statusFrom(dataset: DatasetSummary | null): StatusResponse {
    const active = this.#active;
    const raw = this.#o.store.cooldownInfo();
    const cooldown: CooldownInfo = {
      ...raw,
      canGenerate: raw.canGenerate && active === null && this.#configError === null,
      reason:
        active !== null
          ? "running"
          : this.#configError !== null
            ? "misconfigured"
            : !raw.canGenerate
              ? "cooldown"
              : this.#freeBytes !== null &&
                  this.#freeBytes < this.#o.minFreeBytes
                ? "low-disk"
                : "ok",
    };

    const last = this.#o.store.lastAttempt;
    return {
      now: new Date(this.#now()).toISOString(),
      configOk: this.#configError === null,
      missingPasswordCount: this.#missingPasswords,
      dataset,
      cooldown,
      run:
        active === null
          ? null
          : {
              runId: active.runId,
              startedAt: new Date(active.startedAt).toISOString(),
              state: active.handle.state,
            },
      lastAttempt: last,
      permutationCount: ALL_PERMUTATIONS.length,
    };
  }

  async #refreshDisk(): Promise<void> {
    this.#freeBytes = await this.#o.store.freeBytes();
  }

  /** An empty state for a client connecting when nothing is running. */
  static emptyState(): RunState {
    return initialRunState(ALL_PERMUTATIONS, {
      runId: "",
      concurrency: 0,
      maxAttempts: 3,
    });
  }
}

function classify(result: BatchResult): RunOutcome {
  if (result.cancelled) return "aborted";
  if (result.ok === 0) return "failed";
  return result.failed === 0 ? "success" : "partial";
}

function mergeEntries(
  fresh: readonly ManifestEntry[],
  carried: readonly ManifestEntry[],
): ManifestEntry[] {
  const byName = new Map(carried.map((e) => [e.name, e]));
  for (const e of fresh) byName.set(e.name, e); // fresh always wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export { ZIP_NAME };
