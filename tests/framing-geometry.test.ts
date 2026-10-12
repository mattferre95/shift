import { describe, expect, it } from "vitest";
import { cropForSource, cropFromContent, evenCrop, mediaBox, moveCrop, resizeCrop } from "@/features/resize/framing";

const source = { w: 1920, h: 1080 };

describe("source-space framing", () => {
  it("uses the Rust centered 16:9 crop as the initial frame", () => {
    const rect = cropFromContent(source, {
      canvasWidth: 1920, canvasHeight: 1080,
      frameWidth: 1920, frameHeight: 1080, offsetX: 0, offsetY: 0,
    });
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    const square = cropFromContent(source, {
      canvasWidth: 1080, canvasHeight: 1080,
      frameWidth: 1920, frameHeight: 1080, offsetX: -420, offsetY: 0,
    });
    expect(square).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
  });

  it("moves without resizing and stays inside the source", () => {
    const rect = { x: 320, y: 180, width: 1280, height: 720 };
    expect(moveCrop(rect, 100, -90, source)).toEqual({ ...rect, x: 420, y: 90 });
    expect(moveCrop(rect, 9000, -9000, source)).toEqual({ ...rect, x: 640, y: 0 });
  });

  it("keeps 16:9 and 9:16 while corner resizing", () => {
    const wide = resizeCrop({ x: 320, y: 180, width: 1280, height: 720 }, "se", -300, -100, source, 16 / 9);
    const tall = resizeCrop({ x: 700, y: 60, width: 450, height: 800 }, "nw", 100, 100, source, 9 / 16);
    expect(Math.abs(wide.width / wide.height - 16 / 9)).toBeLessThan(0.004);
    expect(Math.abs(tall.width / tall.height - 9 / 16)).toBeLessThan(0.004);
    expect(wide.width).toBeGreaterThanOrEqual(16);
    expect(tall.height).toBeGreaterThanOrEqual(16);
  });

  it("keeps a minimum size and cannot invert a crop", () => {
    const resized = resizeCrop({ x: 100, y: 100, width: 400, height: 300 }, "nw", 9999, 9999, source, null);
    expect(resized.width).toBe(16);
    expect(resized.height).toBe(16);
    expect(resized.x).toBe(484);
    expect(resized.y).toBe(384);
  });

  it("allows unlocked Freeform edges to change axes independently", () => {
    const rect = { x: 100, y: 100, width: 400, height: 300 };
    expect(resizeCrop(rect, "e", 100, 0, source, null)).toEqual({ ...rect, width: 500 });
    expect(resizeCrop(rect, "s", 0, 50, source, null)).toEqual({ ...rect, height: 350 });
  });

  it("locks Freeform to its current ratio and keeps even source pixels", () => {
    const rect = { x: 100, y: 100, width: 400, height: 300 };
    const result = evenCrop(resizeCrop(rect, "e", 100, 0, source, 4 / 3), source);
    expect(Math.abs(result.width / result.height - 4 / 3)).toBeLessThan(0.01);
    expect([result.x, result.y, result.width, result.height].every((v) => v % 2 === 0)).toBe(true);
  });

  it("maps pointer movement against the media, not the letterboxed panel", () => {
    const box = mediaBox({ w: 600, h: 500 }, source);
    expect(box.width).toBe(544);
    expect(box.height).toBe(306);
    expect(box.left).toBe(28);
    expect(box.top).toBe(97);
    const sourceMove = 54.4 / (box.width / source.w);
    expect(Math.round(sourceMove)).toBe(192);
  });

  it("rebases a crop when preview quality changes", () => {
    expect(cropForSource({ x: 160, y: 90, width: 640, height: 360, sourceWidth: 960, sourceHeight: 540 }, source))
      .toEqual({ x: 320, y: 180, width: 1280, height: 720 });
  });

  it("keeps resized frames inside the source at extreme pointer positions", () => {
    const initial = { x: 320, y: 180, width: 1280, height: 720 };
    for (const handle of ["nw", "ne", "sw", "se"] as const) {
      for (const [dx, dy] of [[-10000, -10000], [10000, 10000], [-10000, 10000], [10000, -10000]]) {
        const frame = evenCrop(resizeCrop(initial, handle, dx, dy, source, 16 / 9), source);
        expect(frame.x).toBeGreaterThanOrEqual(0);
        expect(frame.y).toBeGreaterThanOrEqual(0);
        expect(frame.x + frame.width).toBeLessThanOrEqual(source.w);
        expect(frame.y + frame.height).toBeLessThanOrEqual(source.h);
        expect(frame.width).toBeGreaterThanOrEqual(16);
        expect(frame.height).toBeGreaterThanOrEqual(16);
      }
    }
  });

  it("rounds preset handles within the native ratio tolerance", () => {
    for (const [rw, rh] of [[16, 9], [9, 16], [1, 1], [4, 5], [4, 3]]) {
      const rect = { x: 500, y: 200, width: rw * 40, height: rh * 40 };
      for (const distance of [-2000, -500, -25, 0, 35, 500, 2000]) {
        const next = evenCrop(resizeCrop(rect, "se", distance, distance, source, rw / rh), source);
        expect(Math.abs(next.width * rh - next.height * rw)).toBeLessThanOrEqual(Math.max(rw, rh) * 2);
      }
    }
  });
});
