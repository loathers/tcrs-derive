/**
 * The RunEvent union, THE WIRE FORMAT.
 *
 * PURE: no `node:` imports. This union is the seam between the runner and every
 * view of it. It is emitted server-side by runBatch, folded into RunState by
 * state.ts, and shipped verbatim over SSE to the browser and to `tcrs attach`.
 *
 * HARD CONSTRAINT: every member must be plain-JSON round-trippable. No Date, no
 * Error, no Map/Set, no Buffer, no meaningful `undefined`. It goes onto the wire
 * with JSON.stringify and must survive JSON.parse unchanged.
 *
 * Raw stdout deliberately does NOT travel here. It is a separate LogChunk channel
 * (see below): RunEvent is ~8k events per batch, whereas raw lines would be ~50k of
 * high-churn traffic through the reducer and every connected client for no UI gain.
 */

export type Phase = "items" | "cafe_booze" | "cafe_food";

export type FailureReason =
  | "login" // never got as far as deriving
  | "incomplete" // derive bailed early, partial output discarded
  | "timeout" // hit the overall per-permutation TIMEOUT
  | "stalled" // no progress for stallTimeout
  | "not-in-tcrs" // account is not in a TCRS run, so never retried
  | "no-files" // ran, but wrote nothing
  | "spawn" // couldn't start the JVM at all
  | "cancelled"; // aborted by the operator or a shutdown

export type WarmupStatus = "start" | "ok" | "failed" | "skipped";

interface Base {
  /** Monotonic from 1 within a run. Used as the SSE `id:` and for deterministic
   *  reducer tests. */
  readonly seq: number;
  /** Epoch ms. The reducer takes ALL its time from this, it never calls
   *  Date.now(), which is what keeps it pure and snapshot-testable. */
  readonly at: number;
}

export type RunEvent = Base &
  (
    | {
        type: "batch:start";
        runId: string;
        stagingDir: string;
        users: readonly string[];
        concurrency: number;
        maxAttempts: number;
      }
    | { type: "batch:warmup"; status: WarmupStatus }
    | { type: "batch:skipped"; user: string; reason: "resume" }
    | { type: "batch:swapped"; currentDir: string }
    | {
        type: "batch:end";
        ok: number;
        failed: number;
        skipped: number;
        total: number;
        cancelled: boolean;
      }
    | { type: "perm:queued"; user: string }
    | { type: "perm:attempt"; user: string; attempt: number; maxAttempts: number }
    | { type: "perm:spawned"; user: string; attempt: number; pid: number | null }
    | { type: "perm:phase"; user: string; phase: Phase }
    | { type: "perm:progress"; user: string; done: number; total: number }
    | { type: "perm:transient"; user: string; marker: string }
    | { type: "perm:loginTimeout"; user: string; seconds: number }
    | { type: "perm:hardTimeout"; user: string; seconds: number }
    | { type: "perm:wrote"; user: string; file: string }
    | {
        type: "perm:exited";
        user: string;
        code: number | null;
        signal: string | null;
      }
    | { type: "perm:collected"; user: string; copied: number; complete: boolean }
    | { type: "perm:discarded"; user: string; reason: "incomplete" }
    | {
        type: "perm:retryWait";
        user: string;
        seconds: number;
        nextAttempt: number;
      }
    | { type: "perm:done"; user: string; attempts: number }
    | {
        type: "perm:failed";
        user: string;
        attempts: number;
        copied: number;
        reason: FailureReason;
      }
    | { type: "warn"; user: string | null; message: string }
  );

export type RunEventType = RunEvent["type"];

/** A RunEvent before the bus stamps it with seq/at. */
export type RunEventInit = DistributiveOmit<RunEvent, "seq" | "at">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Raw child output, on its own channel, deliberately NOT a RunEvent.
 * Consumed by logSink to write the per-permutation log file, and servable on
 * request. Never broadcast to every client.
 */
export interface LogChunk {
  readonly user: string;
  readonly attempt: number;
  readonly at: number;
  readonly chunk: string;
}
