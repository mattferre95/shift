/**
 * The 36px window strip.
 *
 * The real traffic lights come from the system via `titleBarStyle: "Overlay"`.
 * The wordmark used to be repeated here; the centre of the window is the brand,
 * so this is now just a dimmed mark and a drag region.
 */
export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="relative flex h-9 shrink-0 items-center px-[14px]"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-[6px]"
      >
        <img src="/brand/shift-symbol-small.png" alt="" className="h-auto w-[11px] opacity-[0.32]" />
      </div>
    </div>
  );
}
