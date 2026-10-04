/** The selectable pill used for output formats, aspect, quality and compression. */
export function Chip({
  label,
  selected,
  onClick,
  title,
  disabled,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className="shift-chip"
    >
      {label}
    </button>
  );
}
