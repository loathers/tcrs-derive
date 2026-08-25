/**
 * Plain parenthetical text rather than a coloured pill: the page is deliberately
 * undesigned, and "(older data)" reads fine inline.
 */
export function Badge({
  children,
  title,
}: {
  tone?: "ok" | "warn" | "fail" | "idle";
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className="muted small" title={title}>
      ({children})
    </span>
  );
}
