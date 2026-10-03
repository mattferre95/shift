import { useEffect, useState } from "react";

/** A monospace IN/OUT field. Values are validated in the native layer. */
export function TimeField({
  label,
  displayValue,
  onChange,
  invalid,
}: {
  label: string;
  displayValue: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayValue);
  useEffect(() => {
    if (!editing) setDraft(displayValue);
  }, [displayValue, editing]);

  return (
    <label className="block">
      <span className="mb-[5px] block text-[10px] tracking-[0.06em] text-shift-label">{label}</span>
      <input
        value={editing ? draft : displayValue}
        onFocus={() => {
          setDraft(displayValue);
          setEditing(true);
        }}
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
        spellCheck={false}
        autoComplete="off"
        inputMode="numeric"
        placeholder="00:00"
        className={[
          "w-[110px] rounded-md px-[10px] py-[7px]",
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
