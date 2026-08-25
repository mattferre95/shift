/** The selectable pill used for OUTPUT, QUALITY and TRANSFORM. */
export function Chip({
  label,
  selected,
  onClick,
  title,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={selected}
      onClick={onClick}
      className={[
        "rounded-lg px-[14px] py-2 text-[13px] font-medium",
        "border transition-all duration-[140ms] ease-out",
        selected
          ? "border-[var(--emerald-edge)] bg-[var(--emerald-tint)] text-[oklch(0.90_0.05_155)]"
          : "border-[var(--hairline-strong)] bg-shift-chip text-shift-dim hover:bg-shift-chip-hi hover:text-shift-body",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
