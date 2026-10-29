import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { DashboardActions, DashboardOutputControls } from "./DashboardControls";
import { DashboardCollection } from "./DashboardCollection";
import { FramingStage } from "@/features/resize/ResizeView";
import { TrimPlayer } from "@/features/input/TrimPlayer";
import { exportActionLabel, exportBlocker, exportModifiers } from "@/features/export/summary";
import { sourceMeta, sourceName } from "@/features/input/sourceMeta";
import { Spinner } from "@/components/Spinner";
import { useShift } from "@/state/shift";
import shiftSymbol from "@/assets/brand/shift-symbol.png";

/** What is actually happening while a source is analysed. */
function analysisLabel(s: ReturnType<typeof useShift>) {
  if (s.lastInput?.kind !== "url") return "Reading file…";
  return s.analysisStage === "fetchingMediaInformation" ? "Fetching media information…" : "Resolving link…";
}

export function DashboardView() {
  const s = useShift();
  if (s.screen === "empty") return <EmptyDashboard />;
  const collection = !!s.batch || (s.urlMedia?.mediaItems.length ?? 0) > 1;
  const timed = !collection && !s.isImage;
  return <div className="dashboard shift-enter absolute inset-0 flex min-h-0 flex-col gap-2 overflow-hidden p-3">
    {s.analyzing && <div role="status" aria-live="polite" className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-md border border-[var(--accent-edge)] bg-shift-surface px-3 py-2 text-[12px] text-shift-text shadow-lg"><Spinner />{analysisLabel(s)}</div>}
    <DashboardSourceBar />
    {collection ? <DashboardCollection /> : <div className="dashboard-editor grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(224px,270px)] gap-3">
      <div className="dashboard-media flex min-h-0 min-w-0 flex-col gap-2">
        {timed ? <TrimPlayer key={s.localMedia?.path ?? s.activeMedia?.source} compact header={<div className="flex items-center justify-between gap-2"><div className="min-w-0"><span className="text-[12px] font-semibold text-shift-text">Trim</span><span className="ml-2 text-[11px] text-shift-soft">{s.clipEnabled ? "IN–OUT export" : "Full source export"}</span></div><Toggle on={s.clipEnabled} onChange={s.toggleClip} label="Trim" disabled={s.duration == null} /></div>} />
          : <FramingStage compact />}
        <DashboardActions />
      </div>
      <DashboardOutputControls />
    </div>}
    <DashboardExportBar />
  </div>;
}

function DashboardSourceBar() {
  const s = useShift();
  const title = s.batch ? s.batch.pdfSource ? `${s.batch.items.length} PDF pages` : `${s.batch.items.length} images` : sourceName(s);
  const meta = s.batch ? `${s.selectedBatchCount} selected` : [s.urlMedia?.platform, ...sourceMeta(s)].filter(Boolean).join(" · ");
  return <div className="dashboard-source flex h-[42px] shrink-0 items-center gap-3 rounded-[9px] border border-[var(--hairline)] bg-shift-surface px-3" aria-label="Current source">
    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.1em] text-shift-link">Source</span>
    <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-semibold text-shift-text" title={title}>{title}</div><div className="truncate font-mono text-[10px] text-shift-soft">{meta}</div></div>
    <button type="button" onClick={s.openFilePicker} aria-label="Open another source" className="shrink-0 rounded-md border border-[var(--hairline-bright)] px-2 py-1 text-[11px] text-shift-body">Open…</button>
  </div>;
}

