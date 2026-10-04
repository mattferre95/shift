import { Button } from "@/components/Button";
import { Notice } from "@/components/Notice";
import { Field, Inspector, SummaryRow } from "@/components/Panel";
import { exportActionLabel, exportBlocker, exportSettings } from "@/features/export/summary";
import { OutputChips } from "@/features/export/OutputChips";
import { formatBytes, resolutionLabel } from "@/lib/format";
import { useShift } from "@/state/shift";
import type { Compression } from "@/types";

/**
 * Compress: the source image on the left, the image encoder's settings on the
 * right. Images only — the levels are `compressionOptions(format)`, the same
 * list the export sends, and nothing here predicts a size: the real one is
 * known once the file exists, and the Complete screen shows it.
 */
export function CompressView() {
  return (
    <div className="shift-enter absolute inset-0 grid grid-cols-[minmax(0,1fr)_232px] gap-3 p-3 min-[900px]:grid-cols-[minmax(0,1fr)_256px] min-[900px]:gap-4 min-[900px]:p-4">
      <SourcePreview />
      <CompressInspector />
    </div>
  );
}

function SourcePreview() {
  const s = useShift();
  const w = s.localMedia?.width ?? s.activeMedia?.width ?? null;
  const h = s.localMedia?.height ?? s.activeMedia?.height ?? null;
  return (
    <div className="shift-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="relative min-h-[150px] flex-1 p-4">
        <div className="relative flex h-full w-full items-center justify-center">
          {s.previewImage ? (
            <img
              src={s.previewImage}
              alt=""
              draggable={false}
              className="max-h-full max-w-full rounded-[4px] object-contain shadow-[0_0_0_1px_var(--hairline-bright)]"
            />
          ) : (
            <span className="font-mono text-[11px] text-shift-quiet">{s.previewError ?? "No preview"}</span>
          )}
        </div>
        {/* What is drawn is the source, never an encoded result. */}
        <span className="pointer-events-none absolute left-6 top-6 rounded-[6px] bg-[var(--scrim)] px-2 py-[3px] text-[11px] font-semibold text-shift-text">
          Source preview
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--hairline)] px-4 py-[10px] text-[12px] text-shift-soft">
        <span>Encoded quality is not previewed</span>
        {resolutionLabel(w, h) && <span className="ml-auto font-mono text-shift-body">{resolutionLabel(w, h)}</span>}
      </div>
    </div>
  );
}

/**
 * Copy for each level. Qualitative on purpose: the encoder quality behind each
 * rung is fixed (see `media::image::Compression`), but what it does to the size
 * depends on the picture, so no number is promised.
 */
const LOSSY: Record<Exclude<Compression, "optimize">, string> = {
  none: "No extra compression applied.",
  light: "Lighter compression with more detail retained.",
  balanced: "Balanced quality and file size.",
  strong: "Stronger compression. Fine detail may soften.",
};
const PNG: Partial<Record<Compression, string>> = {
  none: "Saved as is, without extra recompression.",
  optimize: "Recompressed losslessly. Pixels are unchanged.",
};

function CompressInspector() {
  const s = useShift();
  const png = s.format === "PNG";
  const choices = s.compressionChoices;
  const settings = exportSettings(s);
  const blocker = exportBlocker(s);
  const size = s.localMedia?.sizeBytes ?? null;
  const label = s.compression !== "none" ? "Compress Image…" : exportActionLabel(s);

  return (
    <Inspector
      title="Compression"
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
            {label}
          </Button>
        </>
      }
    >
      <Field label="Format">
        <OutputChips />
      </Field>

      <Field label={png ? "PNG is lossless" : `${s.format} quality`}>
        <div role="group" aria-label="Compression" className="flex flex-col gap-[6px]">
          {choices.map((c, i) => (
            <CompressionOption
              key={c.id}
              label={c.label}
              description={(png ? PNG[c.id] : LOSSY[c.id as Exclude<Compression, "optimize">]) ?? ""}
              strength={png ? null : i}
              selected={s.compression === c.id}
              onSelect={() => s.setCompression(c.id)}
            />
          ))}
        </div>
      </Field>

      {s.localMedia?.hasAlpha && (
        <Notice tone="info">This image has transparency, so AVIF isn't offered — it can't carry it.</Notice>
      )}

      {size != null && (
        <div className="flex flex-col gap-1">
          <SummaryRow label="Original size" value={<span className="font-mono">{formatBytes(size)}</span>} />
          <div className="text-[11.5px] text-shift-soft">The final size is shown after export.</div>
        </div>
      )}

      {/* The format is chosen at the top of this panel, so the summary only
          lists what was set elsewhere or below. */}
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

/**
 * One level. The bars are a rung on the ladder — how hard this asks the encoder
 * to work — not a measured quality or size, so they carry no numbers.
 */
function CompressionOption({
  label,
  description,
  strength,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  strength: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={description}
      onClick={onSelect}
      className={[
        "flex min-h-[38px] w-full items-center gap-3 rounded-[10px] border px-3 py-[7px] text-left transition-colors duration-[140ms]",
        selected
          ? "border-shift-accent bg-[image:var(--accent-select)]"
          : "border-[var(--hairline-faint)] bg-[image:var(--control-gradient)] hover:border-[var(--hairline-bright)]",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] ${selected ? "border-shift-accent" : "border-shift-faint"}`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-shift-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] font-semibold ${selected ? "text-shift-text" : "text-shift-body"}`}>{label}</span>
        {/* Only the chosen level explains itself; the rest stay one line. */}
        {selected && <span className="block text-[11.5px] leading-[1.35] text-shift-soft">{description}</span>}
      </span>
      {strength != null && (
        <span aria-hidden="true" className="flex shrink-0 items-end gap-[2px]" title="Relative strength">
          {[0, 1, 2].map((j) => (
            <span
              key={j}
              className={`w-[3px] rounded-[1px] ${j < strength ? (selected ? "bg-shift-link" : "bg-shift-soft") : "bg-shift-chip-hi"}`}
              style={{ height: 6 + j * 3 }}
            />
          ))}
        </span>
      )}
    </button>
  );
}
