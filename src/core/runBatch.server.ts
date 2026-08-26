/**
 * Batch orchestration. NODE-ONLY. Port of run-all.sh.
 *
 * Replaces `xargs -P "$CONCURRENCY" -L1 run-one.sh` (run-all.sh:259) and, much
 * more importantly, the 1.5s progress-polling loop that re-derived all state by
 * `tr | awk | grep`-ing 54 growing log files. Over a 7.5 minute batch that was
 * ~300 frames x 54 files x ~4 forks: roughly 65,000 processes and ~80MB of
 * re-reading, purely to draw bars. Consuming each child's stdout directly deletes
 * all of it.
 */

import { join } from "node:path";
import { EventBus } from "./bus.ts";
import type { RunEvent, RunEventInit } from "./events.ts";
import type { SecretStore } from "./env.server.ts";
import { LogSink } from "./logSink.server.ts";
import {
  ALL_PERMUTATIONS,
  permutationForFile,
  selectPermutations,
  type Permutation,
} from "./permutations.ts";
import { runOne, type RunOneResult } from "./runOne.server.ts";
import { track, untrack } from "./reaper.server.ts";
import {
  createStaging,
  indexFiles,
  readManifest,
  resolveCurrent,
  runIdFor,
  type ManifestEntry,
  type PermutationResult,
  type Staging,
} from "./staging.server.ts";
import {
  initialRunState,
  reduceRunState,
  type RunState,
} from "./state.ts";
import { warmUp } from "./warmup.server.ts";

export interface BatchConfig {
  jarPath: string;
  javaBin: string;
  javaOpts?: readonly string[];
  concurrency: number;
  only?: readonly string[] | undefined;
  exclude?: readonly string[] | undefined;
  resume: boolean;
  dataDir: string;
  maxAttempts: number;
  loginTimeoutMs: number;
  timeoutMs: number;
  retryBackoffMs: number;
  completeTolerance: number;
  stallTimeoutMs: number | null;
  warmupTimeoutMs: number;
  skipWarmup: boolean;
  keepWorkdirs: boolean;
  /** Injected so a caller can pin the run id (and tests can be deterministic). */
  now?: () => Date;
}

export interface BatchResult {
  runId: string;
  staging: Staging;
  ok: number;
  failed: number;
  skipped: number;
  total: number;
  cancelled: boolean;
  results: PermutationResult[];
  mafiaBuild: string | null;
  /** What this run actually produced, hashed once. Handed to publishRun so the
   *  dataset is not read and hashed a second time. */
  entries: ManifestEntry[];
}

export interface RunHandle {
  readonly runId: string;
  readonly staging: Staging;
  /** Live snapshot, so a late subscriber can bootstrap without missing anything. */
  readonly state: RunState;
  onEvent(listener: (e: RunEvent) => void): () => void;
  readonly result: Promise<BatchResult>;
  cancel(): void;
}

export class UnknownPermutationsError extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super(`Unknown permutation(s): ${names.join(", ")}`);
    this.name = "UnknownPermutationsError";
    this.names = names;
  }
}

export class MissingPasswordsError extends Error {
  readonly variables: string[];
  constructor(variables: string[]) {
    super(
      `Missing ${variables.length} password(s): ${variables.slice(0, 5).join(", ")}${
        variables.length > 5 ? ", ..." : ""
      }`,
    );
    this.name = "MissingPasswordsError";
    this.variables = variables;
  }
}

/**
 * Start a batch.
 *
 * SYNCHRONOUS BY DESIGN: it must return before the first event fires, so the ink
 * app or the HTTP server can subscribe in time. Otherwise batch:start and the early
 * perm:queued events are lost and the chart begins blank. (`handle.state` also
 * covers late subscribers, but returning synchronously is the cheap fix.)
 *
 * Throws synchronously on a preflight failure, unknown ONLY names, or missing
 * passwords. The bash discovered a missing password inside the worker
 * (run-one.sh:20), so one .env typo failed one permutation 40 minutes into a batch.
 */
