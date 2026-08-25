/**
 * RunState and the event reducer — THE SEAM.
 *
 * PURE: no `node:` imports, no Date.now(), no Math.random, no I/O. This exact
 * function runs in three places:
 *   - server-side, folding runBatch's events into the authoritative state
 *   - in the browser, folding the SSE stream
 *   - in `tcrs attach`, folding the same SSE stream
 * so the web page and the terminal chart provably cannot drift.
 *
 * The reference implementation is compute_states() in run-all.sh:145-206, which
 * re-derived all of this every 1.5s by grepping 54 growing log files.
 */

import type { FailureReason, Phase, RunEvent } from "./events.ts";
import type { Permutation } from "./permutations.ts";

export interface Progress {
  readonly done: number;
  readonly total: number;
}

export type PermStatus =
  | { readonly kind: "queued" }
  | { readonly kind: "skipped"; readonly reason: "resume" }
  | { readonly kind: "login" }
  | { readonly kind: "stalled" }
  | {
      readonly kind: "deriving";
      readonly phase: Phase;
      /**
       * null during the cafe phases, because mafia emits no Progress: lines for
       * them. Keeping the reducer honest here is what makes it STRUCTURALLY
       * IMPOSSIBLE for a view to render a stale items percentage during a cafe
       * phase — the bash instead special-cased it in the renderer
       * (run-all.sh:192-196), which meant two renderers would each have to
       * re-derive the rule. See present.ts, where it lives exactly once.
       */
      readonly progress: Progress | null;
    }
  | {
      readonly kind: "retrying";
      readonly nextAttempt: number;
      readonly waitUntil: number;
    }
  | { readonly kind: "done" }
  | {
      readonly kind: "failed";
      readonly copied: number;
      readonly reason: FailureReason;
    };

export interface PermState {
  readonly user: string;
  readonly classToken: string;
  readonly classLabel: string;
  readonly signCap: string;
  /** 0 until the first perm:attempt. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly status: PermStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly sawTransient: boolean;
  readonly filesWritten: readonly string[];
}

export interface RunSummary {
  readonly total: number;
  readonly done: number;
  readonly running: number;
  readonly failed: number;
  readonly queued: number;
  readonly skipped: number;
}

export type WarmupState = "pending" | "running" | "ok" | "failed" | "skipped";

export interface RunState {
  readonly runId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly cancelled: boolean;
  readonly warmup: WarmupState;
  readonly concurrency: number;
  /** Row order — CLASS_ORDER x SIGNS, load-bearing for the chart and the grid. */
  readonly order: readonly string[];
  readonly perms: Readonly<Record<string, PermState>>;
  readonly summary: RunSummary;
  readonly lastSeq: number;
  /** mafia's build banner, once seen. Recorded in the manifest. */
  readonly mafiaBuild: string | null;
}

export interface InitialStateConfig {
  readonly runId: string;
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly startedAt?: number | null;
}

export function initialRunState(
  permutations: readonly Permutation[],
  cfg: InitialStateConfig,
): RunState {
  const perms: Record<string, PermState> = {};
  for (const p of permutations) {
    perms[p.user] = {
      user: p.user,
      classToken: p.classToken,
      classLabel: p.classLabel,
      signCap: p.signCap,
      attempt: 0,
      maxAttempts: cfg.maxAttempts,
      status: { kind: "queued" },
      startedAt: null,
      endedAt: null,
      sawTransient: false,
      filesWritten: [],
    };
  }
  return {
    runId: cfg.runId,
    startedAt: cfg.startedAt ?? null,
    endedAt: null,
    cancelled: false,
    warmup: "pending",
    concurrency: cfg.concurrency,
    order: permutations.map((p) => p.user),
    perms,
    summary: recount(perms, permutations.length),
    lastSeq: 0,
    mafiaBuild: null,
  };
}

/**
 * The summary is RECOMPUTED from perms on every reduce rather than incremented.
 * 54 entries is free, and incremental counters are the classic source of
 * "Overall: 55/54 done" drift.
 */
function recount(
  perms: Readonly<Record<string, PermState>>,
  total: number,
): RunSummary {
  let done = 0;
  let running = 0;
  let failed = 0;
  let queued = 0;
  let skipped = 0;
  for (const user in perms) {
    switch (perms[user]!.status.kind) {
      case "done":
        done++;
        break;
      case "failed":
        failed++;
        break;
      case "queued":
        queued++;
        break;
      case "skipped":
        skipped++;
        break;
      // login / stalled / deriving / retrying all count as in-flight. Note the
      // bash counted a permutation in retry-backoff as running while still
      // displaying its previous phase; `retrying` is now an explicit status.
      case "login":
      case "stalled":
      case "deriving":
      case "retrying":
        running++;
        break;
    }
  }
  return { total, done, running, failed, queued, skipped };
}

