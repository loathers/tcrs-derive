export function EmptyState({
  configOk,
  missingPasswordCount,
}: {
  configOk: boolean;
  missingPasswordCount: number;
}) {
  return (
    <section className="panel empty">
      <h2>No data yet</h2>
      {configOk ? (
        <p>
          Nothing has been generated. Press <strong>Generate now</strong> to
          derive the first set — it takes about 8 minutes.
        </p>
      ) : (
        <p className="error">
          The server is missing {missingPasswordCount} account password
          {missingPasswordCount === 1 ? "" : "s"}, so it cannot derive anything
          yet.
        </p>
      )}
    </section>
  );
}
