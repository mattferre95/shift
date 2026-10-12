import type { ReactNode } from "react";
import { useShift } from "@/state/shift";

/**
 * The two mirror toggles. One component for every place that offers them, so
 * Resize and the source screen read and write the same `flip` state.
 */
export function FlipControls() {
  const s = useShift();
  return (
    <div role="group" aria-label="Flip" className="flex gap-[6px]">
      <FlipButton label="Flip horizontally" pressed={s.flip.horizontal} onToggle={() => s.toggleFlip("horizontal")}>
        <path d="M12 3v18" strokeDasharray="2 2.5" />
        <path d="M9 7v10L3.5 17z" />
        <path d="M15 7v10l5.5 0z" />
      </FlipButton>
      <FlipButton label="Flip vertically" pressed={s.flip.vertical} onToggle={() => s.toggleFlip("vertical")}>
        <path d="M3 12h18" strokeDasharray="2 2.5" />
        <path d="M7 9h10L17 3.5z" />
        <path d="M7 15h10l0 5.5z" />
      </FlipButton>
    </div>
  );
}

/** An independent mirror toggle, in the same selected treatment as the ratio tiles. */
function FlipButton({ label, pressed, onToggle, children }: {
  label: string; pressed: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={[
        "flex h-[33px] w-[42px] items-center justify-center rounded-[8px] border transition-colors duration-[140ms]",
        pressed
          ? "border-[var(--accent-edge)] bg-[image:var(--accent-select)] text-shift-link"
          : "border-[var(--hairline-faint)] bg-[image:var(--control-gradient)] text-shift-soft hover:border-[var(--hairline-bright)] hover:text-shift-body",
      ].join(" ")}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
