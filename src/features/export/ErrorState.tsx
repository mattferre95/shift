import { useState } from "react";
import { useShift } from "@/state/shift";

/** State F. Human sentence first; raw output stays folded away (JOB-05). */
export function ErrorState() {
  const { error, retry, reset } = useShift();
  const [open, setOpen] = useState(false);

  return (
    <div className="shift-enter absolute inset-0 flex flex-col items-center justify-center gap-[14px] overflow-y-auto p-8">
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[oklch(0.7_0.13_35_/_0.4)] bg-[oklch(0.7_0.13_35_/_0.12)]">
        <span className="mb-[2px] h-3 w-[2px] rounded-sm bg-shift-danger" />
        <span className="absolute bottom-[9px] h-[2px] w-[2px] rounded-full bg-shift-danger" />
      </div>

      <div className="text-center text-[18px] font-semibold text-shift-title">
        {error?.message ?? "Something went wrong."}
      </div>

      {error?.hint && (
        <div className="max-w-[360px] text-center text-[13px] leading-[1.5] text-shift-muted">
          {error.hint}
        </div>
      )}

      <div className="mt-2 flex items-center gap-[18px]">
        <button
          type="button"
          onClick={retry}
          className="rounded-lg bg-shift-emerald px-[22px] py-[11px] text-[13px] font-bold tracking-[0.04em] text-shift-on-emerald transition-opacity duration-[140ms] hover:opacity-90"
        >
          TRY AGAIN
        </button>
        {error?.technical ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[13px] text-shift-quiet transition-colors duration-[140ms] hover:text-shift-body"
          >
            Technical details
          </button>
        ) : (
          <button
            type="button"
            onClick={reset}
            className="text-[13px] text-shift-quiet transition-colors duration-[140ms] hover:text-shift-body"
          >
            New shift
          </button>
        )}
      </div>

      {open && error?.technical && (
        <pre className="mt-1 max-h-[190px] w-[420px] shrink-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[oklch(1_0_0_/_0.08)] bg-shift-input px-4 py-[14px] font-mono text-[11px] leading-[1.7] text-shift-quiet">
          {`error: ${error.code}\n${error.technical}`}
        </pre>
      )}
    </div>
  );
}
