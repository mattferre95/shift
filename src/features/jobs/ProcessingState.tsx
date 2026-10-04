import { Button } from "@/components/Button";
import { HomeFrame } from "@/features/input/Home";
import { sourceName } from "@/features/input/sourceMeta";
import { useShift } from "@/state/shift";

/**
 * State D. The stage the native layer says it is in, how far through that
 * stage it is when it actually knows (JOB-03), and Cancel. Nothing here is
 * timed or estimated: no number appears unless one was reported.
 */
export function ProcessingState() {
  const s = useShift();
  const { job, cancel } = s;
  const multi = (s.urlMedia?.mediaItems.length ?? 0) > 1;

  // Before the first event the pipeline is not planned yet, so there is no
  // stage to count and nothing to measure.
  const queued = job == null || job.state === "queued";
  const stages = Math.max(1, job?.stageCount ?? 1);
  const index = Math.min(job?.stageIndex ?? 0, stages - 1);
  const fraction = queued ? null : job?.progress ?? null;
  const percent = fraction == null ? null : Math.round(Math.max(0, Math.min(1, fraction)) * 100);

  const name = sourceName(s);
  const thumb = !multi ? s.previewImage : null;

  return (
    <HomeFrame width={460}>
      <div className="shift-panel flex flex-col gap-5 px-6 py-6">
        <div className="flex items-center gap-3">
          {thumb && (
            <img src={thumb} alt="" draggable={false} className="h-10 w-[60px] shrink-0 rounded-[6px] bg-black object-cover shadow-[0_0_0_1px_var(--hairline)]" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-shift-body" title={name}>{name || "Your media"}</div>
            <div className="text-[12px] text-shift-soft">
              {multi ? "Original files from the post" : <>→ <span className="font-semibold text-shift-text">{s.format}</span></>}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 role="status" aria-live="polite" className="m-0 text-[19px] font-semibold text-shift-text">
              {job?.stageLabel || "Preparing…"}
            </h2>
            {percent != null && <span className="font-mono text-[13px] text-shift-dim">{percent}%</span>}
          </div>

          <div
            role="progressbar"
            aria-label={job?.stageLabel || "Preparing"}
            aria-valuemin={percent == null ? undefined : 0}
            aria-valuemax={percent == null ? undefined : 100}
            aria-valuenow={percent ?? undefined}
            className="relative h-[6px] overflow-hidden rounded-full bg-shift-track"
          >
            {percent != null ? (
              <div className="h-full rounded-full bg-shift-accent transition-[width] duration-[400ms] ease-out" style={{ width: `${percent}%` }} />
            ) : (
              // No measurement: a sweep that says "working", never "how far".
              <div className="absolute inset-y-0 left-0 w-1/3 animate-[shift-sweep_1.4s_ease-in-out_infinite] rounded-full bg-[linear-gradient(90deg,transparent,var(--accent-edge),transparent)]" />
            )}
          </div>

          <div className="flex items-center justify-between gap-3 text-[12px] text-shift-soft">
            <span>{!queued && stages > 1 ? `Step ${index + 1} of ${stages}` : " "}</span>
            {job?.filename && (
              <span className="min-w-0 truncate font-mono text-shift-dim" title={job.filename}>{job.filename}</span>
            )}
          </div>
        </div>

        {!multi && s.outputDir && (
          <div className="truncate border-t border-[var(--hairline)] pt-3 font-mono text-[11.5px] text-shift-soft" title={s.outputDir}>
            Saving to {s.outputDir}
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    </HomeFrame>
  );
}
