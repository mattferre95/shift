export function BuildInfo({ label = __SHIFT_BUILD_LABEL__ }: { label?: string }) {
  return (
    <footer
      aria-label="Build information"
      className="flex h-[18px] shrink-0 items-center justify-center px-4 font-mono text-[10px] leading-none tracking-[0.01em] text-shift-ghost"
    >
      {label}
    </footer>
  );
}
