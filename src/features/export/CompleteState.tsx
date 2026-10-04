import { Button } from "@/components/Button";
import { SummaryRow } from "@/components/Panel";
import { HomeFrame } from "@/features/input/Home";
import { formatBytes } from "@/lib/format";
import * as ipc from "@/lib/ipc";
import { useShift } from "@/state/shift";

/**
 * State E. What was made, where it went, and what to do next. Every value is
 * the finished job's own report; the size change is worked out from the two
 * measured sizes and only when both exist.
 */
export function CompleteState() {
  const s = useShift();
  const { output, reset } = s;
  const multi = (s.urlMedia?.mediaItems.length ?? 0) > 1;
  const fromUrl = !!s.urlMedia && !s.localMedia;
  const ext = !multi ? output?.filename.split(".").pop()?.toUpperCase() : null;

  const before = output?.sourceBytes ?? null;
  const after = output?.sizeBytes ?? null;
  const change =
    before != null && after != null && before > 0 ? Math.round((1 - after / before) * 100) : null;

  return (
    <HomeFrame width={480}>
      <div className="shift-panel flex flex-col gap-5 px-6 py-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--success-edge)] bg-[var(--success-tint)]">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="stroke-shift-success" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l5 5 9-10" />
            </svg>
          </div>
          <h2 role="status" className="m-0 text-[19px] font-semibold text-shift-text">
            {fromUrl ? "Download complete" : "Export complete"}
          </h2>
        </div>

        <div className="break-all font-mono text-[14px] leading-snug text-shift-text" title={output?.path}>
          {output?.filename}
        </div>

        <div className="flex flex-col gap-2">
          {ext && <SummaryRow label="Format" value={ext} />}
          {before != null && after != null ? (
            <>
              <SummaryRow label="Original" value={<span className="font-mono">{formatBytes(before)}</span>} />
              <SummaryRow
                label="Output"
                value={
                  <span className="font-mono">
                    {formatBytes(after)}
                    {change != null && change !== 0 && (
                      <span className={change > 0 ? "ml-2 text-shift-success" : "ml-2 text-shift-soft"}>
                        {change > 0 ? `${change}% smaller` : `${-change}% larger`}
                      </span>
                    )}
                  </span>
                }
              />
            </>
          ) : (
            after != null && (
              <SummaryRow label={multi ? "Total size" : "Size"} value={<span className="font-mono">{formatBytes(after)}</span>} />
            )
          )}
          {output?.directory && (
            <SummaryRow
              label="Folder"
              value={<span className="font-mono" title={output.path}>{output.directory}</span>}
            />
          )}
          {!multi && output?.remuxed && (
            <div className="text-[11.5px] text-shift-soft">Streams were copied without re-encoding.</div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-[10px] border-t border-[var(--hairline)] pt-4">
          <Button onClick={reset}>New Shift</Button>
          <Button
            variant="primary"
            onClick={() => output && ipc.revealInFinder(output.path).catch(() => {})}
          >
            Show in Finder
          </Button>
        </div>
      </div>
    </HomeFrame>
  );
}
