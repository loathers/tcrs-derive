/**
 * Build the grouped download listing from the published manifest. NODE-ONLY.
 *
 * Read straight out of the manifest, never a directory walk per request.
 */

import type {
  ClassGroup,
  FileListResponse,
  PermutationFiles,
} from "../../app/lib/api-types.ts";
import {
  ALL_PERMUTATIONS,
  CLASS_ORDER,
  CLASS_LABELS,
  CLASS_TOKENS,
  FILE_KINDS,
} from "#core/permutations";
import { readCurrentManifest, SUMS_NAME } from "#core/staging.server";
import { fileUrl } from "#server/download.server";

export async function buildFileList(
  dataDir: string,
): Promise<FileListResponse | null> {
  const manifest = await readCurrentManifest(dataDir);
  if (manifest === null || manifest.finishedAt === null) return null;

  const byUser = new Map<string, typeof manifest.entries>();
  for (const e of manifest.entries) {
    const list = byUser.get(e.user);
    if (list) list.push(e);
    else byUser.set(e.user, [e]);
  }

  const groups: ClassGroup[] = CLASS_ORDER.map((abbr) => {
    const permutations: PermutationFiles[] = ALL_PERMUTATIONS.filter(
      (p) => p.abbr === abbr,
    )
      .map((p): PermutationFiles | null => {
        const entries = byUser.get(p.user);
        if (entries === undefined || entries.length === 0) return null;
        const sourceRunId = entries[0]!.sourceRunId;
        return {
          user: p.user,
          classToken: p.classToken,
          classLabel: p.classLabel,
          sign: p.signCap,
          fresh: entries.every((e) => e.sourceRunId === manifest.id),
          sourceRunId,
          files: entries
            .map((e) => ({
              kind: e.kind,
              name: e.name,
              bytes: e.bytes,
              url: fileUrl(e.name),
            }))
            // FILE_KINDS is the declared order; do not re-encode it here.
            .sort(
              (a, b) => FILE_KINDS.indexOf(a.kind) - FILE_KINDS.indexOf(b.kind),
            ),
        };
      })
      .filter((x): x is PermutationFiles => x !== null);

    return {
      classToken: CLASS_TOKENS[abbr],
      classLabel: CLASS_LABELS[abbr],
      permutations,
    };
  }).filter((g) => g.permutations.length > 0);

  return {
    runId: manifest.id,
    // Finish time, matching the dataset summary. Non-null: the guard above
    // returns early for an unfinished manifest.
    generatedAt: manifest.finishedAt,
    groups,
    sums: { name: SUMS_NAME, url: fileUrl(SUMS_NAME) },
  };
}
