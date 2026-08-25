/**
 * Persistent run state: the cooldown, the attempt history, and boot recovery.
 * NODE-ONLY.
 *
 * `state.json` is kept SEPARATE from the run manifests for two reasons:
 *   1. A FAILED run must also consume cooldown, or a bot can hammer the generate
 *      button in a hot loop through a persistently-failing run.
 *   2. A failed run leaves no `current` to read the timestamp from.
 */

import { statfs } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearWork,
  paths,
  pruneRuns,
  readManifest,
  resolveCurrent,
  unlinkCurrent,
  writeAtomic,
  type RunOutcome,
} from "#core/staging.server";

export interface Attempt {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: RunOutcome | null;
}

export interface PersistedState {
  version: 1;
  /** Non-null at boot means the process died mid-run: an orphan to clean up. */
  activeRunId: string | null;
  currentRunId: string | null;
  /** Newest first, capped. */
  attempts: Attempt[];
}

const EMPTY: PersistedState = {
  version: 1,
  activeRunId: null,
  currentRunId: null,
  attempts: [],
};

const MAX_ATTEMPTS_KEPT = 20;
/** A crash sooner than this must not lock the site for half a day. */
const EARLY_ABORT_MS = 5 * 60 * 1000;

export interface CooldownConfig {
  successHours: number;
  failedHours: number;
}

export interface CooldownInfo {
  hours: number;
  nextAllowedAt: string | null;
  remainingMs: number;
  canGenerate: boolean;
}

export class Store {
  #state: PersistedState = EMPTY;

  readonly dataDir: string;
  readonly #cooldown: CooldownConfig;
  readonly #now: () => number;

  constructor(
    dataDir: string,
    cooldown: CooldownConfig,
    now: () => number = Date.now,
  ) {
    this.dataDir = dataDir;
    this.#cooldown = cooldown;
    this.#now = now;
  }

  get state(): PersistedState {
    return this.#state;
  }

  get statePath(): string {
    return join(this.dataDir, "state.json");
  }

  /**
   * Load state and recover from an unclean shutdown.
   *
   * Steps 2-5 exist because a container can be SIGKILLed at any moment (Docker's
   * default stop timeout is 10s, and Coolify may be less).
   */
  async init(): Promise<{ recovered: string | null; pruned: string[] }> {
    this.#state = await this.#read();

    let recovered: string | null = null;

    // 1. An active run recorded at boot means we died mid-run. Its staging dir is
    //    incomplete and must never be published.
    const orphan = this.#state.activeRunId;
    if (orphan !== null) {
      const attempt = this.#state.attempts.find((a) => a.id === orphan);
      const startedAt = attempt ? Date.parse(attempt.startedAt) : this.#now();
      const ranFor = this.#now() - startedAt;
      await this.#closeAttempt(
        orphan,
        ranFor < EARLY_ABORT_MS ? "aborted-early" : "aborted",
      );
      this.#state = { ...this.#state, activeRunId: null };
      recovered = orphan;
    }

    // 2. Reconcile `current`: unlink it if it is dangling, or points at a run
    //    whose manifest never finished (i.e. it was published mid-write).
    const currentDir = await resolveCurrent(this.dataDir);
    if (currentDir === null) {
      await unlinkCurrent(this.dataDir);
      this.#state = { ...this.#state, currentRunId: null };
    } else {
      const manifest = await readManifest(currentDir);
      if (manifest === null || manifest.finishedAt === null) {
        await unlinkCurrent(this.dataDir);
        this.#state = { ...this.#state, currentRunId: null };
      } else {
        this.#state = { ...this.#state, currentRunId: manifest.id };
      }
    }

    // 3. GC any run dir that is neither published nor active. Catches a kill
    //    inside the swap window.
    const keep = this.#state.currentRunId === null ? [] : [this.#state.currentRunId];
    const pruned = await pruneRuns(this.dataDir, keep);

    // 4. Each killed JVM leaves a full mafia data tree behind; 54 of them is real
    //    disk.
    await clearWork(this.dataDir);

    await this.#persist();
    return { recovered, pruned };
  }

  /** Record the start of a run. */
  async beginAttempt(runId: string, startedAt: number): Promise<void> {
    const attempt: Attempt = {
      id: runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: null,
      outcome: null,
    };
    this.#state = {
      ...this.#state,
      activeRunId: runId,
      attempts: [attempt, ...this.#state.attempts].slice(0, MAX_ATTEMPTS_KEPT),
    };
    await this.#persist();
  }

  async endAttempt(runId: string, outcome: RunOutcome): Promise<void> {
    await this.#closeAttempt(runId, outcome);
    this.#state = { ...this.#state, activeRunId: null };
    await this.#persist();
  }

  async setCurrent(runId: string): Promise<void> {
    this.#state = { ...this.#state, currentRunId: runId };
    await this.#persist();
  }

  get lastAttempt(): Attempt | null {
    return this.#state.attempts[0] ?? null;
  }

  /**
   * How long until another run is allowed.
   *
   * Measured from the last attempt's START, not its finish, so a 7.5-minute run
   * does not drift the window later each time.
   */
  cooldownInfo(): CooldownInfo {
    const last = this.lastAttempt;
    if (last === null) {
      return {
        hours: this.#cooldown.successHours,
        nextAllowedAt: null,
        remainingMs: 0,
        canGenerate: true,
      };
    }

    const hours = hoursFor(last.outcome, this.#cooldown);
    if (hours === 0) {
      return { hours: 0, nextAllowedAt: null, remainingMs: 0, canGenerate: true };
    }

    const started = Date.parse(last.startedAt);
    const nextAllowed = started + hours * 3_600_000;
    const remainingMs = Math.max(0, nextAllowed - this.#now());
    return {
      hours,
      nextAllowedAt: new Date(nextAllowed).toISOString(),
      remainingMs,
      canGenerate: remainingMs === 0,
    };
  }

  /** Free bytes on the data volume, or null if unavailable. */
  async freeBytes(): Promise<number | null> {
    try {
      const fs = await statfs(this.dataDir);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch {
      return null;
    }
  }

  async #closeAttempt(runId: string, outcome: RunOutcome): Promise<void> {
    this.#state = {
      ...this.#state,
      attempts: this.#state.attempts.map((a) =>
        a.id === runId && a.finishedAt === null
          ? { ...a, finishedAt: new Date(this.#now()).toISOString(), outcome }
          : a,
      ),
    };
  }

  async #read(): Promise<PersistedState> {
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as PersistedState;
      if (parsed.version !== 1) return EMPTY;
      return {
        version: 1,
        activeRunId: parsed.activeRunId ?? null,
        currentRunId: parsed.currentRunId ?? null,
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
      };
    } catch {
      return EMPTY;
    }
  }

  async #persist(): Promise<void> {
    await writeAtomic(this.statePath, JSON.stringify(this.#state, null, 2));
  }
}

/**
 * The cooldown window for a given outcome.
 *
 * A total failure (KoL down, say) costs KoL nothing, so locking a public site for
 * 12 hours over one is user-hostile, hence the shorter window. And a crash within
 * the first few minutes is treated as never having happened.
 */
export function hoursFor(
  outcome: RunOutcome | null,
  cfg: CooldownConfig,
): number {
  switch (outcome) {
    case "success":
    case "partial":
    case "aborted":
      return cfg.successHours;
    case "failed":
      return cfg.failedHours;
    case "aborted-early":
      return 0;
    case null:
      // Still running: the single-flight lock is what blocks a second run, not the
      // cooldown.
      return cfg.successHours;
  }
}

export { paths };
