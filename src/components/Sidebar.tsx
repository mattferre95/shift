import { BuildInfo } from "@/components/BuildInfo";
import shiftSymbol from "@/assets/brand/shift-symbol.png";
import shiftText from "@/assets/brand/shift-text.png";
import { useShift } from "@/state/shift";
import { VIEWS, useView, type View } from "@/state/view";

/** Stroke paths from the approved design, drawn on a 24px grid. */
const ICONS: Record<View, string> = {
  dashboard: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  convert: "M4 8h13l-3-3M20 16H7l3 3",
  edit: "M9 4H6v16h3M15 4h3v16h-3M12 8v8",
  resize: "M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6",
  compress: "M4 14h6v6M20 10h-6V4M10 14l-6 6M14 10l6-6",
};

/**
 * The persistent left column: wordmark, navigation, and the build label.
 *
 * The top is left empty and draggable — the real traffic lights sit there.
 */
export function Sidebar() {
  const { view, available, setView } = useView();
  // While a job runs, finishes or fails, the window is showing that job, not
  // a mode, so no mode is drawn as the current one. Availability is unchanged.
  const { screen, saving, reset } = useShift();
  const inJob = screen === "processing" || screen === "complete" || screen === "error";

  return (
    <nav
      aria-label="Modes"
      className="shift-sidebar flex w-[200px] shrink-0 flex-col border-r border-[var(--hairline-faint)] bg-shift-sidebar px-3 pb-3"
    >
      <div data-tauri-drag-region className="h-[44px] shrink-0" />

      {/* Images ignore pointer events so the whole row stays a window drag region.
          The icon rail is too narrow for the wordmark, so it shows the symbol. */}
      <div data-tauri-drag-region className="shift-sidebar-brand mb-[18px] flex h-[30px] items-center px-[10px]">
        <img src={shiftText} alt="SHIFT" draggable={false} className="shift-sidebar-wordmark pointer-events-none h-[22px] w-auto select-none" />
        <img src={shiftSymbol} alt="SHIFT" draggable={false} className="shift-sidebar-symbol pointer-events-none hidden h-[30px] w-[30px] scale-[1.3] select-none" />
      </div>

      <button
        type="button"
        aria-label="New Shift"
        title="New Shift (⌘N)"
        aria-keyshortcuts="Meta+N"
        disabled={saving}
        onClick={reset}
        className="mb-4 flex h-8 w-full items-center gap-[9px] rounded-[8px] border border-[var(--hairline-bright)] px-[10px] text-left text-[12.5px] font-medium text-shift-dim transition-[background,color] duration-[140ms] enabled:hover:bg-shift-chip-hi enabled:hover:text-shift-text disabled:opacity-35"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="stroke-shift-soft" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span className="shift-sidebar-label">New Shift</span>
        <span aria-hidden="true" className="shift-sidebar-shortcut ml-auto font-mono text-[11px] text-shift-kbd">⌘N</span>
      </button>

      <div className="flex flex-col gap-[2px]">
        {VIEWS.map((item, i) => (
          <NavItem
            key={item.id}
            label={item.label}
            icon={ICONS[item.id]}
            shortcut={`⌘${i}`}
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
      title={`${label} (${shortcut})`}
      aria-label={label}
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
      <span className="shift-sidebar-label">{label}</span>
      <span
        aria-hidden="true"
        className={[
          "shift-sidebar-shortcut",
          "ml-auto font-mono text-[11px]",
          active ? "text-shift-kbd-active" : "text-shift-kbd",
        ].join(" ")}
      >
        {shortcut}
      </span>
    </button>
  );
}