function DashboardExportBar() {
  const s = useShift();
  const collection = !!s.batch || (s.urlMedia?.mediaItems.length ?? 0) > 1;
  const selected = s.batch ? s.selectedBatchCount : s.selectedMediaCount;
  const modifiers = collection ? `${selected} selected` : exportModifiers(s).join(" · ");
  const blocker = exportBlocker(s);
  const label = collection ? s.batch ? s.format === "PDF" ? "Export PDF…" : `Export ${selected} ${s.batch.pdfSource ? "Pages" : "Images"}…` : `Download ${selected} Selected…` : exportActionLabel(s);
  return <div className="dashboard-export shift-panel flex min-h-[54px] shrink-0 items-center gap-3 px-3 py-2" aria-label="Export bar">
    <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-semibold text-shift-text">{collection && !s.batch ? "Original files" : s.format} <span className="font-normal text-shift-dim">{modifiers ? `· ${modifiers}` : "· No edits applied"}</span></div>{blocker && <div role="alert" className="truncate text-[11px] text-shift-danger" title={blocker}>{blocker}</div>}</div>
    <Button variant="primary" size="sm" disabled={!s.canExport || s.saving} onClick={s.startExport} aria-keyshortcuts="Meta+Shift+E">{s.saving ? <span className="flex items-center gap-2"><Spinner />Choose destination…</span> : label}</Button>
    {s.saving && <span role="status" aria-live="polite" className="sr-only">Choose destination…</span>}
  </div>;
}

function EmptyDashboard() {
  const s = useShift();
  const [url, setUrl] = useState("");
  const valid = /^https?:\/\//i.test(url.trim());
  const submit = (event: FormEvent) => { event.preventDefault(); if (valid && !s.analyzing) s.submitUrl(url.trim()); };
  return <div className="dashboard-empty shift-enter absolute inset-0 flex items-center justify-center overflow-hidden p-4">
    <div className="flex w-full max-w-[620px] flex-col gap-4">
      <div><img src={shiftSymbol} alt="" draggable={false} className="shift-empty-symbol -my-2 -ml-[9px] h-[72px] w-[72px] select-none" /><h1 className="m-0 mt-1 text-[25px] font-semibold tracking-[-0.02em] text-shift-text">Anything in. Anything out.</h1><p className="m-0 mt-1 text-[12px] text-shift-dim">Video · Audio · Images · GIFs · PDFs · Public links</p></div>
      <form onSubmit={submit} className="flex gap-2" aria-label="Fetch a link" aria-busy={s.analyzing}><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a public media URL" aria-label="Media URL" className="h-10 min-w-0 flex-1 rounded-[9px] border border-[var(--hairline-bright)] bg-shift-input px-3 text-[13px] text-shift-text" /><Button type="submit" size="sm" variant="primary" disabled={!valid || s.analyzing}>{s.analyzing && s.lastInput?.kind === "url" ? <span className="flex items-center gap-2"><Spinner />{s.analysisStage === "fetchingMediaInformation" ? "Fetching…" : "Resolving…"}</span> : "Fetch"}</Button></form>
      {s.analyzing && <div role="status" aria-live="polite" className="flex items-center gap-2 text-[12px] text-shift-dim">{s.lastInput?.kind !== "url" && <Spinner />}{analysisLabel(s)}</div>}
      <div onClick={s.openFilePicker} onDragOver={(e) => { e.preventDefault(); s.setDragging(true); }} onDragLeave={() => s.setDragging(false)} onDrop={(e) => { e.preventDefault(); s.setDragging(false); const link = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain"); if (/^https?:\/\//i.test(link.trim())) s.submitUrl(link.trim()); }} className="flex min-h-[100px] cursor-pointer items-center justify-between gap-3 rounded-[10px] border border-dashed border-[var(--link-dash)] bg-shift-surface px-5">
        <div><div className="text-[13px] font-semibold text-shift-text">Drop files to start</div><div className="text-[11px] text-shift-soft">One PDF or multiple images</div></div><Button size="sm" onClick={(e) => { e.stopPropagation(); s.openFilePicker(); }} aria-keyshortcuts="Meta+O">Choose Files…</Button>
      </div>
      {s.healthError && <div role="alert" className="text-[11px] text-shift-danger">{s.healthError}</div>}
    </div>
  </div>;
}
