/** Resource route: the grouped download listing, read from the manifest. */
import type { Route } from "./+types/api.files";

export async function loader(_: Route.LoaderArgs) {
  const { buildFileList } = await import("#server/files.server");
  const { resolveBatchConfig } = await import("#core/config.server");
  const files = await buildFileList(resolveBatchConfig().dataDir);
  if (files === null) {
    // Deliberately a 404 rather than 200-with-empty-groups, so a client cannot
    // accidentally render an empty table as if it were real.
    return Response.json({ error: "no_dataset" }, { status: 404 });
  }
  return Response.json(files, {
    headers: { "cache-control": "no-store" },
  });
}
