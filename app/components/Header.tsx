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
      <h1>
        <img src="/favicon.png" alt="" width={32} height={32} />
        TCRS data
      </h1>
      <p>
        Real TCRS item modifiers for KoLmafia, read straight off the live KoL
        server. Covering all {permutationCount} class/seed combinations takes an
        army of multis with one parked in each. Thanks to threebullethamburgler
        (#1993636) for setting up those multis.
      </p>
      {connection === "polling" && (
        <p className="muted small">Live updates blocked. Polling every 5s.</p>
      )}
    </header>
  );
}
