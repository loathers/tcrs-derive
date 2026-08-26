/**
 * Staging directories, the run manifest, and the atomic publish swap. NODE-ONLY.
 *
 * This is the machinery a web UI forces on us. run-one.sh copied files into the
 * live `out/` as each account finished, so mid-run the site would serve a mix of
 * old and new files. Runs now write to `runs/<runId>/` and become visible only via
 * one atomic symlink swap.
 *
 *   <dataDir>/
 *     state.json                       cooldown + attempt history (store.server.ts)
 *     current -> runs/2026-08-24T09-15-03-123Z
 *     runs/<runId>/
 *       data/          the 162 TCRS_*.txt (+ SHA256SUMS.txt)
 *       logs/          <user>.log, _warmup.log
 *       manifest.json
 *       tcrs-data.zip
 *     work/            per-JVM scratch + the warm-up template
 */

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { FailureReason } from "./events.ts";
import { buildZip } from "./zip.server.ts";
import {
  ALL_FILE_NAMES,
  permutationForFile,
  type FileKind,
} from "./permutations.ts";

export const CURRENT_LINK = "current";
export const RUNS_DIR = "runs";
export const WORK_DIR = "work";
export const MANIFEST_NAME = "manifest.json";
export const ZIP_NAME = "tcrs-data.zip";
export const SUMS_NAME = "SHA256SUMS.txt";

export type RunOutcome =
  | "success"
  | "partial"
  | "failed"
  | "aborted"
  | "aborted-early";

export interface PermutationResult {
  user: string;
  ok: boolean;
  attempts: number;
  filesCopied: number;
  durationMs: number;
  itemsDone: number;
  itemsTotal: number;
  reason?: FailureReason;
}

export interface ManifestEntry {
  name: string;
  user: string;
  kind: FileKind;
  bytes: number;
  sha256: string;
  /** Differs from the manifest's own id when carried forward from an older run. */
  sourceRunId: string;
}

export interface RunManifest {
  version: 1;
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: RunOutcome | null;
  durationMs: number | null;
  concurrency: number;
  mafiaBuild: string | null;
  results: PermutationResult[];
  entries: ManifestEntry[];
  zip: { name: string; bytes: number; sha256: string } | null;
  totalBytes: number;
}

export interface Staging {
  runId: string;
  dir: string;
  dataDir: string;
  logDir: string;
}

export interface Paths {
  root: string;
  runs: string;
  work: string;
  current: string;
}

export function paths(dataDir: string): Paths {
  return {
    root: dataDir,
    runs: join(dataDir, RUNS_DIR),
    work: join(dataDir, WORK_DIR),
    current: join(dataDir, CURRENT_LINK),
  };
}

/**
 * A filesystem- and URL-safe run id. Raw ISO's `:` is legal on ext4 but breaks
 * exfat/CIFS backup targets and needs quoting in a shell. The true instant is kept
 * in the manifest.
 */
