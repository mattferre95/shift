/** The 36×22 switch: an accent track when on, a quiet one when off. */
export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={[
        "relative h-[22px] w-9 shrink-0 rounded-[11px] p-[2px]",
        "transition-[background] duration-[140ms] ease-out disabled:cursor-not-allowed disabled:opacity-40",
        on ? "bg-[image:var(--accent-gradient)]" : "bg-shift-switch-off",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4)]",
          "transition-[left] duration-[140ms] ease-out",
          on ? "left-[16px]" : "left-[2px]",
        ].join(" ")}
      />
    </button>
  );
}

/** The design's name for it. */
export const Switch = Toggle;
