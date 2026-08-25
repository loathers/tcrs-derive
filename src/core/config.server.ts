/**
 * Configuration defaults and env resolution. NODE-ONLY.
 *
 * Every default matches the bash (README's env-var table), except CONCURRENCY —
 * see the comment there.
 */

import type { BatchConfig } from "./runBatch.server.ts";

export const DEFAULTS = {
  /**
   * The bash defaulted to 4 and was run at 6. In a container a memory limit is a
   * HARD ceiling where a VPS's RAM is soft, and an OOM-killed JVM mid-derive costs
   * a whole permutation — so default lower and let the operator raise it after
   * watching real RSS. The other constraint is unchanged: 54 logins from one IP.
   */
  concurrency: 3,
  timeoutMs: 1_800_000, // TIMEOUT=1800
  loginTimeoutMs: 180_000, // LOGIN_TIMEOUT=180
  maxAttempts: 3, // MAX_ATTEMPTS=3
  retryBackoffMs: 15_000, // RETRY_BACKOFF=15
  completeTolerance: 150, // COMPLETE_TOLERANCE=150
  warmupTimeoutMs: 300_000, // the bash's `sleep 300` killer
  stallTimeoutMs: null as number | null, // new, opt-in
  cooldownHours: 12,
  /** A total failure costs KoL nothing; locking a public site for 12h over one is
   *  user-hostile. */
  failedCooldownHours: 1,
  /** Below this, refuse to start rather than publish a truncated dataset. */
  minFreeBytes: 2 * 1024 * 1024 * 1024,
} as const;

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return items.length > 0 ? items : undefined;
}

function bool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  overrides?: Partial<BatchConfig>;
}

/** Build a BatchConfig from the environment, then apply explicit overrides. */
export function resolveBatchConfig(o: ResolveOptions = {}): BatchConfig {
  const env = o.env ?? process.env;
  const javaOpts = (env["JAVA_OPTS"] ?? "")
    .split(/\s+/)
    .filter((s) => s !== "");

  const cfg: BatchConfig = {
    jarPath: env["JAR"] ?? "KoLmafia.jar",
    javaBin: env["JAVA_BIN"] ?? "java",
    ...(javaOpts.length > 0 ? { javaOpts } : {}),
    concurrency: num(env["CONCURRENCY"], DEFAULTS.concurrency),
    only: list(env["ONLY"]),
    exclude: list(env["EXCLUDE"]),
    resume: bool(env["RESUME"]),
    dataDir: env["DATA_DIR"] ?? "data",
    maxAttempts: num(env["MAX_ATTEMPTS"], DEFAULTS.maxAttempts),
    loginTimeoutMs: num(env["LOGIN_TIMEOUT"], DEFAULTS.loginTimeoutMs / 1000) * 1000,
    timeoutMs: num(env["TIMEOUT"], DEFAULTS.timeoutMs / 1000) * 1000,
    retryBackoffMs: num(env["RETRY_BACKOFF"], DEFAULTS.retryBackoffMs / 1000) * 1000,
    completeTolerance: num(env["COMPLETE_TOLERANCE"], DEFAULTS.completeTolerance),
    stallTimeoutMs:
      env["STALL_TIMEOUT"] === undefined
        ? DEFAULTS.stallTimeoutMs
        : num(env["STALL_TIMEOUT"], 0) * 1000 || null,
    warmupTimeoutMs: num(env["WARMUP_TIMEOUT"], DEFAULTS.warmupTimeoutMs / 1000) * 1000,
    skipWarmup: bool(env["SKIP_WARMUP"]),
    keepWorkdirs: bool(env["KEEP_WORKDIRS"]),
  };
  return { ...cfg, ...o.overrides };
}

export function cooldownHoursFrom(
  env: Record<string, string | undefined> = process.env,
): { success: number; failed: number } {
  return {
    success: num(env["COOLDOWN_HOURS"], DEFAULTS.cooldownHours),
    failed: num(env["FAILED_COOLDOWN_HOURS"], DEFAULTS.failedCooldownHours),
  };
}
