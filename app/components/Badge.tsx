export function Badge({
  tone,
  children,
  title,
}: {
  tone: "ok" | "warn" | "fail" | "idle";
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}
