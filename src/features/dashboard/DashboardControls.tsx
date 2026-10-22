import { FlipControls } from "@/features/resize/FlipControls";
import { SoundControl } from "@/features/edit/SoundControl";
import { soundApplies, sourceHasAudio } from "@/features/export/summary";
import { SizeField } from "@/components/SizeField";
import { useShift } from "@/state/shift";
import { ASPECT_ROWS, LOOP_SIZES, MAX_DIMENSION, MIN_DIMENSION, aspectLabel, type AspectRatio, type Compression, type FrameMode, type LoopSize, type OutputFormat } from "@/types";

const selectClass = "dashboard-select h-8 min-w-0 w-full rounded-md border border-[var(--hairline-bright)] bg-shift-input px-2 text-[12px] font-medium text-shift-text";

export function DashboardActions() {
  const s = useShift();
  const audio = soundApplies(s);
  return <div className="dashboard-actions flex min-h-0 shrink-0 items-center gap-2" aria-label="Editing actions">
    {audio && <div className="dashboard-sound"><SoundControl dashboard /></div>}
    {audio && sourceHasAudio(s) == null && <span className="text-[11px] text-shift-soft">Checking audio…</span>}
    {s.showAspect && <><span className="text-[11px] text-shift-soft">Flip</span><FlipControls /></>}
  </div>;
}

function Control({ label, children, name }: { label: string; children: React.ReactNode; name?: string }) {
  return <label className="dashboard-control flex min-w-0 flex-col gap-1" data-control={name}>
    <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-shift-soft">{label}</span>
    {children}
  </label>;
}

export function DashboardOutputControls() {
  const s = useShift();
  const sourceW = s.localMedia?.width ?? s.activeMedia?.width ?? s.playback.info?.width ?? null;
  const sourceH = s.localMedia?.height ?? s.activeMedia?.height ?? s.playback.info?.height ?? null;
  const output = s.aspect.ratio === "original" ? (sourceW && sourceH ? `${sourceW} × ${sourceH}` : "Source size") : s.aspectPreview ? `${s.aspectPreview.width} × ${s.aspectPreview.height}` : "Measuring…";
  const visual = s.showAspect;
  const custom = visual && s.aspect.ratio === "freeform";
  return <section className="dashboard-output shift-panel flex min-h-0 min-w-0 flex-col gap-[9px] overflow-hidden p-3" aria-label="Output and framing">
    <div className="flex items-baseline justify-between gap-2 border-b border-[var(--hairline)] pb-2">
      <h2 className="m-0 text-[13px] font-semibold text-shift-text">Output & framing</h2>
      <span className="truncate font-mono text-[11px] text-shift-soft">{s.format}</span>
    </div>
    <div className="dashboard-control-grid grid grid-cols-2 gap-x-2 gap-y-[9px]">
      <Control label="Format" name="format"><select className={selectClass} aria-label="Output format" value={s.format} onChange={(e) => s.setFormat(e.target.value as OutputFormat)}>{s.outputs.map((f) => <option key={f} value={f}>{f}</option>)}</select></Control>
      {s.showQuality ? <Control label="Source quality"><select className={selectClass} aria-label="Source quality" value={s.quality} onChange={(e) => s.setQuality(e.target.value)}>{s.activeMedia?.qualities.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select></Control>
        : visual ? <Control label="Output size"><div className="dashboard-readout flex h-8 items-center truncate rounded-md border border-[var(--hairline)] px-2 font-mono text-[11px] text-shift-body" title={output}>{output}</div></Control>
        : null}
      {visual && <Control label="Aspect ratio"><select className={selectClass} aria-label="Aspect ratio" value={s.aspect.ratio} onChange={(e) => s.setAspectRatio(e.target.value as AspectRatio)}>{ASPECT_ROWS.flat().map((ratio) => <option key={ratio} value={ratio}>{aspectLabel(ratio)}</option>)}</select></Control>}
      {visual && <Control label="Frame mode"><select className={selectClass} aria-label="Frame mode" value={s.aspect.frame} onChange={(e) => s.setFrameMode(e.target.value as FrameMode)} disabled={s.aspect.ratio === "original"}><option value="fill">Fill · crop</option><option value="fit">Fit · pad</option></select></Control>}
      {s.isImage && s.compressionChoices.length > 1 && <Control label="Compression"><select className={selectClass} aria-label="Compression" value={s.compression} onChange={(e) => s.setCompression(e.target.value as Compression)}>{s.compressionChoices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Control>}
      {s.isLoop && <Control label="Loop size"><select className={selectClass} aria-label="Loop size" value={s.loopSize} onChange={(e) => s.setLoopSize(e.target.value as LoopSize)}>{LOOP_SIZES.map((l) => <option key={l.id} value={l.id}>{l.label} · {l.detail}</option>)}</select></Control>}
    </div>
    {visual && <div className="dashboard-dimensions border-t border-[var(--hairline)] pt-2 text-[11px] text-shift-soft">Source {sourceW && sourceH ? `${sourceW} × ${sourceH}` : "unknown"} <span className="mx-1">→</span> Output <span className="text-shift-body">{output}</span></div>}
    {custom && <div className="dashboard-size-row flex items-end gap-2">
      <SizeField fill label="WIDTH" value={s.aspect.width} onChange={(v) => s.setAspectSize("width", v)} invalid={s.aspect.width != null && (s.aspect.width < MIN_DIMENSION || s.aspect.width > MAX_DIMENSION)} />
      <button type="button" aria-label="Lock proportions" aria-pressed={s.aspectLocked} onClick={s.toggleAspectLock} className="h-[33px] rounded-md border border-[var(--hairline-bright)] px-2 text-shift-body">{s.aspectLocked ? "🔒" : "🔓"}</button>
      <SizeField fill label="HEIGHT" value={s.aspect.height} onChange={(v) => s.setAspectSize("height", v)} invalid={s.aspect.height != null && (s.aspect.height < MIN_DIMENSION || s.aspect.height > MAX_DIMENSION)} />
    </div>}
    {s.aspectUpscales && <div role="status" className="text-[11px] text-shift-warning">Enlarges pixels; no detail is added.</div>}
    {s.isLoop && s.loopTooLong && <div role="alert" className="text-[11px] text-shift-danger">{s.format} is limited to {s.loopMaxSeconds}s. Enable Trim and shorten the range.</div>}
  </section>;
}
