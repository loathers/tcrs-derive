/**
 * The byte-stream API routes, mounted on Express BEFORE the React Router handler.
 *
 * Only two concerns live here, both because Express is genuinely better at them
 * than a resource route would be:
 *   - SSE: a 7.5-minute stream wants raw res.write + flushHeaders, with no adapter
 *     in between.
 *   - Downloads: res.sendFile gives Range, ETag, Last-Modified, HEAD and
 *     conditional GET for free.
 *
 * Everything HTML or JSON is a React Router loader/action instead.
 */

import type { Express } from "express";
import { LockHeldError } from "#core/lock.server";
import { getRunManager, peekRunManager } from "./singleton.server.ts";
import { sseHandler } from "./sse-hub.server.ts";
import { fileHandler, logHandler, zipHandler } from "./download.server.ts";
import { resolveBatchConfig } from "#core/config.server";
import { ZIP_URL, FILE_URL_BASE } from "#server/download.server";

export async function initServer(): Promise<void> {
  // Boot recovery (single-instance lock, orphan cleanup, work-dir clearing) happens
  // here, before the first request is served.
  try {
    await getRunManager();
  } catch (e) {
    if (e instanceof LockHeldError) {
      // Another process owns this data volume. Exiting loudly is correct: two
      // servers sharing /data could tear the published dataset.
      process.stderr.write(
        `\n${e.message}\n` +
          `Another tcrs process is using this data directory.\n` +
          `If this is a rolling deploy, switch the platform to stop-then-start.\n`,
      );
      process.exit(1);
    }
    throw e;
  }
}

export async function shutdownServer(): Promise<void> {
  // peek, not get: if init never succeeded there is nothing to shut down, and
  // re-running init during shutdown would be actively wrong.
  await peekRunManager()?.shutdown();
}

export function mountApiRoutes(app: Express): void {
  const dataDir = resolveBatchConfig().dataDir;

  app.get("/api/events", async (req, res) => {
    const manager = await getRunManager();
    await sseHandler(manager)(req, res);
  });

  app.get(ZIP_URL, zipHandler(dataDir));
  app.get(`${FILE_URL_BASE}/:name`, fileHandler(dataDir));
  app.get("/api/logs/:user", logHandler(dataDir));

  // Cheap, and deliberately still 200 DURING a run: a 7.5-minute derive is not
  // unhealthy, and a healthcheck that fails mid-run would make Coolify restart the
  // container and kill the batch.
  app.get("/healthz", (_req, res) => {
    res.status(200).type("text/plain").send("ok\n");
  });
}
