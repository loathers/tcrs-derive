import type { Connection } from "../hooks/useRunStream.ts";

export function Header({
  connection,
  permutationCount,
}: {
  connection: Connection;
  permutationCount: number;
}) {
  return (
    <header>
      <h1>TCRS data</h1>
      <p>
        KoLmafia TCRS item modifiers for all {permutationCount} class &times;
        sign combinations.
      </p>
      {connection === "polling" && (
        <p className="muted small">Live updates blocked. Polling every 5s.</p>
      )}
    </header>
  );
}
