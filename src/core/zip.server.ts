/**
 * The pre-generated download bundle. NODE-ONLY.
 *
 * Built INSIDE the staging dir before the symlink flips, so the zip is part of the
 * atomic swap: data/current/tcrs-data.zip is never missing and never half-written.
 *
 * Pre-generated rather than streamed on demand, for four reasons:
 *  - Measured: the 51.7MB tree compresses to ~14MB.
 *  - On-demand streaming cannot send Content-Length, so the browser shows no
 *    progress and cannot resume a 14MB download.
 *  - It would burn a CPU-second per requester on a public unauthenticated route.
 *  - Atomicity: an on-demand zip would have to read a directory that can be swapped
 *    out from under it.
 */

import { createWriteStream } from "node:fs";
import { rename, stat } from "node:fs/promises";
import { join } from "node:path";
// archiver v8 exports classes rather than a callable factory.
import { ZipArchive } from "archiver";
import {
  SUMS_NAME,
  ZIP_NAME,
  sha256File,
  type ManifestEntry,
  type Staging,
} from "./staging.server.ts";

export async function buildZip(
  staging: Staging,
  entries: readonly ManifestEntry[],
): Promise<{ name: string; bytes: number; sha256: string } | null> {
  if (entries.length === 0) return null;

  const finalPath = join(staging.dir, ZIP_NAME);
  const tmpPath = `${finalPath}.part`;

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(tmpPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    out.on("close", () => resolve());
    out.on("error", reject);
    archive.on("error", reject);
    // A warning (e.g. a vanished file) must not silently truncate the archive.
    archive.on("warning", reject);

    archive.pipe(out);
    for (const e of entries) {
      archive.file(join(staging.dataDir, e.name), { name: e.name });
    }
    // Ship the checksums inside the zip too, so an offline consumer can verify.
    archive.file(join(staging.dataDir, SUMS_NAME), { name: SUMS_NAME });
    void archive.finalize();
  });

  await rename(tmpPath, finalPath);
  const st = await stat(finalPath);
  return {
    name: ZIP_NAME,
    bytes: st.size,
    sha256: await sha256File(finalPath),
  };
}
