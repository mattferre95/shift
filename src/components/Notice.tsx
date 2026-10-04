import type { ReactNode } from "react";

const TONES = {
  danger: { text: "text-shift-danger", edge: "border-[var(--danger-edge)] bg-[var(--danger-tint)]" },
  warning: { text: "text-shift-warning", edge: "border-[var(--warning-edge)] bg-[var(--warning-tint)]" },
  info: { text: "text-shift-link", edge: "border-[var(--hairline)] bg-[var(--accent-wash)]" },
} as const;

/**
 * A one-line system message: a broken install, a blocked export, a caveat.
 * Danger notices are announced; the others are polite.
 */
export function Notice({
  tone = "info",
  children,
  action,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
  action?: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-[10px] rounded-[10px] border px-3 py-[10px] text-[12.5px] leading-[1.45] ${t.edge}`}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={`mt-[1px] shrink-0 ${t.text}`} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        {tone === "info" ? <path d="M12 11v6M12 7.5v.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" /> : <path d="M12 9v4M12 16.5v.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />}
      </svg>
      <div className="min-w-0 flex-1 text-shift-body">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
