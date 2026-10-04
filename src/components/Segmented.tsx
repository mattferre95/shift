/**
 * One choice from a few, in a recessed well — Fill/Fit and the like.
 * Each segment is a pressed-state button, so it reads the same to assistive
 * technology as a `Chip` with the same label.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  size = "md",
}: {
  options: { id: T; label: string; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  size?: "md" | "sm";
}) {
  return (
    <div role="group" aria-label={label} className={size === "sm" ? "shift-segmented shift-segmented-sm" : "shift-segmented"}>
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          title={o.title}
          aria-pressed={o.id === value}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          className="shift-segment"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
