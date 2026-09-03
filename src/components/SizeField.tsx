/**
 * A pixel-dimension field for the Freeform aspect.
 *
 * Deliberately the same shape and weight as `TimeField` — SHIFT has one kind of
 * text input, not one per feature. Bounds are enforced in the native layer;
 * this only keeps the value numeric while it is being typed.
 */
export function SizeField({
  label,
  value,
  onChange,
  invalid,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  invalid?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-[5px] block text-[10px] tracking-[0.06em] text-shift-label">{label}</span>
      <input
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9]/g, "");
          onChange(raw === "" ? null : Math.min(99999, Number(raw)));
        }}
        spellCheck={false}
        autoComplete="off"
        inputMode="numeric"
        placeholder="—"
        className={[
          "w-[86px] rounded-md px-[10px] py-[7px]",
          "bg-shift-input font-mono text-[13px] text-shift-body",
          "border transition-colors duration-[140ms]",
          invalid
            ? "border-[oklch(0.75_0.13_35_/_0.55)]"
            : "border-[var(--hairline-strong)] focus:border-[var(--emerald-edge)]",
        ].join(" ")}
      />
    </label>
  );
}
