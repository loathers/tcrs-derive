/**
 * `tcrs run`, derive locally.
 *
 * Chooses between the ink chart and plain line output the same way the bash did
 * (`[ -t 2 ] && NO_PROGRESS != 1`), except the test is on stdout, since that is now
 * where human-readable output goes.
 */

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { CliFlags } from "../index.ts";
import { loadSecrets } from "#core/env.server";
import { list, resolveBatchConfig } from "#core/config.server";
import { ensureJar, JarUnavailableError } from "#core/jar.server";
import {
  MissingPasswordsError,
  UnknownPermutationsError,
  startBatch,
  type BatchConfig,
} from "#core/runBatch.server";
import { acquireLock, LockHeldError } from "#core/lock.server";
import { clearWork, paths, publishRun } from "#core/staging.server";
import { createPlainReporter, formatSummaryTable } from "../plain.ts";
import { renderChart } from "../render.tsx";

export async function runCommand(flags: CliFlags): Promise<number> {
  const cfg = buildConfig(flags);
  await mkdir(cfg.dataDir, { recursive: true });
  await mkdir(paths(cfg.dataDir).work, { recursive: true });

  // Resolve (or fetch) the jar before taking the lock, so a download does not hold
  // it. In the container the jar is baked in at a pinned MAFIA_TAG.
  try {
    cfg.jarPath = await ensureJar({
      configured: cfg.jarPath,
      searchDir: process.cwd(),
      tag: process.env["MAFIA_TAG"],
      onProgress: (m) => process.stderr.write(`${m}\n`),
    });
  } catch (e) {
    process.stderr.write(
      `${e instanceof JarUnavailableError ? e.detail : String(e)}\n` +
        "Set --jar/$JAR, or place KoLmafia.jar beside the data dir.\n",
    );
    return 2;
  }

  const secrets = loadSecrets();

  let lock;
  try {
    lock = await acquireLock(paths(cfg.dataDir).root + "/.lock");
  } catch (e) {
    if (e instanceof LockHeldError) {
      process.stderr.write(`${e.message}\nStop it first, or use a different --data-dir.\n`);
      return 2;
    }
    throw e;
  }

  try {
    let handle;
    try {
      handle = startBatch(cfg, secrets);
    } catch (e) {
      if (e instanceof UnknownPermutationsError) {
        process.stderr.write(`${e.message}\nRun \`tcrs list\` to see valid names.\n`);
        return 2;
      }
      if (e instanceof MissingPasswordsError) {
        process.stderr.write(
          `${e.message}\nRun \`tcrs list --check-env\` for the full list.\n`,
        );
        return 2;
      }
      throw e;
    }

    const interactive = process.stdout.isTTY === true && !flags["no-progress"] && !flags.json;

    if (interactive) {
      await renderChart(handle);
    } else {
      const report = createPlainReporter({ json: flags.json === true });
      handle.onEvent((e) => report(e, handle.state));
      // Ctrl-C must tear the JVMs down rather than orphan them.
      const onSignal = () => handle.cancel();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      await handle.result;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }

    const result = await handle.result;
    if (!flags.json) {
      process.stdout.write("\n" + formatSummaryTable(handle.state) + "\n");
    }

    // --- Publish ---------------------------------------------------------
    const mode = flags.promote ?? "success";
    const shouldPromote =
      mode === "always" ||
      (mode !== "never" && !result.cancelled && result.ok > 0);

    if (shouldPromote) {
      const finishedAt = Date.now();
      const { carried } = await publishRun(cfg.dataDir, {
        staging: result.staging,
        runId: result.runId,
        entries: result.entries,
        missing: result.missing,
        results: result.results,
        mafiaBuild: result.mafiaBuild,
        concurrency: cfg.concurrency,
        startedAt: handle.state.startedAt ?? finishedAt,
        finishedAt,
        outcome: result.failed === 0 ? "success" : "partial",
      });

      if (!flags.json) {
        process.stdout.write(
          `\n  published: ${paths(cfg.dataDir).current} -> runs/${result.runId}` +
            (carried.length > 0
              ? `\n  carried forward: ${carried.length} file(s) from an earlier run`
              : "") +
            "\n",
        );
      }
    }

    await clearWork(cfg.dataDir);

    if (result.cancelled) return 130;
    return result.failed === 0 ? 0 : 1;
  } finally {
    await lock.release();
  }
}


function buildConfig(flags: CliFlags): BatchConfig {
  const overrides: Partial<BatchConfig> = {};
  if (flags.only !== undefined) overrides.only = list(flags.only);
  if (flags.exclude !== undefined) overrides.exclude = list(flags.exclude);
  if (flags.resume) overrides.resume = true;
  if (flags.concurrency) overrides.concurrency = Number(flags.concurrency);
  if (flags.jar) overrides.jarPath = resolve(flags.jar);
  if (flags["data-dir"]) overrides.dataDir = resolve(flags["data-dir"]);
  if (flags.timeout) overrides.timeoutMs = Number(flags.timeout) * 1000;
  if (flags["login-timeout"]) {
    overrides.loginTimeoutMs = Number(flags["login-timeout"]) * 1000;
  }
  if (flags["max-attempts"]) overrides.maxAttempts = Number(flags["max-attempts"]);
  if (flags["retry-backoff"]) {
    overrides.retryBackoffMs = Number(flags["retry-backoff"]) * 1000;
  }
  if (flags["stall-timeout"]) {
    overrides.stallTimeoutMs = Number(flags["stall-timeout"]) * 1000;
  }
  if (flags["skip-warmup"]) overrides.skipWarmup = true;
  if (flags["keep-workdirs"]) overrides.keepWorkdirs = true;
  return resolveBatchConfig({ overrides });
}

