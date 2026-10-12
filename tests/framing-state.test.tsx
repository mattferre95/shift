// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShiftProvider, useShift } from "@/state/shift";
import { ResizeView } from "@/features/resize/ResizeView";
import * as ipc from "@/lib/ipc";
import type { LocalMedia } from "@/types";

vi.mock("@/state/playback", () => ({ usePlayback: () => ({ info: null }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => null) }));
vi.mock("@/lib/ipc", () => ({
  defaultOutputDir: vi.fn(async () => "/tmp"),
  health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })),
  onJobEvent: vi.fn(async () => () => {}),
  analyzeFile: vi.fn(),
  previewSource: vi.fn(async () => "data:image/png;base64,preview"),
  aspectPreview: vi.fn(async () => null),
  savePrompt: vi.fn(async () => ({ directory: "/tmp", filename: "frame.jpg" })),
  releaseUrlMedia: vi.fn(async () => {}),
  toShiftError: (error: Error) => ({ code: "test", message: error.message, hint: null, technical: null }),
}));

const image = (path: string): LocalMedia => ({
  kind: "image", path, name: "source.jpg", ext: "JPG", sizeBytes: 100,
  duration: null, width: 1920, height: 1080, hasVideo: false, hasAudio: false,
  outputs: ["JPG", "PNG", "WEBP"], hasAlpha: false,
});
const wrapper = ({ children }: { children: React.ReactNode }) => <ShiftProvider>{children}</ShiftProvider>;

beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps typed Freeform dimensions and direct framing synchronized through export", async () => {
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => image(path));
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/source.jpg"]));
  await waitFor(() => expect(result.current.localMedia?.width).toBe(1920));
  act(() => result.current.setAspectRatio("freeform"));
  act(() => result.current.setAspectSize("width", 640));
  expect(result.current.aspect.height).toBe(360);
  expect(result.current.aspect.crop).toMatchObject({ x: 640, y: 360, width: 640, height: 360, sourceWidth: 1920, sourceHeight: 1080 });

  act(() => result.current.toggleAspectLock());
  act(() => result.current.setAspectSize("height", 300));
  expect(result.current.aspect.width).toBe(640);
  expect(result.current.aspect.crop).toMatchObject({ x: 640, y: 390, width: 640, height: 300 });

  act(() => result.current.setCropRect({ x: 300, y: 200, width: 320, height: 200 }));
  expect([result.current.aspect.width, result.current.aspect.height]).toEqual([320, 200]);
  act(() => result.current.startExport());
  await waitFor(() => expect(ipc.savePrompt).toHaveBeenCalled());
  expect(vi.mocked(ipc.savePrompt).mock.calls.at(-1)?.[0].aspect?.crop).toMatchObject({ x: 300, y: 200, width: 320, height: 200, sourceWidth: 1920, sourceHeight: 1080 });
});

it("Fit retains the frame for Fill, while Original and a new source clear it", async () => {
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => image(path));
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/first.jpg"]));
  await waitFor(() => expect(result.current.localMedia?.path).toBe("/tmp/first.jpg"));
  act(() => result.current.setAspectRatio("1:1"));
  act(() => result.current.setCropRect({ x: 500, y: 100, width: 800, height: 800 }));
  act(() => result.current.setFrameMode("fit"));
  expect(result.current.aspect.crop?.x).toBe(500);
  act(() => result.current.setFrameMode("fill"));
  expect(result.current.aspect.crop?.x).toBe(500);
  act(() => result.current.setAspectRatio("original"));
  expect(result.current.aspect.crop).toBeNull();
  act(() => result.current.setAspectRatio("1:1"));
  act(() => result.current.setCropRect({ x: 500, y: 100, width: 800, height: 800 }));
  act(() => result.current.acceptPaths(["/tmp/second.jpg"]));
  await waitFor(() => expect(result.current.localMedia?.path).toBe("/tmp/second.jpg"));
  expect(result.current.aspect).toEqual({ ratio: "original", frame: "fill", width: null, height: null, crop: null });
});

it("only shows draggable handles after Fill is measured", async () => {
  class TestResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe() {
      this.callback([{ contentRect: { width: 600, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => image(path));
  vi.mocked(ipc.aspectPreview).mockImplementation(async (_w, _h, spec) => ({
    width: 1080, height: 1080, upscales: false, mode: spec.frame,
    content: { canvasWidth: 1080, canvasHeight: 1080, frameWidth: 1920, frameHeight: 1080, offsetX: -420, offsetY: 0 },
  }));
  let shift!: ReturnType<typeof useShift>;
  const Probe = () => { shift = useShift(); return null; };
  render(<ShiftProvider><Probe /><ResizeView /></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/source.jpg"]));
  await waitFor(() => expect(shift.localMedia?.width).toBe(1920));
  act(() => shift.setAspectRatio("1:1"));
  const frame = await screen.findByLabelText("Crop frame");
  const capture = vi.fn();
  Object.defineProperty(frame, "setPointerCapture", { value: capture });
  Object.defineProperty(frame, "hasPointerCapture", { value: () => false });
  fireEvent.pointerDown(frame, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(frame, { pointerId: 1, clientX: 128, clientY: 100 });
  expect(capture).toHaveBeenCalledWith(1);
  expect(shift.aspect.crop?.x).toBeGreaterThan(420);
  const beforeResize = shift.aspect.crop!.width;
  fireEvent.pointerDown(screen.getByLabelText("Resize se"), { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(frame, { pointerId: 2, clientX: 82, clientY: 82 });
  expect(shift.aspect.crop?.width).not.toBe(beforeResize);
  act(() => shift.setFrameMode("fit"));
  await waitFor(() => expect(screen.queryByLabelText("Crop frame")).toBeNull());
  act(() => shift.setFrameMode("fill"));
  expect(await screen.findByLabelText("Crop frame")).toBeTruthy();
  act(() => shift.setAspectRatio("original"));
  await waitFor(() => expect(screen.queryByLabelText("Crop frame")).toBeNull());
  act(() => shift.setAspectRatio("9:16"));
  expect(await screen.findByLabelText("Crop frame")).toBeTruthy();
  act(() => shift.setCropRect({ x: 700, y: 100, width: 600, height: 1066 }));
  act(() => shift.reset());
  act(() => shift.acceptPaths(["/tmp/second.jpg"]));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/tmp/second.jpg"));
  expect(shift.aspect).toEqual({ ratio: "original", frame: "fill", width: null, height: null, crop: null });
});
