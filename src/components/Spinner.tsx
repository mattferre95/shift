/** The one activity indicator: a small ring turning. Never a measure of progress. */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 animate-spin rounded-full border-2 border-[var(--link-ring)] border-t-shift-link"
      style={{ width: size, height: size }}
    />
  );
}