/**
 * Fold one event into the state.
 *
 * TOTAL: an unknown event type returns the state unchanged. A browser holding a
 * stale bundle after a deploy must not white-screen on an event it doesn't know.
 */
export function reduceRunState(state: RunState, event: RunEvent): RunState {
  const next = apply(state, event);
  if (next === state) return state;
  return next.lastSeq === event.seq
    ? next
    : { ...next, lastSeq: Math.max(next.lastSeq, event.seq) };
}

export function reduceAll(
  state: RunState,
  events: Iterable<RunEvent>,
): RunState {
  let s = state;
  for (const e of events) s = reduceRunState(s, e);
  return s;
}

function apply(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "batch:start":
      return { ...state, runId: event.runId, startedAt: event.at };

    case "batch:warmup":
      return {
        ...state,
        warmup:
          event.status === "start"
            ? "running"
            : event.status === "ok"
              ? "ok"
              : event.status === "failed"
                ? "failed"
                : "skipped",
      };

    case "batch:skipped":
      // The bash filtered resume-skipped permutations out of the task list
      // entirely, so they vanished from the chart AND the totals — resuming 52 of
      // 54 showed an alarming "Overall: 0/2 done". They are now visible rows.
      return patch(state, event.user, () => ({
        status: { kind: "skipped", reason: event.reason },
      }));

    case "batch:swapped":
      return state;

    case "batch:end":
      return { ...state, endedAt: event.at, cancelled: event.cancelled };

    case "perm:queued":
      return patch(state, event.user, () => ({ status: { kind: "queued" } }));

    case "perm:attempt":
      // A new attempt resets everything attempt-scoped. This is what replaces the
      // bash's `=== attempt N/M ===` marker and current_attempt_block() slicing.
      return patch(state, event.user, (p) => ({
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        status: { kind: "login" },
        sawTransient: false,
        startedAt: p.startedAt ?? event.at,
      }));

    case "perm:spawned":
      return state;

    case "perm:phase":
      // progress starts null on every phase change; only the items phase will
      // ever fill it in.
      return patch(state, event.user, () => ({
        status: { kind: "deriving", phase: event.phase, progress: null },
      }));

    case "perm:progress":
      return patch(state, event.user, (p) => ({
        status: {
          kind: "deriving",
          // A progress line before any phase header belongs to items — that is
          // the only phase that reports.
          phase: p.status.kind === "deriving" ? p.status.phase : "items",
          progress: { done: event.done, total: event.total },
        },
      }));

    case "perm:transient":
      // Mirrors the bash: a timeout marker shows as `stalled` only while we have
      // not yet started deriving. Once a phase is running, transients are noise
      // and the completeness guard handles the fallout.
      return patch(state, event.user, (p) => ({
        sawTransient: true,
        status: p.status.kind === "login" ? { kind: "stalled" } : p.status,
      }));

    case "perm:loginTimeout":
    case "perm:hardTimeout":
      return patch(state, event.user, () => ({ status: { kind: "stalled" } }));

    case "perm:wrote":
      return patch(state, event.user, (p) => ({
        filesWritten: p.filesWritten.includes(event.file)
          ? p.filesWritten
          : [...p.filesWritten, event.file],
      }));

    case "perm:exited":
    case "perm:collected":
      return state;

    case "perm:discarded":
      // Partial output was thrown away; the files are no longer published.
      return patch(state, event.user, () => ({ filesWritten: [] }));

    case "perm:retryWait":
      return patch(state, event.user, () => ({
        status: {
          kind: "retrying",
          nextAttempt: event.nextAttempt,
          // Derived from the event's own timestamp, never Date.now() — that is
          // what keeps this reducer pure and snapshot-testable.
          waitUntil: event.at + event.seconds * 1000,
        },
      }));

    case "perm:done":
      return patch(state, event.user, () => ({
        attempt: event.attempts,
        status: { kind: "done" },
        endedAt: event.at,
      }));

    case "perm:failed":
      return patch(state, event.user, () => ({
        attempt: event.attempts,
        status: { kind: "failed", copied: event.copied, reason: event.reason },
        endedAt: event.at,
      }));

    case "warn":
      return state;

    default:
      // Unknown event type: return unchanged rather than throwing.
      return state;
  }
}

/** Replace one permutation's state immutably, structurally sharing the rest. */
function patch(
  state: RunState,
  user: string,
  fn: (p: PermState) => Partial<PermState>,
): RunState {
  const current = state.perms[user];
  // An event for a permutation this run isn't tracking (a stale client, a filtered
  // batch) must be ignored, not crash.
  if (!current) return state;

  const updated = { ...current, ...fn(current) };
  const perms = { ...state.perms, [user]: updated };
  return { ...state, perms, summary: recount(perms, state.summary.total) };
}

/** Convenience for views: the permutations in row order. */
export function orderedPerms(state: RunState): PermState[] {
  return state.order.map((u) => state.perms[u]!).filter(Boolean);
}
