import type { BatchItem, ImageBatch, LocalMedia, OutputFormat } from "@/types";

export function appendImages(batch: ImageBatch | null, media: LocalMedia[], skipped: ImageBatch["skipped"]): ImageBatch {
  const items: BatchItem[] = media.map((source) => ({
    id: crypto.randomUUID(), media: source, selected: true, status: "pending", output: null, error: null,
  }));
  return batch
    ? { ...batch, items: [...batch.items, ...items], skipped: [...batch.skipped, ...skipped] }
    : {
        items,
        name: media[0]?.name.replace(/\.[^.]+$/, "") ?? "images",
        destination: null,
        skipped,
        pdfSource: null,
      };
}

export const selectedImages = (batch: ImageBatch) => batch.items.filter((item) => item.selected);

export function commonFormats(batch: ImageBatch): OutputFormat[] {
  const selected = selectedImages(batch);
  if (!selected.length) return [];
  return selected[0].media.outputs.filter((format) => selected.every((item) => item.media.outputs.includes(format)));
}

export function setAllSelected(batch: ImageBatch, selected: boolean): ImageBatch {
  return { ...batch, items: batch.items.map((item) => ({ ...item, selected })) };
}

export function toggleSelected(batch: ImageBatch, id: string): ImageBatch {
  return { ...batch, items: batch.items.map((item) => item.id === id ? { ...item, selected: !item.selected } : item) };
}

export function removeImage(batch: ImageBatch, id: string): ImageBatch {
  return { ...batch, items: batch.items.filter((item) => item.id !== id) };
}
