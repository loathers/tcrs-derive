/**
 * The Express host wrapping React Router.
 *
 * A custom host rather than @react-router/serve, because we need three things it
 * gives no hook for:
 *   1. boot-time recovery — the flock and orphan cleanup — BEFORE the first request
 *      is served;
 *   2. a SIGTERM handler that aborts an in-flight run and waits for its JVMs;
 *   3. raw `res` control for the two byte-stream endpoints (SSE and downloads).
 *
 * Run directly with `node server.ts`: Node 24 strips the types, and package.json
 * `imports` resolves the #core/#server specifiers at runtime.
 */

import { createRequestHandler } from "@react-router/express";
import express from "express";
import {
  initServer,
  mountApiRoutes,
  shutdownServer,
} from "#server/express-routes.server";

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const DEV = process.env["NODE_ENV"] !== "production";

// Boot recovery must complete before anything is served.
await initServer();

const app = express();
app.disable("x-powered-by");

// In dev, Vite runs in middleware mode so HMR works.
const vite = DEV
  ? await import("vite").then((v) =>
      v.createServer({ server: { middlewareMode: true } }),
    )
  : null;

// Mounted BEFORE the React Router handler, so RR never sees them.
mountApiRoutes(app);

if (vite) {
  app.use(vite.middlewares);
} else {
  // Vite-hashed assets are immutable; everything else in client/ is not.
  app.use(
    "/assets",
    express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
  );
  app.use(express.static("build/client", { maxAge: "1h" }));
}

app.all(
  "*splat",
  createRequestHandler({
    build: vite
      ? () =>
          vite.ssrLoadModule("virtual:react-router/server-build") as Promise<
            Parameters<typeof createRequestHandler>[0]["build"]
          >
      : // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - built at deploy time by `react-router build`
        await import("./build/server/index.js"),
  }),
);

const server = app.listen(PORT, HOST, () => {
  process.stdout.write(`tcrs listening on http://${HOST}:${PORT}\n`);
});

// --- Graceful shutdown -------------------------------------------------------
// A run needs up to ~45s to abort cleanly and record itself. Docker's default stop
// timeout is 10s, so the container's stop grace period must be raised to ~60s;
// boot recovery covers the SIGKILL case regardless.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n${signal} received; shutting down...\n`);
    server.close();
    shutdownServer()
      .catch((e: unknown) => process.stderr.write(`shutdown error: ${String(e)}\n`))
      .finally(() => process.exit(0));
  });
}