export function runIdFor(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function createStaging(
  dataDir: string,
  runId: string,
): Promise<Staging> {
  const dir = join(dataDir, RUNS_DIR, runId);
  const staging: Staging = {
    runId,
    dir,
    dataDir: join(dir, "data"),
    logDir: join(dir, "logs"),
  };
  await mkdir(staging.dataDir, { recursive: true });
  await mkdir(staging.logDir, { recursive: true });
  return staging;
}

export async function writeManifest(
  staging: Staging,
  manifest: RunManifest,
): Promise<void> {
  await writeAtomic(
    join(staging.dir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2),
  );
}

export async function readManifest(
  runDir: string,
): Promise<RunManifest | null> {
  try {
    const text = await readFile(join(runDir, MANIFEST_NAME), "utf8");
    const parsed = JSON.parse(text) as RunManifest;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** The manifest of the currently published run, or null if nothing is published. */
export async function readCurrentManifest(
  dataDir: string,
): Promise<RunManifest | null> {
  const dir = await resolveCurrent(dataDir);
  return dir === null ? null : readManifest(dir);
}

/**
 * Resolve `current` to a real directory, or null.
 *
 * Resolved PER REQUEST rather than cached at boot, which is what lets an in-flight
 * download survive a swap: POSIX keeps an open fd's inode alive after the old run
 * directory is deleted.
 */
export async function resolveCurrent(dataDir: string): Promise<string | null> {
  try {
    const resolved = await realpath(join(dataDir, CURRENT_LINK));
    const st = await stat(resolved);
    return st.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Publish a staged run atomically.
 *
 * `rename` over an existing symlink is atomic on Linux, so there is never a window
 * where `current` is absent, an unlink-then-symlink would leave one.
 *
 * The symlink target is RELATIVE, so the whole data tree can be moved or bind
 * mounted at a different path (which matters in a container) without breaking.
 */
export async function promote(dataDir: string, runId: string): Promise<void> {
  const tmp = join(dataDir, `.${CURRENT_LINK}.tmp`);
  await rm(tmp, { force: true });
  await symlink(join(RUNS_DIR, runId), tmp);
  await rename(tmp, join(dataDir, CURRENT_LINK));
}

/** Delete every run directory except the ones named. */
export async function pruneRuns(
  dataDir: string,
  keep: readonly string[],
): Promise<string[]> {
  const keepSet = new Set(keep);
  const runsDir = join(dataDir, RUNS_DIR);
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (keepSet.has(name)) continue;
    await rm(join(runsDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Fill gaps in a staged run from the previously published one.
 *
 * Rationale: this data is consumed per-permutation, so a consumer wanting
 * TCRS_Sauceror_Vole.txt is strictly better off with 53 fresh files plus one
 * twelve-hour-old file than with a 404. Every carried entry records its
 * sourceRunId so the UI can mark it stale.
 */
export async function carryForward(
  staging: Staging,
  previous: { dir: string; manifest: RunManifest } | null,
  missing: readonly string[],
): Promise<ManifestEntry[]> {
  if (previous === null || missing.length === 0) return [];
  const byName = new Map(previous.manifest.entries.map((e) => [e.name, e]));
  const carried: ManifestEntry[] = [];

  for (const name of missing) {
    const entry = byName.get(name);
    if (!entry) continue;
    const src = join(previous.dir, "data", name);
    try {
      await copyFile(src, join(staging.dataDir, name));
      carried.push({ ...entry });
    } catch {
      // The previous file is gone. The entry simply stays missing.
    }
  }
  return carried;
}

/** Hash and measure every published file, producing the manifest entries. */
export async function indexFiles(
  staging: Staging,
  runId: string,
): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const name of ALL_FILE_NAMES) {
    const meta = permutationForFile(name);
    if (!meta) continue;
    const path = join(staging.dataDir, name);
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size === 0) continue;
      entries.push({
        name,
        user: meta.permutation.user,
        kind: meta.kind,
        bytes: st.size,
        sha256: await sha256File(path),
        sourceRunId: runId,
      });
    } catch {
      // Not present in this run.
    }
  }
  return entries;
}

export async function sha256File(path: string): Promise<string> {
  // These files are ~950KB; reading whole is fine and keeps this dependency-free.
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** Write SHA256SUMS.txt in the format `sha256sum -c` expects. */
export async function writeSums(
  staging: Staging,
  entries: readonly ManifestEntry[],
): Promise<void> {
  const body = entries
    .map((e) => `${e.sha256}  ${e.name}`)
    .sort()
    .join("\n");
  await writeAtomic(join(staging.dataDir, SUMS_NAME), body + "\n");
}

/** Write via a temp file plus rename, so a crash never leaves a torn file. */
export async function writeAtomic(
  path: string,
  contents: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

/** Remove per-JVM scratch trees. Each is a full mafia data tree, so this is real
 *  disk, the bash reclaimed it per permutation and we do it per run as well. */
export async function clearWork(dataDir: string): Promise<void> {
  const work = join(dataDir, WORK_DIR);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
}

/** Remove a stale `current` symlink (used by boot recovery). */
export async function unlinkCurrent(dataDir: string): Promise<void> {
  await unlink(join(dataDir, CURRENT_LINK)).catch(() => {});
}


export interface PublishInput {
  staging: Staging;
  runId: string;
  /**
   * The entries the batch itself indexed, BEFORE any carry-forward. Passing them
   * in rather than re-indexing here is not only cheaper (the dataset is ~50MB and
   * would otherwise be read and hashed twice per publish): re-indexing after
   * carryForward re-stamps the carried files with THIS run's id, which erased the
   * only record that they came from an older one and left stalePermutations
   * permanently empty.
   */
  entries: readonly ManifestEntry[];
  /** Expected files this run did not produce, to be filled from the last one. */
  missing: readonly string[];
  results: PermutationResult[];
  mafiaBuild: string | null;
  concurrency: number;
  startedAt: number;
  finishedAt: number;
  outcome: "success" | "partial";
}

export interface PublishResult {
  manifest: RunManifest;
  carried: ManifestEntry[];
}

/**
 * Make a staged run the published one.
 *
 * The ordering here is the most consequential in the repo and is why this lives in
 * one place rather than once per caller: gaps are filled first so the published set
 * is always complete, the checksums and the zip are built INSIDE the staging dir so
 * they are part of the atomic swap, the manifest is written last, and the previous
 * run is pruned only after the symlink has flipped.
 *
 * Deciding WHETHER to publish stays with the caller: the CLI honours --promote, the
 * server refuses to regress coverage. That difference is real and belongs at the
 * call sites.
 */
export async function publishRun(
  dataDir: string,
  input: PublishInput,
): Promise<PublishResult> {
  const previousDir = await resolveCurrent(dataDir);
  const previousManifest = previousDir ? await readManifest(previousDir) : null;

  const carried =
    previousDir && previousManifest
      ? await carryForward(
          input.staging,
          { dir: previousDir, manifest: previousManifest },
          input.missing,
        )
      : [];

  // Fresh wins; carried entries keep the sourceRunId of the run that derived them.
  const byName = new Map(carried.map((e) => [e.name, e]));
  for (const e of input.entries) byName.set(e.name, e);
  const entries = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // After the merge, so the checksums cover carried files too.
  await writeSums(input.staging, entries);

  const zip = await buildZip(input.staging, entries).catch(() => null);

  const manifest: RunManifest = {
    version: 1,
    id: input.runId,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    outcome: input.outcome,
    durationMs: input.finishedAt - input.startedAt,
    concurrency: input.concurrency,
    mafiaBuild: input.mafiaBuild,
    results: input.results,
    entries,
    zip,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
  };

  await writeManifest(input.staging, manifest);
  await promote(dataDir, input.runId);
  // Safe to delete the old dir immediately: an in-flight download holds an open
  // fd, and POSIX keeps that inode alive.
  await pruneRuns(dataDir, [input.runId]);

  return { manifest, carried };
}
