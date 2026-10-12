// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TrimPlayer } from "@/features/input/TrimPlayer";
import { exportSettings } from "@/features/export/summary";

const { state } = vi.hoisted(() => ({ state: {} as any }));
vi.mock("@/state/shift", () => ({ useShift: () => state }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));

beforeEach(() => {
  Object.assign(state, {
    duration: 8, clipIn: "00:02.000", clipOut: "00:04.000", clipDurationPreset: 15, clipError: null,
    clipLabel: "00:02.000", clipSeconds: 2, soundEnabled: true, showAspect: true, aspectPreview: null,
    flip: { horizontal: false, vertical: false },
    setClipDurationPreset: vi.fn(), setClipIn: vi.fn(), setClipOut: vi.fn(),
    resizeClipIn: vi.fn(), resizeClipOut: vi.fn(), moveClipRange: vi.fn(),
    playback: {
      info: { path: "/clip.mp4", duration: 8, hasVideo: true, hasAudio: true, proxy: true },
      busy: false, error: null, status: "ready", cancel: vi.fn(), retry: vi.fn(), fallback: vi.fn(), markReady: vi.fn(),
    },
  });
});
afterEach(cleanup);

const player = () => {
  const view = render(<TrimPlayer />);
  const video = view.container.querySelector("video")!;
  fireEvent.loadedMetadata(video);
  return { ...view, video };
};

it("mirrors the Edit preview horizontally", () => {
  state.flip = { horizontal: true, vertical: false };
  expect(player().video.style.transform).toBe("scale(-1, 1)");
});

it("mirrors the Edit preview vertically, and both together", () => {
  state.flip = { horizontal: false, vertical: true };
  const { video, rerender } = player();
  expect(video.style.transform).toBe("scale(1, -1)");
  state.flip = { horizontal: true, vertical: true };
  rerender(<TrimPlayer />);
  expect(video.style.transform).toBe("scale(-1, -1)");
});

it("mirrors a framed Edit preview at the mirrored offset", () => {
  state.flip = { horizontal: true, vertical: false };
  state.aspectPreview = {
    width: 1080, height: 1080, upscales: false, mode: "fill",
    content: { canvasWidth: 1080, canvasHeight: 1080, frameWidth: 1920, frameHeight: 1080, offsetX: 0, offsetY: 0 },
  };
  class RO { constructor(private cb: ResizeObserverCallback) {} observe() { this.cb([{ contentRect: { width: 540, height: 540 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} }
  vi.stubGlobal("ResizeObserver", RO);
  const { video } = player();
  vi.unstubAllGlobals();
  // A crop at the source's left edge shows the mirrored left edge, on the right.
  expect(parseFloat(video.style.left)).toBeCloseTo((1080 - 0 - 1920) / 1080 * 100, 3);
  expect(video.style.transform).toBe("scale(-1, 1)");
});

it("never mirrors the controls, timeline, timecode or labels", () => {
  state.flip = { horizontal: true, vertical: true };
  const { container, video } = player();
  const mirrored = [...container.querySelectorAll<HTMLElement>("*")].filter((el) => el.style.transform.includes("scale("));
  expect(mirrored).toEqual([video]);
  expect(screen.getByLabelText("Seek playback").style.transform).toBe("");
  expect(screen.getByText("Preview copy · original used for export").style.transform).toBe("");
});

it("does not mirror the preview when the output is audio", () => {
  state.flip = { horizontal: true, vertical: false };
  state.showAspect = false;
  expect(player().video.style.transform).toBe("");
});

// ------------------------------------------------------------- summary

const summary = (flip: { horizontal: boolean; vertical: boolean }, showAspect = true) =>
  exportSettings({
    clipEnabled: false, isImage: false, showAspect, isLoop: false, sourceMoves: true, format: "MP4",
    soundEnabled: true, compression: "none", compressionChoices: [],
    aspect: { ratio: "original", frame: "fill", width: null, height: null, crop: null },
    flip, localMedia: null, playback: { info: null },
  } as any).find((row) => row.label === "Flip")?.value;

it("lists the flip in the export summary only when one is on", () => {
  expect(summary({ horizontal: true, vertical: false })).toBe("Horizontal");
  expect(summary({ horizontal: false, vertical: true })).toBe("Vertical");
  expect(summary({ horizontal: true, vertical: true })).toBe("Horizontal + Vertical");
  expect(summary({ horizontal: false, vertical: false })).toBeUndefined();
  // Audio exports carry no flip, so they do not claim one.
  expect(summary({ horizontal: true, vertical: false }, false)).toBeUndefined();
});
