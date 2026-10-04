import { BuildInfo } from "@/components/BuildInfo";
import { useShift } from "@/state/shift";
import { VIEWS, useView, type View } from "@/state/view";

/** Stroke paths from the approved design, drawn on a 24px grid. */
const ICONS: Record<View, string> = {
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  convert: "M4 8h13l-3-3M20 16H7l3 3",
  edit: "M9 4H6v16h3M15 4h3v16h-3M12 8v8",
  resize: "M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6",
  compress: "M4 14h6v6M20 10h-6V4M10 14l-6 6M14 10l6-6",
};

/**
 * The persistent left column: wordmark, the five modes, and the build label.
 *
 * The top is left empty and draggable — the real traffic lights sit there.
 */
export function Sidebar() {
  const { view, available, setView } = useView();
  // While a job runs, finishes or fails, the window is showing that job, not
  // a mode, so no mode is drawn as the current one. Availability is unchanged.
  const { screen } = useShift();
  const inJob = screen === "processing" || screen === "complete" || screen === "error";

  return (
    <nav
      aria-label="Modes"
      className="flex w-[200px] shrink-0 flex-col border-r border-[var(--hairline-faint)] bg-shift-sidebar px-3 pb-3"
    >
      <div data-tauri-drag-region className="h-[44px] shrink-0" />

      <div data-tauri-drag-region className="flex items-start gap-[2px] px-[10px] pb-[18px] pt-[6px]">
        <span className="pointer-events-none text-[17px] font-bold leading-none tracking-[0.1em] text-shift-text">
          SHIFT
        </span>
        <span className="pointer-events-none text-[9px] leading-none text-shift-quiet">™</span>
      </div>

      <div className="flex flex-col gap-[2px]">
        {VIEWS.map((item, i) => (
          <NavItem
            key={item.id}
            label={item.label}
            icon={ICONS[item.id]}
            shortcut={`⌘${i + 1}`}
            active={!inJob && view === item.id}
            disabled={!available[item.id]}
            onSelect={() => setView(item.id)}
          />
        ))}
      </div>

      <div className="flex-1" />

      <div className="pb-[2px] pl-[6px]">
        <BuildInfo />
      </div>
    </nav>
  );
}

export function NavItem({
  label,
  icon,
  shortcut,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  icon: string;
  shortcut: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={shortcut.replace("⌘", "Meta+")}
      disabled={disabled}
      onClick={onSelect}
      className={[
        "group flex h-9 w-full items-center gap-[11px] rounded-[9px] px-[10px] text-left text-[13.5px]",
        "transition-[background,color,opacity] duration-[140ms] ease-out",
        active
          ? "bg-[image:var(--accent-nav)] font-semibold text-shift-text"
          : "font-medium text-shift-dim enabled:hover:text-shift-body",
        "disabled:cursor-default disabled:opacity-35",
      ].join(" ")}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={active ? "stroke-shift-nav-icon" : "stroke-shift-soft"}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={icon} />
      </svg>
      {label}
      <span
        aria-hidden="true"
        className={[
          "ml-auto font-mono text-[11px]",
          active ? "text-shift-kbd-active" : "text-shift-kbd",
        ].join(" ")}
      >
        {shortcut}
      </span>
    </button>
  );
}