export function startBatch(
  cfg: BatchConfig,
  secrets: SecretStore,
): RunHandle {
  const now = cfg.now ?? (() => new Date());

  const selection = selectPermutations({
    only: cfg.only,
    exclude: cfg.exclude,
  });
  if (selection.unknown.length > 0) {
    throw new UnknownPermutationsError(selection.unknown);
  }
  const missingPasswords = secrets.missingFor(selection.selected);
  if (missingPasswords.length > 0) {
    throw new MissingPasswordsError(missingPasswords);
  }

  const runId = runIdFor(now());
  const bus = new EventBus();
  const controller = new AbortController();

  let state = initialRunState(selection.selected, {
    runId,
    concurrency: cfg.concurrency,
    maxAttempts: cfg.maxAttempts,
    startedAt: now().getTime(),
  });
  bus.on((e) => {
    state = reduceRunState(state, e);
  });

  const staging: Staging = {
    runId,
    dir: join(cfg.dataDir, "runs", runId),
    dataDir: join(cfg.dataDir, "runs", runId, "data"),
    logDir: join(cfg.dataDir, "runs", runId, "logs"),
  };

  const result = execute(
    cfg,
    secrets,
    selection.selected,
    runId,
    bus,
    controller.signal,
    now,
  );

  return {
    runId,
    staging,
    get state() {
      return state;
    },
    onEvent: (l) => bus.on(l),
    result,
    cancel: () => controller.abort(),
  };
}

