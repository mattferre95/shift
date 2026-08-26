/** The 34×20 switch beside the CLIP label. */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={[
        "relative h-5 w-[34px] shrink-0 rounded-[10px] border",
        "transition-all duration-[140ms] ease-out",
        on
          ? "border-[var(--emerald-edge)] bg-[var(--emerald-veil)]"
          : "border-[var(--hairline-strong)] bg-shift-track",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-[2px] h-[14px] w-[14px] rounded-full",
          "transition-[left,background-color] duration-[140ms] ease-out",
          on ? "left-[17px] bg-shift-emerald" : "left-[3px] bg-shift-muted",
        ].join(" ")}
      />
    </button>
  );
}
