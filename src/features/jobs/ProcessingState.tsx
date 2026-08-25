import { useShift } from "@/state/shift";

/**
 * State D. Stage name, a bar that only claims precision when the native layer
 * reports it, one dot per real pipeline stage, and Cancel.
 */
export function ProcessingState() {
  const { job, cancel } = useShift();
  const stages = Math.max(1, job?.stageCount ?? 1);
  const index = Math.min(job?.stageIndex ?? 0, stages - 1);

  // Before analysis the pipeline is not planned yet, so there is no stage to
  // be a fraction of — the bar stays empty and sweeps instead of reading full.
  const queued = job?.state === "queued" || job == null;
  // Within a stage we advance by its reported fraction; without one we sit at
  // the stage boundary rather than inventing a number (JOB-03).
  const fraction = job?.progress ?? 1;
  const overall = queued ? 0 : ((index + fraction) / stages) * 100;
  const indeterminate = queued || job?.progress == null;

  return (
    <div className="shift-enter absolute inset-0 flex flex-col items-center justify-center gap-[22px] p-8">
      {/* Reserved height so naming the output does not shift the layout. */}
      <div className="h-4 max-w-[560px] truncate font-mono text-[12px] text-shift-quiet">
        {job?.filename}
      </div>

      <div className="text-[20px] font-semibold text-shift-title">
        {job?.stageLabel ?? "Preparing…"}
      </div>

      <div className="relative h-1 w-[380px] overflow-hidden rounded-sm bg-shift-track">
        <div
          className="h-full rounded-sm bg-shift-emerald transition-[width] duration-[400ms] ease-out"
          style={{ width: `${overall}%` }}
        />
        {indeterminate && (
          <div className="absolute inset-y-0 left-0 w-1/3 animate-[shift-sweep_1.4s_ease-in-out_infinite] bg-[linear-gradient(90deg,transparent,oklch(0.72_0.15_155_/_0.35),transparent)]" />
        )}
      </div>

      <div className="flex gap-2">
        {Array.from({ length: queued ? 1 : stages }, (_, i) => (
          <span
            key={i}
            className={[
              "h-[5px] w-[5px] rounded-full",
              i < index
                ? "bg-[oklch(0.72_0.15_155_/_0.5)]"
                : i === index
                  ? "animate-[shift-pulse_1.1s_ease-in-out_infinite] bg-shift-emerald"
                  : "bg-[oklch(1_0_0_/_0.12)]",
            ].join(" ")}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={cancel}
        className="mt-[6px] text-[13px] text-shift-quiet transition-colors duration-[140ms] hover:text-shift-body"
      >
        Cancel
      </button>
    </div>
  );
}
