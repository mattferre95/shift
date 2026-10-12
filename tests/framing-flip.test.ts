import { describe, expect, it } from "vitest";
import {
  cropForSource, evenCrop, flipContent, flipRect, flipStyle, mediaBox, moveCrop, resizeCrop, sourceDelta, sourceHandle,
} from "@/features/resize/framing";
import { FLIP_NONE, type CropRect, type Flip } from "@/types";

const source = { w: 1920, h: 1080 };
const H: Flip = { horizontal: true, vertical: false };
const V: Flip = { horizontal: false, vertical: true };
const HV: Flip = { horizontal: true, vertical: true };

/** Drag the visual frame the way InteractiveFill does, returning the stored source crop. */
const dragBody = (rect: CropRect, vdx: number, vdy: number, flip: Flip) => {
  const { dx, dy } = sourceDelta(vdx, vdy, flip);
  return evenCrop(moveCrop(rect, dx, dy, source), source);
};

describe("mirrored framing", () => {
  it("starts unflipped and changes nothing while unflipped", () => {
    expect(FLIP_NONE).toEqual({ horizontal: false, vertical: false });
    const rect = { x: 100, y: 60, width: 640, height: 360 };
    expect(flipRect(rect, source, FLIP_NONE)).toEqual(rect);
    expect(sourceDelta(5, -7, FLIP_NONE)).toEqual({ dx: 5, dy: -7 });
    expect(sourceHandle("nw", FLIP_NONE)).toBe("nw");
    expect(flipStyle(FLIP_NONE)).toBeUndefined();
  });

  it("mirrors X for a horizontal flip", () => {
    const rect = { x: 100, y: 60, width: 640, height: 360 };
    expect(flipRect(rect, source, H)).toEqual({ ...rect, x: 1920 - 100 - 640 });
    expect(flipStyle(H)).toBe("scale(-1, 1)");
  });

  it("mirrors Y for a vertical flip", () => {
    const rect = { x: 100, y: 60, width: 640, height: 360 };
    expect(flipRect(rect, source, V)).toEqual({ ...rect, y: 1080 - 60 - 360 });
    expect(flipStyle(V)).toBe("scale(1, -1)");
  });

  it("mirrors both axes together", () => {
    const rect = { x: 100, y: 60, width: 640, height: 360 };
    expect(flipRect(rect, source, HV)).toEqual({ ...rect, x: 1180, y: 660 });
    expect(flipStyle(HV)).toBe("scale(-1, -1)");
    // Its own inverse: drawn twice is the source again.
    expect(flipRect(flipRect(rect, source, HV), source, HV)).toEqual(rect);
  });

  it("never rewrites the stored crop, and rebases it in source pixels", () => {
    const stored = { x: 160, y: 90, width: 640, height: 360, sourceWidth: 960, sourceHeight: 540 };
    const snapshot = { ...stored };
    flipRect(cropForSource(stored, source), source, HV);
    expect(stored).toEqual(snapshot);
    // A higher-quality download keeps the same source region; the mirror is
    // applied to it afterwards, not baked into it.
    const rebased = cropForSource(stored, source);
    expect(rebased).toEqual({ x: 320, y: 180, width: 1280, height: 720 });
    expect(flipRect(rebased, source, H).x).toBe(1920 - 320 - 1280);
  });

  it("moves the source crop left when the mirrored frame is dragged right", () => {
    const rect = { x: 800, y: 200, width: 400, height: 400 };
    const box = mediaBox({ w: 600, h: 500 }, source);
    const visualPixels = 54.4; // 192 source pixels at this stage scale
    const vdx = visualPixels / (box.width / source.w);
    const next = dragBody(rect, vdx, 0, H);
    expect(next.x).toBe(800 - 192);
    expect(next.y).toBe(200);
    // On screen the frame moved right by exactly the pointer distance.
    expect(flipRect(next, source, H).x - flipRect(rect, source, H).x).toBe(192);
  });

  it("moves the source crop up when the mirrored frame is dragged down", () => {
    const rect = { x: 800, y: 200, width: 400, height: 400 };
    const next = dragBody(rect, 0, 100, V);
    expect(next).toEqual({ ...rect, y: 100 });
    expect(flipRect(next, source, V).y - flipRect(rect, source, V).y).toBe(100);
  });

  it("resizes the source edge that sits under the mirrored handle", () => {
    expect(sourceHandle("e", H)).toBe("w");
    expect(sourceHandle("se", H)).toBe("sw");
    expect(sourceHandle("se", V)).toBe("ne");
    expect(sourceHandle("nw", HV)).toBe("se");
    expect(sourceHandle("n", H)).toBe("n");
    const rect = { x: 400, y: 200, width: 800, height: 450 };
    // Drag the on-screen right edge outward by 100: the visual right edge
    // moves right, which is the source's left edge moving left.
    const { dx, dy } = sourceDelta(100, 0, H);
    const next = resizeCrop(rect, sourceHandle("e", H), dx, dy, source, null);
    expect(next).toEqual({ x: 300, y: 200, width: 900, height: 450 });
    const before = flipRect(rect, source, H);
    const after = flipRect(next, source, H);
    expect(after.x).toBe(before.x);
    expect(after.x + after.width).toBe(before.x + before.width + 100);
  });

  it("keeps a preset crop WYSIWYG under a horizontal flip", () => {
    // A subject on the left of the source, framed at 9:16 and then mirrored.
    const crop = { x: 0, y: 0, width: 606, height: 1078 };
    const drawn = flipRect(crop, source, H);
    // Drawn on the right of the mirrored picture, around the mirrored subject.
    expect(drawn.x + drawn.width).toBe(1920);
    // Pull the on-screen bottom-left corner inward; the ratio holds in the source.
    const { dx, dy } = sourceDelta(200, -356, H);
    const resized = evenCrop(resizeCrop(crop, sourceHandle("sw", H), dx, dy, source, 9 / 16), source);
    expect(Math.abs(resized.width * 16 - resized.height * 9)).toBeLessThanOrEqual(32);
    expect(resized.x).toBe(0);
    // The visual left edge followed the pointer inward; the right edge stayed.
    const shown = flipRect(resized, source, H);
    expect(shown.x + shown.width).toBe(1920);
    expect(shown.x).toBeGreaterThan(drawn.x);
  });

  it("keeps a Freeform crop WYSIWYG under both flips", () => {
    const rect = { x: 200, y: 100, width: 600, height: 400 };
    const { dx, dy } = sourceDelta(50, 30, HV);
    const next = evenCrop(resizeCrop(rect, sourceHandle("se", HV), dx, dy, source, null), source);
    // The on-screen bottom-right corner grew out by (50, 30); the opposite
    // on-screen corner did not move.
    const before = flipRect(rect, source, HV);
    const after = flipRect(next, source, HV);
    expect([after.x, after.y]).toEqual([before.x, before.y]);
    expect([after.width, after.height]).toEqual([650, 430]);
    // Stored in the source: the region grew up and to the left.
    expect(next).toEqual({ x: 150, y: 70, width: 650, height: 430 });
  });

  it("places Fit's picture where the mirrored canvas will have it", () => {
    const content = { canvasWidth: 1080, canvasHeight: 1920, frameWidth: 1080, frameHeight: 606, offsetX: 0, offsetY: 657 };
    expect(flipContent(content, V)).toEqual({ ...content, offsetY: 1920 - 657 - 606 });
    expect(flipContent(content, H)).toEqual(content);
    // A Fill crop (negative offsets) mirrors the same way.
    const fill = { canvasWidth: 1080, canvasHeight: 1080, frameWidth: 1920, frameHeight: 1080, offsetX: -100, offsetY: 0 };
    expect(flipContent(fill, H).offsetX).toBe(1080 + 100 - 1920);
  });
});
