import { useEffect, useState } from "react";
import { formatAbsolute, formatRelative } from "../lib/format.ts";

/** "6 hours ago", refreshed periodically, with the absolute time in the title. */
export function RelativeTime({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    // suppressHydrationWarning: the server and client render this a fraction of a
    // second apart, so "1 minute ago" can legitimately differ. React patches text
    // content (unlike attributes), so the client value wins and is correct.
    <time dateTime={iso} title={formatAbsolute(iso)} suppressHydrationWarning>
      {formatRelative(iso, now)}
    </time>
  );
}
