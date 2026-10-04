import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Field, Inspector, SummaryRow } from "@/components/Panel";
import { LoopField } from "@/features/export/LoopField";
import { exportActionLabel, exportBlocker, exportSettings, loopNote } from "@/features/export/summary";
import { sourceMeta } from "@/features/input/sourceMeta";
import { useShift } from "@/state/shift";
import { useView } from "@/state/view";
import { isAnimationFormat, isAudioFormat, isImageFormat, type OutputFormat } from "@/types";

type Kind = "video" | "loop" | "audio" | "image";

const KIND_LABEL: Record<Kind, string> = { video: "Video", loop: "Loop", audio: "Audio", image: "Image" };

/**
 * What an output is, from this source. WEBP is a still from a photo and an
 * animation from moving media, so the source answers alongside the format —
 * the same rule `isLoop` follows in the state.
 */
function kindOf(f: OutputFormat, sourceMoves: boolean, isImage: boolean): Kind {
  if (isAudioFormat(f)) return "audio";
  if (isAnimationFormat(f) && sourceMoves && !isImage) return "loop";
  if (isImageFormat(f)) return "image";
  return "video";
}

/**
 * Convert: one source, and what it becomes. The choices are the `outputs` the
 * export already offers for this source; picking one calls the same `setFormat`
 * as everywhere else. Opening this view changes nothing.
 */
export function ConvertView() {
  return (
    <div className="shift-enter absolute inset-0 grid grid-cols-[minmax(0,1fr)_232px] gap-3 p-3 min-[900px]:grid-cols-[minmax(0,1fr)_256px] min-[900px]:gap-4 min-[900px]:p-4">
      <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto">
        <Conversion />
        <FormatGrid />
      </div>
      <ConvertInspector />
    </div>
  );
}

/** Source → output, in one line of large type, beside the picture SHIFT already has. */
function Conversion() {
  const s = useShift();
  const isUrl = s.screen === "url";
  const typeLabel = sourceMeta(s)[0] ?? "";
  const from = isUrl ? s.urlMedia?.platform ?? "Link" : s.localMedia?.ext ?? "";
  const kind = kindOf(s.format, s.sourceMoves, s.isImage);
  const audioOnly = s.localMedia ? !s.localMedia.hasVideo && s.localMedia.kind !== "image" : s.activeMedia?.type === "audio";

  return (
    <section aria-label="Conversion" className="shift-panel flex shrink-0 items-center gap-4 p-4">
      <div className="flex h-[72px] w-[112px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-black shadow-[inset_0_0_0_1px_var(--hairline)] max-[899px]:hidden">
        {s.previewImage && !audioOnly ? (
          <img src={s.previewImage} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <span className="font-mono text-[10px] tracking-[0.06em] text-shift-quiet">{typeLabel.toUpperCase()}</span>
        )}
      </div>
      <End label="Source" value={from} kind={typeLabel} />
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 stroke-shift-link" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
      <End label="Output" value={s.format} kind={KIND_LABEL[kind]} strong />
    </section>
  );
}

function End({ label, value, kind, strong }: { label: string; value: string; kind: string; strong?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className={`text-[11px] font-medium ${strong ? "text-shift-link" : "text-shift-soft"}`}>{label}</span>
      <span className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-shift-text">{value}</span>
      <span className="text-[11.5px] uppercase tracking-[0.06em] text-shift-soft">{kind}</span>
    </div>
  );
}

/** Every output this source offers, grouped by what it produces. Empty groups are left out. */
function FormatGrid() {
  const s = useShift();
  const order: Kind[] = ["video", "loop", "audio", "image"];
  const groups = order
    .map((k) => ({ kind: k, formats: s.outputs.filter((f) => kindOf(f, s.sourceMoves, s.isImage) === k) }))
    .filter((g) => g.formats.length > 0);

  return (
    <section aria-label="Output format" className="shift-panel flex shrink-0 flex-col gap-4 p-4">
      {groups.map((g) => (
        <div key={g.kind} className="flex flex-col gap-2">
          <span className="text-[11.5px] font-medium text-shift-muted">{KIND_LABEL[g.kind]}</span>
          <div role="group" aria-label={`${KIND_LABEL[g.kind]} formats`} className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
            {g.formats.map((f) => (
              <FormatOption key={f} format={f} kind={KIND_LABEL[g.kind]} selected={s.format === f} onSelect={() => s.setFormat(f)} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function FormatOption({ format, kind, selected, onSelect }: { format: OutputFormat; kind: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={format}
      onClick={onSelect}
      className={[
        "flex h-[52px] flex-col items-start justify-center rounded-[10px] border px-3 text-left transition-colors duration-[140ms]",
        selected
          ? "border-shift-accent bg-[image:var(--accent-select)]"
          : "border-[var(--hairline-faint)] bg-[image:var(--control-gradient)] hover:border-[var(--hairline-bright)]",
      ].join(" ")}
    >
      <span className={`text-[14px] font-semibold ${selected ? "text-shift-text" : "text-shift-body"}`}>{format}</span>
      <span className="text-[10.5px] uppercase tracking-[0.06em] text-shift-soft">{kind}</span>
    </button>
  );
}

function ConvertInspector() {
  const s = useShift();
  const { available } = useView();
  const note = s.isLoop ? loopNote(s) : null;
  // The loop limit is said under Loop size; a bad range is said in Edit, so
  // it is repeated here only as the reason Export is unavailable.
  const blocker = note?.blocking ? null : exportBlocker(s);
  // Loop size has its own control here, so it is not repeated as a summary row.
  const settings = exportSettings(s).filter((x) => x.label !== "Loop");
  const kind = kindOf(s.format, s.sourceMoves, s.isImage);

  return (
    <Inspector
      title="Output"
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
            {exportActionLabel(s)}
          </Button>
        </>
      }
    >
      <Field label="Format">
        <div className="flex items-baseline gap-2">
          <span className="text-[18px] font-semibold text-shift-text">{s.format}</span>
          <span className="text-[11.5px] uppercase tracking-[0.06em] text-shift-soft">{KIND_LABEL[kind]}</span>
        </div>
        {kind === "audio" && s.sourceMoves && (
          <div className="text-[11.5px] leading-[1.45] text-shift-soft">Exports the sound only.</div>
        )}
        {s.screen === "url" && (
          <div className="text-[11.5px] leading-[1.45] text-shift-soft">Saved as {s.format} when you export.</div>
        )}
        {kind === "image" && available.compress && (
          <div className="text-[11.5px] leading-[1.45] text-shift-soft">Compression can be adjusted in Compress.</div>
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
          <span className="text-[11.5px] font-medium text-shift-muted">Also applied</span>
          {settings.map((x) => (
            <SummaryRow key={x.label} label={x.label} value={x.value} />
          ))}
        </div>
      )}
    </Inspector>
  );
}
