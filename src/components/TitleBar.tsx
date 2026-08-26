/**
 * The 40px window strip.
 *
 * The design mocks macOS traffic lights; the real app gets them from the system
 * with `titleBarStyle: "Overlay"`, so this only draws the centred wordmark and
 * reserves the same 40px of height the design allocates.
 */
export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="relative flex h-10 shrink-0 items-center border-b border-[var(--hairline-faint)] px-[14px]"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-[6px]"
      >
        <img src="/brand/shift-symbol-small.png" alt="" className="h-auto w-[12px] opacity-80" />
        <span className="text-[10px] uppercase tracking-[0.11em] text-shift-label">SHIFT</span>
      </div>
    </div>
  );
}
