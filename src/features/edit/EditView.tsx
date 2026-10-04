import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { Field, Inspector, SummaryRow } from "@/components/Panel";
import { Toggle } from "@/components/Toggle";
import { exportActionLabel, exportBlocker, exportSettings, loopNote } from "@/features/export/summary";
import { SoundControl } from "@/features/edit/SoundControl";
import { OutputChips } from "@/features/export/OutputChips";
import { sourceMeta, sourceName } from "@/features/input/sourceMeta";
import { TrimPlayer } from "@/features/input/TrimPlayer";
import { useShift } from "@/state/shift";
import { isAudioFormat } from "@/types";
import { LoopField } from "@/features/export/LoopField";

/**
 * Edit: the media and its range on the left, the export on the right.
 *
 * A view, not a mode of the export: Trim is the same `clipEnabled` the export
 * has always read, switched here in plain sight, so opening Edit never changes
 * what will be produced.
 */
export function EditView() {
  const s = useShift();
  return (
    <div className="shift-enter absolute inset-0 grid grid-cols-[minmax(0,1fr)_232px] gap-3 p-3 min-[900px]:grid-cols-[minmax(0,1fr)_256px] min-[900px]:gap-4 min-[900px]:p-4">
      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto">
        {s.clipEnabled ? (
          <TrimPlayer key={s.localMedia?.path ?? s.activeMedia?.source} header={<TrimSwitch />} />
        ) : (
          <TrimOff />
        )}
      </div>
      <ExportInspector />
    </div>
  );
}

/** The workspace header for a mode: what is open, and (in Edit) its sound. */
export function EditHeader({ sound = true }: { sound?: boolean }) {
  const s = useShift();
  const url = s.screen === "url" ? s.urlMedia : null;
  const meta = [url?.platform, url?.author, ...sourceMeta(s)].filter(Boolean).join(" · ");
  return <Header title={sourceName(s)} meta={meta} aside={sound ? <SoundControl /> : undefined} />;
}

function TrimSwitch() {
  const s = useShift();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-shift-text">Trim</div>
        <div className="text-[11.5px] text-shift-soft">
          {s.clipEnabled ? "Exports IN to OUT only." : "Exports the whole file."}
        </div>
      </div>
      <Toggle on={s.clipEnabled} onChange={s.toggleClip} label="Trim" />
    </div>
  );
}

/**
 * Trim off: the whole source goes out. The player starts with the range, so
 * this shows the picture SHIFT already has and the switch that brings it up.
 */
function TrimOff() {
  const s = useShift();
  const audioOnly = s.localMedia ? !s.localMedia.hasVideo : s.activeMedia?.type === "audio";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative flex min-h-[130px] flex-1 items-center justify-center overflow-hidden rounded-[14px] border border-[var(--hairline)] bg-black">
        {s.previewImage && !audioOnly ? (
          <img src={s.previewImage} alt="" draggable={false} className="h-full w-full object-contain" />
        ) : (
          <span className="font-mono text-[11px] tracking-[0.06em] text-shift-quiet">
            {audioOnly ? "AUDIO" : s.previewError ? "NO PREVIEW" : "VIDEO"}
          </span>
        )}
      </div>
      <div className="shift-panel flex shrink-0 flex-col gap-3 p-3">
        <TrimSwitch />
        <div className="text-[12px] text-shift-dim">Turn on Trim to play the media here and choose a range.</div>
      </div>
    </div>
  );
}

/** The export, as currently configured, and the one action that produces it. */
function ExportInspector() {
  const s = useShift();
  const settings = exportSettings(s);
  const note = s.isLoop ? loopNote(s) : null;
  // A loop that is too long says so under Loop size, and a bad range says so
  // under the timeline; the footer only carries reasons shown nowhere else.
  const blocker = note?.blocking || (s.clipEnabled && s.clipError) ? null : exportBlocker(s);
  const label = exportActionLabel(s);

  return (
    <Inspector
      title="Export"
      footer={
        <>
          {blocker && (
            <div role="alert" className="text-[12px] leading-[1.45] text-shift-danger">
              {blocker}
            </div>
          )}
          <Button
            variant="primary"
            className="w-full"
            disabled={!s.canExport || s.saving}
            onClick={s.startExport}
            aria-keyshortcuts="Meta+Shift+E"
          >
            {/* The ellipsis is literal: this opens the native Save panel. */}
            {label}
          </Button>
        </>
      }
    >
      <Field label="Format">
        <OutputChips />
        {isAudioFormat(s.format) && s.sourceMoves && (
          <div className="text-[11.5px] leading-[1.45] text-shift-soft">Exports the sound only.</div>
        )}
      </Field>

      {s.showQuality && (
        <Field label="Quality">
          <div className="flex flex-wrap gap-2">
            {s.activeMedia?.qualities.map((q) => (
              <Chip key={q.id} label={q.label} selected={s.quality === q.id} onClick={() => s.setQuality(q.id)} />
            ))}
          </div>
        </Field>
      )}

      <LoopField />

      {settings.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-[var(--hairline)] pt-3">
          {settings.map((x) => (
            <SummaryRow key={x.label} label={x.label} value={x.value} />
          ))}
        </div>
      )}
    </Inspector>
  );
}
