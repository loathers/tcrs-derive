export function EmptyState({
  configOk,
  missingPasswordCount,
}: {
  configOk: boolean;
  missingPasswordCount: number;
}) {
  return (
    <section>
      <h2>Downloads</h2>
      <p>
        {configOk
          ? "Nothing generated yet."
          : `Unavailable: ${missingPasswordCount} of 54 account passwords missing from the server config.`}
      </p>
    </section>
  );
}
