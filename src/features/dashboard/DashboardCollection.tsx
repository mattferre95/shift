import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatMediaTime, resolutionLabel } from "@/lib/format";
import { useShift } from "@/state/shift";
import type { Compression, OutputFormat } from "@/types";

/** Only a viewport-sized slice mounts; IDs, order and selection stay in shift.tsx. */
export function DashboardCollection() {
  const s = useShift();
  const batch = s.screen === "batch" ? s.batch : null;
  const post = s.screen === "url" && (s.urlMedia?.mediaItems.length ?? 0) > 1 ? s.urlMedia : null;
  const count = batch?.items.length ?? post?.mediaItems.length ?? 0;
  const [page, setPage] = useState(0);
  const pageSize = 5;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  useEffect(() => setPage((n) => Math.min(n, pages - 1)), [pages]);
  if (!batch && !post) return null;
  const selected = batch ? s.selectedBatchCount : s.selectedMediaCount;
  const items = batch?.items ?? post?.mediaItems ?? [];
  return <div className="dashboard-collection grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(190px,0.75fr)] gap-3" aria-label={batch ? "Image batch" : "Post media"}>
    <section className="shift-panel flex min-h-0 flex-col overflow-hidden p-3">
      <div className="flex items-center gap-2 border-b border-[var(--hairline)] pb-2">
        <strong className="text-[13px] text-shift-text">{count} {batch ? "images" : "post items"}</strong>
        <span className="text-[11px] text-shift-soft">{selected} selected</span>
        {batch && <button type="button" onClick={s.openFilePicker} className="ml-auto text-[11px] font-semibold text-shift-link">+ Add files</button>}
      </div>
      <div className="flex items-center gap-3 py-2 text-[11px]">
        <button type="button" onClick={batch ? s.selectAllBatch : s.selectAllPostMedia} className="text-shift-link">Select all</button>
        <button type="button" onClick={batch ? s.deselectAllBatch : s.clearPostMedia} className="text-shift-dim">Deselect all</button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col" role="list">
        {items.slice(page * pageSize, (page + 1) * pageSize).map((item, n) => {
          const index = page * pageSize + n;
          const name = batch ? batch.items[index].media.name : post!.mediaItems[index].filenameHint ?? `${post!.mediaItems[index].type} ${index + 1}`;
          const checked = batch ? batch.items[index].selected : s.selectedMediaIds.includes(post!.mediaItems[index].id);
          return <div key={item.id} role="listitem" className="flex min-h-9 items-center gap-2 border-b border-[var(--hairline-faint)] text-[12px]">
            <input type="checkbox" checked={checked} onChange={() => batch ? s.toggleBatchItem(item.id) : s.togglePostMedia(item.id)} aria-label={`Include ${name}`} />
            <button type="button" onClick={() => !batch && s.selectPostMedia(index)} className={`min-w-0 flex-1 truncate text-left ${!batch && s.activeMediaIndex === index ? "text-shift-link" : "text-shift-body"}`} title={name}>{index + 1}. {name}</button>
            {batch && <button type="button" onClick={() => s.removeBatchItem(item.id)} aria-label={`Remove ${name}`} className="text-shift-soft">×</button>}
          </div>;
        })}
      </div>
      <div className="flex items-center justify-end gap-3 pt-2 text-[11px] text-shift-soft"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button></div>
    </section>
    <section className="shift-panel flex min-h-0 flex-col gap-3 overflow-hidden p-3" aria-label="Collection output">
      {batch ? <>
        <label className="flex flex-col gap-1 text-[11px] text-shift-soft">Batch name<input value={batch.name} onChange={(e) => s.setBatchName(e.target.value)} className="h-8 w-full rounded-md border border-[var(--hairline)] bg-shift-input px-2 text-[12px] text-shift-text" /></label>
        <label className="flex flex-col gap-1 text-[11px] text-shift-soft">Output format<select value={s.format} onChange={(e) => s.setFormat(e.target.value as OutputFormat)} className="h-8 rounded-md border border-[var(--hairline)] bg-shift-input px-2 text-shift-text">{s.outputs.map((f) => <option key={f}>{f}</option>)}</select></label>
        <label className="flex flex-col gap-1 text-[11px] text-shift-soft">Compression<select value={s.compression} onChange={(e) => s.setCompression(e.target.value as Compression)} className="h-8 rounded-md border border-[var(--hairline)] bg-shift-input px-2 text-shift-text">{s.compressionChoices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <div className="text-[11px] text-shift-dim">{selected} numbered {selected === 1 ? "file" : "files"} will export in source order.</div>
        {batch.skipped.length > 0 && <div role="alert" className="text-[11px] text-shift-danger">{batch.skipped.length} incompatible files skipped.</div>}
      </> : <>
        <div className="text-[12px] font-semibold text-shift-text">Save original post media</div>
        <PostItemInspector />
        <div className="text-[11px] leading-relaxed text-shift-dim">Select items to download. Each selected item is saved as posted. Editing settings do not apply to a multi-item post.</div>
        <div className="mt-auto text-[11px] text-shift-soft">{selected} {selected === 1 ? "item" : "items"} selected</div>
      </>}
    </section>
  </div>;
}

function PostItemInspector() {
  const s = useShift();
  const item = s.activeMedia;
  const [broken, setBroken] = useState<string | null>(null);
  if (!item) return null;
  const src = item.thumbnailPath && broken !== item.id ? convertFileSrc(item.thumbnailPath) : null;
  const dimensions = resolutionLabel(item.width, item.height);
  const details = [item.type, item.duration == null ? null : formatMediaTime(item.duration), dimensions].filter(Boolean).join(" · ");
  return <div className="min-w-0 rounded-md border border-[var(--hairline)] p-2" aria-label="Selected post item">
    <div className="flex h-[80px] items-center justify-center overflow-hidden rounded bg-black">
      {src ? <img src={src} alt="" draggable={false} onError={() => setBroken(item.id)} className="h-full w-full object-contain" /> : <span className="font-mono text-[10px] uppercase text-shift-soft">{item.type}</span>}
    </div>
    <div className="mt-2 truncate text-[11px] font-semibold text-shift-body" title={item.filenameHint ?? undefined}>{item.filenameHint ?? `Item ${s.activeMediaIndex + 1}`}</div>
    <div className="truncate font-mono text-[10px] text-shift-soft" title={details}>{details}</div>
  </div>;
}
