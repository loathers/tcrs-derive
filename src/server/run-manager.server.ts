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
import { ALL_PERMUTATIONS, permutationForFile } from "#core/permutations";
import {
  MissingPasswordsError,
  startBatch,
  type BatchConfig,
  type BatchResult,
  type RunHandle,
} from "#core/runBatch.server";
import {
  clearWork,
  publishRun,
  readCurrentManifest,
  writeManifest,
  ZIP_NAME,
  type RunManifest,
  type RunOutcome,
} from "#core/staging.server";
import type { RunState } from "#core/state";
import { acquireLock, type Lock } from "#core/lock.server";
import { isDev } from "./dev.server.ts";
import { ensureJar, JarUnavailableError } from "#core/jar.server";
import { Store } from "./store.server.ts";
import { ZIP_URL } from "#server/download.server";

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
    // Two processes sharing one data volume, a rolling deploy that starts the new
    // container before stopping the old one, could otherwise both run a batch and
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
      const detail = e instanceof JarUnavailableError ? e.detail : String(e);
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
   * statfs() inline, an `await fs.statfs(...)` here would silently reopen the
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

  /** Clear the cooldown. Guarded by the route, which does not exist in prod. */
  async clearCooldown(): Promise<void> {
    await this.#o.store.clearAttempts();
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

      if (this.#shouldPublish(result)) {
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
   * Publish unless the run produced nothing usable.
   *
   * publishRun() backfills every file this run did not reproduce from the previous
   * run, so what gets published is the union of old and new, with fresh files
   * winning. Coverage therefore cannot regress, and the old comparison of this
   * run's ok count against the previous run's only ever discarded good data: one
   * flaky permutation was enough to bin an entire 54-login run.
   */
  #shouldPublish(result: BatchResult): boolean {
    if (result.cancelled) return false;
    return result.ok > 0;
  }

  async #publish(
    result: BatchResult,
    outcome: RunOutcome,
    startedAt: number,
  ): Promise<void> {
    await publishRun(this.#o.config.dataDir, {
      staging: result.staging,
      runId: result.runId,
      entries: result.entries,
      results: result.results,
      mafiaBuild: result.mafiaBuild,
      concurrency: this.#o.config.concurrency,
      startedAt,
      finishedAt: this.#now(),
      outcome: outcome === "success" ? "success" : "partial",
    });
    await this.#o.store.setCurrent(result.runId);
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
      // When the dataset came into existence, not when the run began. A batch
      // takes ~12 minutes, so showing startedAt made "generated N minutes ago"
      // overstate the age by the whole duration. The cooldown still measures from
      // startedAt, deliberately, so a long run does not push the window later.
      generatedAt: manifest.finishedAt,
      outcome: manifest.outcome === "success" ? "success" : "partial",
      fileCount: manifest.entries.length,
      totalBytes: manifest.totalBytes,
      durationMs: manifest.durationMs,
      mafiaBuild: manifest.mafiaBuild,
      stalePermutations: stale,
      zip:
        manifest.zip === null
          ? null
          : { url: ZIP_URL, bytes: manifest.zip.bytes },
    };
  }

  #statusFrom(dataset: DatasetSummary | null): StatusResponse {
    const active = this.#active;
    const raw = this.#o.store.cooldownInfo();
    // One decision, in the same priority order trigger() uses, so the button and
    // the explanation beside it cannot disagree. Computing them separately let
    // "not enough free disk" render next to an enabled button.
    const reason: CooldownInfo["reason"] =
      active !== null
        ? "running"
        : this.#configError !== null
          ? "misconfigured"
          : this.#freeBytes !== null && this.#freeBytes < this.#o.minFreeBytes
            ? "low-disk"
            : !raw.canGenerate
              ? "cooldown"
              : "ok";
    const cooldown: CooldownInfo = {
      ...raw,
      canGenerate: reason === "ok",
      reason,
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
      // Same predicate requireDev() uses, so the control the browser renders
      // and the route that serves it cannot disagree.
      dev: isDev(),
    };
  }

  async #refreshDisk(): Promise<void> {
    this.#freeBytes = await this.#o.store.freeBytes();
  }
}

function classify(result: BatchResult): RunOutcome {
  if (result.cancelled) return "aborted";
  if (result.ok === 0) return "failed";
  return result.failed === 0 ? "success" : "partial";
}

export { ZIP_NAME };
