/** The build label, quiet at the foot of the sidebar, always on one line. */
export function BuildInfo({ label = __SHIFT_BUILD_LABEL__ }: { label?: string }) {
  return (
    <footer
      aria-label="Build information"
      className="whitespace-nowrap font-mono text-[10px] leading-none text-shift-faint"
    >
      {label}
    </footer>
  );
}
