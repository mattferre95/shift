import type { ReactNode } from "react";

/** A grouped surface: 16px radius, one hairline, a catch of light on top. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`shift-panel ${className ?? ""}`}>{children}</div>;
}

/**
 * The right-hand export panel. A scrolling body above a pinned footer, so the
 * primary action stays on screen however much the body has to say.
 */
export function Inspector({
  title,
  aside,
  children,
  footer,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <aside aria-label={title} className="shift-panel flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1 pt-4">
        <div className="text-[13px] font-semibold text-shift-text">{title}</div>
        {aside}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">{children}</div>
      {footer && <div className="flex shrink-0 flex-col gap-3 px-4 pb-4 pt-1">{footer}</div>}
    </aside>
  );
}

/** One labelled group inside an inspector or panel. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11.5px] font-medium text-shift-muted">{label}</span>
        {hint && <span className="text-[11.5px] text-shift-soft">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** A label and its value on one line — the export summary. */
export function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-shift-soft">{label}</span>
      <span className="truncate text-shift-text">{value}</span>
    </div>
  );
}
