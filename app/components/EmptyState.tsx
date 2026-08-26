export function EmptyState({
  configOk,
  missingPasswordCount,
  permutationCount,
}: {
  configOk: boolean;
  missingPasswordCount: number;
  permutationCount: number;
}) {
  return (
    <section>
      <h2>Downloads</h2>
      <p>
        {configOk
          ? "Nothing generated yet."
          : `Unavailable: ${missingPasswordCount} of ${permutationCount} account passwords missing from the server config.`}
      </p>
    </section>
  );
}
