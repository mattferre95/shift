import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { formatBytes } from "@/lib/format";
import { useShift } from "@/state/shift";

export function ImageBatchView() {
  const s = useShift();
  const batch = s.batch;
  if (!batch) return null;
  return (
    <div className="shift-enter absolute inset-0 flex flex-col gap-3 overflow-hidden p-3 min-[900px]:p-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div><h2 className="m-0 text-[19px] font-semibold text-shift-text">{batch.items.length} images</h2>
          <p className="m-0 text-[12px] text-shift-soft">{s.analyzing ? "Adding files…" : `${s.selectedBatchCount} selected for export`}</p></div>
        <div className="flex gap-2"><Button size="sm" onClick={s.openFilePicker} disabled={s.analyzing}>+ Add files</Button><Button size="sm" onClick={s.reset}>New Shift</Button></div>
      </div>
      <div className="shift-panel flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--hairline)] px-4 py-2 text-[12px] text-shift-soft">
          <button type="button" onClick={s.selectAllBatch} disabled={s.analyzing}>Select all</button>
          <button type="button" onClick={s.deselectAllBatch} disabled={s.analyzing}>Deselect all</button>
          <span className="ml-auto">Source order is export order</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Images in batch">
          {batch.items.map((item) => (
            <div key={item.id} role="listitem" className="flex min-h-[49px] items-center gap-3 border-b border-[var(--hairline)] px-4 py-2 text-[12px]">
              <input type="checkbox" checked={item.selected} onChange={() => s.toggleBatchItem(item.id)} disabled={s.analyzing} aria-label={`Select ${item.media.name}`} />
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] bg-shift-chip-hi text-shift-soft">▧</span>
              <span className="min-w-0 flex-1 truncate font-medium text-shift-body" title={item.media.path}>{item.media.name}</span>
              <span className="shrink-0 font-mono text-shift-soft">{item.media.width && item.media.height ? `${item.media.width} × ${item.media.height}` : formatBytes(item.media.sizeBytes)}</span>
              <button type="button" onClick={() => s.removeBatchItem(item.id)} disabled={s.analyzing} aria-label={`Remove ${item.media.name}`} className="ml-2 text-shift-quiet hover:text-shift-text">×</button>
            </div>
          ))}
        </div>
      </div>
      {batch.skipped.length > 0 && <div role="alert" className="max-h-20 shrink-0 overflow-y-auto rounded-[8px] border border-[var(--hairline)] px-3 py-2 text-[11px] text-shift-danger">
        {batch.skipped.length} skipped: {batch.skipped.map((entry) => `${entry.path.split("/").pop()} (${entry.reason})`).join("; ")}
      </div>}
      <div className="shift-panel flex shrink-0 flex-wrap items-end gap-4 p-3">
        <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-[11px] text-shift-soft">Batch name
          <input value={batch.name} onChange={(event) => s.setBatchName(event.target.value)} className="w-full rounded-[6px] border border-[var(--hairline)] bg-transparent px-2 py-[6px] text-[13px] text-shift-text" />
        </label>
        <div className="flex flex-col gap-1 text-[11px] text-shift-soft">Output format
          <div className="flex gap-1">{s.outputs.map((format) => <Chip key={format} label={format} selected={s.format === format} onClick={() => s.setFormat(format)} />)}</div>
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-shift-soft">Compression
          <select value={s.compression} onChange={(event) => s.setCompression(event.target.value as typeof s.compression)} className="rounded-[6px] border border-[var(--hairline)] bg-shift-window px-2 py-[6px] text-[13px] text-shift-text">
            {s.compressionChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select>
        </label>
        <Button variant="primary" onClick={s.startExport} disabled={!s.canExport || s.saving}>Export {s.selectedBatchCount}</Button>
      </div>
    </div>
  );
}
