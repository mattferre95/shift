import type { ReactNode } from "react";

/**
 * The workspace strip above the content. It doubles as the window's drag
 * region, so only the slots that hold controls opt out of dragging.
 */
export function Header({ title, meta, aside }: { title: ReactNode; meta?: ReactNode; aside?: ReactNode }) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--hairline-faint)] px-6"
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-baseline gap-3">
        <h1 className="pointer-events-none m-0 max-w-[60%] shrink-0 truncate text-[15px] font-semibold text-shift-text">{title}</h1>
        {meta && (
          <span className="pointer-events-none min-w-0 truncate font-mono text-[12px] text-shift-soft">{meta}</span>
        )}
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </header>
  );
}
