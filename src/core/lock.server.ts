/**
 * Single-instance lock. NODE-ONLY.
 *
 * Replaces run-all.sh:42-48, which was
 * `[ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")"` — a TOCTOU race, and PID-reuse-prone:
 * a recycled pid made it refuse to start FOREVER.
 *
 * WHY THIS IS NOT JUST A PID FILE.
 * The lock protects a DATA DIRECTORY, and in production that directory is a Docker
 * volume that two containers can mount at once (a rolling deploy starts the new
 * container before stopping the old one). Each container has its OWN PID NAMESPACE,
 * so a pid recorded by one is meaningless to the other — pid 7 there is either
 * absent or an unrelated process here. A pure pid check therefore fails open, and
 * two servers would happily run batches against one volume.
 *
 * So the holder is identified by `<hostname> <pid> <iso>` and liveness is decided
 * two ways:
 *   - same hostname  -> the pid IS comparable, so check it directly (exact, fast);
 *   - other hostname -> fall back to a HEARTBEAT: the holder touches the file's
 *     mtime periodically, and a lock that has gone quiet for STALE_MS is reclaimed.
 *
 * The create itself is `open(path, "wx")` — an atomic O_EXCL — so the acquisition
 * is race-free regardless of which liveness rule applies.
 */

import { hostname } from "node:os";
import { open, readFile, rm, stat, utimes } from "node:fs/promises";

/** How often a holder proves it is still alive. */
export const HEARTBEAT_MS = 15_000;
/** How quiet a lock must go before another process may reclaim it. */
export const STALE_MS = 60_000;

export interface Lock {
  readonly path: string;
  release(): Promise<void>;
}

export class LockHeldError extends Error {
  readonly path: string;
  readonly holder: string;
  constructor(path: string, holder: string) {
    super(`Another instance holds ${path} (${holder})`);
    this.name = "LockHeldError";
    this.path = path;
    this.holder = holder;
  }
}

export interface AcquireOptions {
  /** Injectable for tests. */
  now?: () => number;
  host?: string;
  staleMs?: number;
  heartbeatMs?: number;
}

export async function acquireLock(
  path: string,
  o: AcquireOptions = {},
): Promise<Lock> {
  const host = o.host ?? hostname();
  const staleMs = o.staleMs ?? STALE_MS;
  const heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
  const now = o.now ?? Date.now;

  try {
    return await create(path, host, heartbeatMs);
  } catch (e) {
    if (!isEexist(e)) throw e;
  }

  // Occupied. Decide whether the holder is still alive.
  const raw = (await readFile(path, "utf8").catch(() => "")).trim();
  const [holderHost = "", holderPid = ""] = raw.split(/\s+/);
  const describe = raw === "" ? "unknown holder" : raw;

  if (holderHost === host) {
    // Same machine (or the same container): the pid is directly comparable.
    const pid = Number(holderPid);
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
      throw new LockHeldError(path, describe);
    }
  } else {
    // Different host or PID namespace: fall back to the heartbeat.
    const age = await ageOf(path, now);
    if (age !== null && age < staleMs) {
      throw new LockHeldError(
        path,
        `${describe}; last heartbeat ${Math.round(age / 1000)}s ago`,
      );
    }
  }

  // Stale. Remove and retry once; if someone else wins that race, their create
  // succeeds and ours throws LockHeldError rather than double-acquiring.
  await rm(path, { force: true });
  try {
    return await create(path, host, heartbeatMs);
  } catch (e) {
    if (isEexist(e)) throw new LockHeldError(path, "raced with another process");
    throw e;
  }
}

async function create(
  path: string,
  host: string,
  heartbeatMs: number,
): Promise<Lock> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(
      `${host} ${process.pid} ${new Date().toISOString()}\n`,
    );
  } finally {
    await handle.close();
  }

  // Prove liveness to any other host sharing this volume. unref'd, so holding the
  // lock never keeps the process alive on its own.
  const beat = setInterval(() => {
    const t = new Date();
    void utimes(path, t, t).catch(() => {});
  }, heartbeatMs);
  beat.unref?.();

  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      await rm(path, { force: true });
    },
  };
}

async function ageOf(path: string, now: () => number): Promise<number | null> {
  try {
    const st = await stat(path);
    return Math.max(0, now() - st.mtimeMs);
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isEexist(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "EEXIST";
}
