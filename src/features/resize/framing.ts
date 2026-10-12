import type { ContentBox, CropRect, Flip } from "@/types";

export type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
export const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));

/** The source's actual rendered box, excluding letterboxing in the stage. */
export function mediaBox(stage: { w: number; h: number }, source: { w: number; h: number }, pad = 28) {
  const scale = Math.min((stage.w - pad * 2) / source.w, (stage.h - pad * 2) / source.h);
  const width = source.w * scale;
  const height = source.h * scale;
  return { left: (stage.w - width) / 2, top: (stage.h - height) / 2, width, height };
}

/** Convert Rust's authoritative ContentBox into a source-space crop. */
export function cropFromContent(source: { w: number; h: number }, content: ContentBox): CropRect {
  const sx = source.w / content.frameWidth;
  const sy = source.h / content.frameHeight;
  const width = clamp(Math.round(content.canvasWidth * sx), 16, source.w);
  const height = clamp(Math.round(content.canvasHeight * sy), 16, source.h);
  return {
    x: clamp(Math.round(-content.offsetX * sx), 0, source.w - width),
    y: clamp(Math.round(-content.offsetY * sy), 0, source.h - height),
    width, height,
  };
}

export function moveCrop(rect: CropRect, dx: number, dy: number, source: { w: number; h: number }): CropRect {
  return {
    ...rect,
    x: clamp(Math.round(rect.x + dx), 0, source.w - rect.width),
    y: clamp(Math.round(rect.y + dy), 0, source.h - rect.height),
  };
}

/** Keep dragged geometry compatible with even-pixel video encoders. */
export function evenCrop(rect: CropRect, source: { w: number; h: number }): CropRect {
  const width = Math.max(16, Math.min(source.w - source.w % 2, Math.round(rect.width / 2) * 2));
  const height = Math.max(16, Math.min(source.h - source.h % 2, Math.round(rect.height / 2) * 2));
  return {
    x: clamp(Math.round(rect.x / 2) * 2, 0, (source.w - width) - (source.w - width) % 2),
    y: clamp(Math.round(rect.y / 2) * 2, 0, (source.h - height) - (source.h - height) % 2),
    width, height,
  };
}

/** Rebase an existing frame when a URL preview resolves at another quality. */
export function cropForSource(rect: CropRect, source: { w: number; h: number }): CropRect {
  if (!rect.sourceWidth || !rect.sourceHeight ||
      (rect.sourceWidth === source.w && rect.sourceHeight === source.h)) return rect;
  return evenCrop({
    x: rect.x * source.w / rect.sourceWidth,
    y: rect.y * source.h / rect.sourceHeight,
    width: rect.width * source.w / rect.sourceWidth,
    height: rect.height * source.h / rect.sourceHeight,
  }, source);
}

/** Resize from the opposite corner/edge; ratio is null only for unlocked Freeform. */
export function resizeCrop(
  rect: CropRect, handle: Handle, dx: number, dy: number,
  source: { w: number; h: number }, ratio: number | null,
): CropRect {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  if (ratio == null) {
    const left = west ? clamp(Math.round(rect.x + dx), 0, rect.x + rect.width - 16) : rect.x;
    const right = east ? clamp(Math.round(rect.x + rect.width + dx), rect.x + 16, source.w) : rect.x + rect.width;
    const top = north ? clamp(Math.round(rect.y + dy), 0, rect.y + rect.height - 16) : rect.y;
    const bottom = south ? clamp(Math.round(rect.y + rect.height + dy), rect.y + 16, source.h) : rect.y + rect.height;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  const ax = west ? rect.x + rect.width : east ? rect.x : rect.x + rect.width / 2;
  const ay = north ? rect.y + rect.height : south ? rect.y : rect.y + rect.height / 2;
  const wantedFromX = rect.width + (west ? -dx : east ? dx : 0);
  const wantedFromY = (rect.height + (north ? -dy : south ? dy : 0)) * ratio;
  const wanted = (west || east) && (north || south)
    ? Math.abs(dx / rect.width) >= Math.abs(dy / rect.height) ? wantedFromX : wantedFromY
    : west || east ? wantedFromX : wantedFromY;
  const maxW = Math.min(
    (west ? ax : east ? source.w - ax : 2 * Math.min(ax, source.w - ax)),
    (north ? ay : south ? source.h - ay : 2 * Math.min(ay, source.h - ay)) * ratio,
  );
  const width = clamp(Math.round(wanted), Math.max(16, Math.ceil(16 * ratio)), maxW);
  const height = Math.max(16, Math.round(width / ratio));
  const x = west ? ax - width : east ? ax : ax - width / 2;
  const y = north ? ay - height : south ? ay : ay - height / 2;
  return { x: Math.round(x), y: Math.round(y), width, height };
}

export function centeredCrop(source: { w: number; h: number }, width: number, height: number): CropRect {
  const w = clamp(Math.round(width), 16, source.w);
  const h = clamp(Math.round(height), 16, source.h);
  return { x: Math.round((source.w - w) / 2), y: Math.round((source.h - h) / 2), width: w, height: h };
}

// ------------------------------------------------------------------ mirroring
//
// The crop is always stored in unflipped source pixels, which is what Rust
// crops before it mirrors. The stage draws the media mirrored, so everything
// drawn over it goes through these, and every pointer movement comes back
// through them. Each is its own inverse.

/** A source-space rect as it lands on the mirrored picture, still in source units. */
export function flipRect(rect: CropRect, source: { w: number; h: number }, flip: Flip): CropRect {
  return {
    ...rect,
    x: flip.horizontal ? source.w - rect.x - rect.width : rect.x,
    y: flip.vertical ? source.h - rect.y - rect.height : rect.y,
  };
}

/** A pointer movement over the mirrored picture, as a movement in the source. */
export function sourceDelta(dx: number, dy: number, flip: Flip) {
  return { dx: flip.horizontal ? -dx : dx, dy: flip.vertical ? -dy : dy };
}

/** The handle under the pointer, named as the source edge it really moves. */
export function sourceHandle(handle: Handle, flip: Flip): Handle {
  let h: string = handle;
  if (flip.horizontal) h = h.replace(/[ew]/, (c) => (c === "e" ? "w" : "e"));
  if (flip.vertical) h = h.replace(/[ns]/, (c) => (c === "n" ? "s" : "n"));
  return h as Handle;
}

/** A Rust content box as the mirrored canvas shows it. */
export function flipContent(content: ContentBox, flip: Flip): ContentBox {
  return {
    ...content,
    offsetX: flip.horizontal ? content.canvasWidth - content.offsetX - content.frameWidth : content.offsetX,
    offsetY: flip.vertical ? content.canvasHeight - content.offsetY - content.frameHeight : content.offsetY,
  };
}

/** The CSS mirror for media elements only — never for frames, handles or labels. */
export function flipStyle(flip: Flip): string | undefined {
  if (!flip.horizontal && !flip.vertical) return undefined;
  return `scale(${flip.horizontal ? -1 : 1}, ${flip.vertical ? -1 : 1})`;
}
