/**
 * File and zip downloads. NODE-ONLY.
 *
 * An Express route rather than a React Router resource route, because res.sendFile
 * gives Range, ETag, Last-Modified, HEAD and conditional GET for free, all of
 * which a `curl`-scripting audience and a 14MB zip actually want.
 *
 * PATH-TRAVERSAL SAFETY IS BY CONSTRUCTION, NOT BY VALIDATION. The requested name
 * is looked up in a closed set generated from the core's permutation table, and is
 * never used to build a path until it has been found there. So `..`, `%2e%2e%2f`,
 * absolute paths, backslashes and NUL bytes are all impossible, there is no regex
 * to get subtly wrong.
 */

import type { Request, Response } from "express";
import { basename, join } from "node:path";
import { ALL_FILE_NAMES, permutationByUser } from "#core/permutations";
import {
  readCurrentManifest,
  resolveCurrent,
  SUMS_NAME,
  ZIP_NAME,
} from "#core/staging.server";

/** The closed allow-list: the 162 data files plus the checksums. */
const ALLOWED = new Set<string>([...ALL_FILE_NAMES, SUMS_NAME]);

/*
 * The download URLs, defined once. These strings appeared in five places across
 * three files: the two route registrations, the two link builders in
 * files.server, and the zip link in the manifest. A link and the route serving it
 * that disagree is a 404 nothing tests, so they share a definition instead.
 */
export const ZIP_URL = "/api/download/zip";
export const FILE_URL_BASE = "/api/download/file";

export function fileUrl(name: string): string {
  return `${FILE_URL_BASE}/${name}`;
}

export function isAllowedFile(name: string): boolean {
  return ALLOWED.has(name);
}

export function allowedFileCount(): number {
  return ALLOWED.size;
}

/** Express 5 types a param as string | string[]; only a single value is valid. */
function param(req: Request, key: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[
    key
  ];
  return typeof value === "string" ? value : "";
}

function notFound(res: Response, message = "Not found"): void {
  res.status(404).type("text/plain").send(`${message}\n`);
}

export function fileHandler(dataDir: string) {
  return async function handle(req: Request, res: Response): Promise<void> {
    const name = param(req, "name");
    if (!isAllowedFile(name)) {
      notFound(res);
      return;
    }

    const current = await resolveCurrent(dataDir);
    if (current === null) {
      notFound(res, "No dataset yet");
      return;
    }

    // The run id IS the directory name: promote() links current -> runs/<runId>.
    // Reading it from the path avoids parsing a 54KB, 550-object manifest on every
    // file request, which a scripted consumer makes 162 of in a row.
    const runId = basename(current);

    res.sendFile(join(current, "data", name), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // Stable URLs people will curl in scripts, so no `immutable`. The ETag
        // keeps conditional GET cheap.
        "cache-control": "public, max-age=0, must-revalidate",
        etag: `W/"${runId}-${name}"`,
      },
    });
  };
}

export function zipHandler(dataDir: string) {
  return async function handle(_req: Request, res: Response): Promise<void> {
    const current = await resolveCurrent(dataDir);
    const manifest = await readCurrentManifest(dataDir);
    if (current === null || manifest === null || manifest.zip === null) {
      res.status(409).type("text/plain").send("No archive available\n");
      return;
    }

    res.sendFile(join(current, ZIP_NAME), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="tcrs-${manifest.id}.zip"`,
        "cache-control": "public, max-age=0, must-revalidate",
        etag: `W/"${manifest.zip.sha256}"`,
      },
    });
  };
}

/**
 * The per-permutation log. Same closed-set principle: only one of the 54 real
 * usernames resolves to a path.
 *
 * Logs are served rather than folded into the event stream, because raw output is
 * ~50k high-churn lines per batch and has no business going to every client.
 */
export function logHandler(dataDir: string) {
  return async function handle(req: Request, res: Response): Promise<void> {
    const user = param(req, "user");
    if (permutationByUser(user) === undefined) {
      notFound(res);
      return;
    }
    const current = await resolveCurrent(dataDir);
    if (current === null) {
      notFound(res, "No dataset yet");
      return;
    }
    res.sendFile(join(current, "logs", `${user}.log`), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  };
}