async function execute(
  cfg: BatchConfig,
  secrets: SecretStore,
  selected: readonly Permutation[],
  runId: string,
  bus: EventBus,
  signal: AbortSignal,
  now: () => Date,
): Promise<BatchResult> {
  // Yield once, so the synchronous startBatch caller has subscribed before the
  // first event is emitted.
  await Promise.resolve();

  const staging = await createStaging(cfg.dataDir, runId);
  const sink = new LogSink(staging.logDir);
  const emit = (e: RunEventInit) => bus.emit(e);

  emit({
    type: "batch:start",
    runId,
    stagingDir: staging.dir,
    users: selected.map((p) => p.user),
    concurrency: cfg.concurrency,
    maxAttempts: cfg.maxAttempts,
  });

  // --- RESUME ------------------------------------------------------------
  // Consults the published manifest, NOT the filesystem. The bash's already_done()
  // accepted any nonzero-size file, so it happily re-adopted exactly the truncated
  // 4001/12070 output that the completeness guard exists to reject.
  let todo = [...selected];
  const skippedUsers = new Set<string>();
  if (cfg.resume) {
    const completeUsers = await resumableUsers(cfg.dataDir);
    for (const p of selected) {
      if (!completeUsers.has(p.user)) continue;
      skippedUsers.add(p.user);
      emit({ type: "batch:skipped", user: p.user, reason: "resume" });
    }
    todo = selected.filter((p) => !skippedUsers.has(p.user));
  }
  for (const p of todo) emit({ type: "perm:queued", user: p.user });

  // --- Warm-up -----------------------------------------------------------
  let templateDir: string | null = null;
  if (!cfg.skipWarmup && todo.length > 0 && !signal.aborted) {
    emit({ type: "batch:warmup", status: "start" });
    const candidate = join(cfg.dataDir, "work", ".template");
    const ok = await warmUp({
      jarPath: cfg.jarPath,
      javaBin: cfg.javaBin,
      ...(cfg.javaOpts ? { javaOpts: cfg.javaOpts } : {}),
      templateDir: candidate,
      timeoutMs: cfg.warmupTimeoutMs,
      onLog: (chunk) => sink.write("_warmup", chunk),
      signal,
    });
    templateDir = ok ? candidate : null;
    emit({ type: "batch:warmup", status: ok ? "ok" : "failed" });
  } else {
    emit({ type: "batch:warmup", status: "skipped" });
  }

  // --- Fan out -----------------------------------------------------------
  const results = new Map<string, PermutationResult>();
  let mafiaBuild: string | null = null;

  await pool(todo, cfg.concurrency, signal, async (p) => {
    const startedAt = now().getTime();
    // The pgid equals the spawned pid (detached: true). Tracked so a SIGTERM to us
    // reaps the JVM subtree rather than orphaning it, see reaper.server.ts.
    let livePgid: number | null = null;
    let one: RunOneResult;
    try {
      one = await runOne({
        permutation: p,
        password: secrets.passwordFor(p),
        jarPath: cfg.jarPath,
        javaBin: cfg.javaBin,
        ...(cfg.javaOpts ? { javaOpts: cfg.javaOpts } : {}),
        workDir: join(cfg.dataDir, "work", p.user),
        templateDir,
        outputDir: staging.dataDir,
        maxAttempts: cfg.maxAttempts,
        loginTimeoutMs: cfg.loginTimeoutMs,
        timeoutMs: cfg.timeoutMs,
        retryBackoffMs: cfg.retryBackoffMs,
        completeTolerance: cfg.completeTolerance,
        stallTimeoutMs: cfg.stallTimeoutMs,
        keepWorkdir: cfg.keepWorkdirs,
        signal,
        emit: (e) => {
          if (e.type === "perm:spawned" && e.pid !== null) {
            livePgid = e.pid;
            track(e.pid);
          }
          if (e.type === "perm:exited" && livePgid !== null) {
            untrack(livePgid);
            livePgid = null;
          }
          if (e.type === "perm:attempt") {
            sink.markAttempt(p.user, e.attempt, e.maxAttempts);
          }
          emit(e);
        },
        onLog: (chunk) => sink.write(p.user, chunk),
      });
    } catch (e) {
      // runOne is specified never to reject. If it does, record it rather than
      // letting the pool worker die and silently reduce concurrency.
      emit({
        type: "warn",
        user: p.user,
        message: `runOne threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      one = {
        user: p.user,
        ok: false,
        copied: 0,
        attempts: 0,
        reason: "spawn",
        itemsDone: 0,
        itemsTotal: 0,
        filesWritten: [],
        mafiaBuild: null,
      };
      emit({
        type: "perm:failed",
        user: p.user,
        attempts: 0,
        copied: 0,
        reason: "spawn",
      });
    }

    if (livePgid !== null) untrack(livePgid);
    mafiaBuild ??= one.mafiaBuild;
    results.set(p.user, {
      user: p.user,
      ok: one.ok,
      attempts: one.attempts,
      filesCopied: one.copied,
      durationMs: now().getTime() - startedAt,
      itemsDone: one.itemsDone,
      itemsTotal: one.itemsTotal,
      ...(one.reason === undefined ? {} : { reason: one.reason }),
    });
  });

  // --- Index what we produced -------------------------------------------
  // Skipped entirely when cancelled: a cancelled run is never published, so
  // hashing every collected file only to delete it is pure waste, and it races
  // the staging directory being torn down, which surfaced as a spurious ENOENT
  // on SHA256SUMS.txt.tmp.
  // Checksums are written by publishRun instead, once carry-forward has run, so
  // they cover the files it filled the gaps with.
  const entries: ManifestEntry[] = signal.aborted
    ? []
    : await indexFiles(staging, runId);

  const ok = [...results.values()].filter((r) => r.ok).length;
  const failed = [...results.values()].filter((r) => !r.ok).length;

  emit({
    type: "batch:end",
    ok,
    failed,
    skipped: skippedUsers.size,
    total: selected.length,
    cancelled: signal.aborted,
  });

  await sink.close();

  return {
    runId,
    staging,
    ok,
    failed,
    skipped: skippedUsers.size,
    total: selected.length,
    cancelled: signal.aborted,
    results: [...results.values()],
    mafiaBuild,
    entries,
  };
}

/**
 * Users whose published output is trustworthy enough to skip.
 *
 * Manifest-driven: an entry exists only if the file was indexed at publish time,
 * and the run's own results record whether the derive actually completed.
 */
async function resumableUsers(dataDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const dir = await resolveCurrent(dataDir);
  if (dir === null) return out;
  const manifest = await readManifest(dir);
  if (manifest === null) return out;

  const byUser = new Map<string, number>();
  for (const e of manifest.entries) {
    byUser.set(e.user, (byUser.get(e.user) ?? 0) + 1);
  }
  const okUsers = new Set(
    manifest.results.filter((r) => r.ok).map((r) => r.user),
  );
  for (const [user, count] of byUser) {
    if (count === 3 && okUsers.has(user)) out.add(user);
  }
  return out;
}

/**
 * Bounded-concurrency pool. ~20 lines, and deliberately not p-limit.
 *
 * p-limit has no cancellation, and we need abort-aware ADMISSION so a Ctrl-C does
 * not launch more JVMs while the current ones are being torn down. Admission order
 * also matches the task list, matching `xargs -P N -L1` for reproducibility.
 */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (i < items.length) {
      // Stop ADMITTING on abort. Do not reject work already in flight, which
      // handles its own cancellation via the same signal.
      if (signal.aborted) return;
      const item = items[i++]!;
      await fn(item);
    }
  });

  const settled = await Promise.allSettled(workers);
  const failures = settled.filter((s) => s.status === "rejected");
  if (failures.length > 0) {
    // A rejected worker means fn leaked an exception, which silently reduces
    // effective concurrency. fn is specified never to throw, so this is a bug.
    throw new AggregateError(
      failures.map((f) => (f as PromiseRejectedResult).reason),
      "pool worker(s) threw; effective concurrency was reduced",
    );
  }
}

/** All 54 permutations, re-exported for callers that want the default selection. */
export { ALL_PERMUTATIONS };
