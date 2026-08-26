import { formatBytes } from "@/lib/format";
import * as ipc from "@/lib/ipc";
import { useShift } from "@/state/shift";

/** State E. */
export function CompleteState() {
  const { output, reset } = useShift();

  return (
    <div className="shift-enter absolute inset-0 flex flex-col items-center justify-center gap-[14px] p-8">
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[oklch(0.72_0.15_155_/_0.4)] bg-[oklch(0.72_0.15_155_/_0.14)]">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <polyline
            points="3,8.5 6.5,12 13,4"
            fill="none"
            stroke="oklch(0.72 0.15 155)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className="text-[22px] font-bold text-shift-title">Done.</div>

      <div className="max-w-[600px] truncate px-4 font-mono text-[14px] text-shift-body">
        {output?.filename}
      </div>
      <div className="font-mono text-[12px] text-shift-quiet">
        {output?.sourceBytes != null ? (
          <>
            {formatBytes(output.sourceBytes)}
            <span className="mx-[6px] text-shift-ghost">→</span>
            {formatBytes(output.sizeBytes)}
          </>
        ) : (
          formatBytes(output?.sizeBytes ?? null)
        )}
      </div>

      {output?.directory && (
        <div
          title={output.path}
          className="max-w-[520px] truncate font-mono text-[12px] text-shift-faint"
        >
          {output.directory}
        </div>
      )}

      <div className="mt-[10px] flex items-center gap-[18px]">
        <button
          type="button"
          onClick={() => output && ipc.revealInFinder(output.path).catch(() => {})}
          className="rounded-lg bg-shift-emerald px-[22px] py-[11px] text-[13px] font-bold tracking-[0.04em] text-shift-on-emerald transition-opacity duration-[140ms] hover:opacity-90"
        >
          SHOW IN FINDER
        </button>
        <button
          type="button"
          onClick={reset}
          className="text-[13px] text-shift-quiet transition-colors duration-[140ms] hover:text-shift-body"
        >
          New shift
        </button>
      </div>
    </div>
  );
}
