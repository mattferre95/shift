// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";
import { ShiftProvider, useShift } from "@/state/shift";
import { ViewProvider } from "@/state/view";
import { ResizeView } from "@/features/resize/ResizeView";
import * as ipc from "@/lib/ipc";
import type { LocalMedia } from "@/types";

vi.mock("@/state/playback", () => ({ usePlayback: () => ({ info: null, busy: false, error: null, status: null, timings: {}, cancel: vi.fn() }) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/components/BuildInfo", () => ({ BuildInfo: () => null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => null) }));
vi.mock("@/lib/ipc", () => ({
  defaultOutputDir: vi.fn(async () => "/tmp"),
  health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })),
  onJobEvent: vi.fn(async () => () => {}),
  analyzeFile: vi.fn(),
  previewSource: vi.fn(async () => "data:image/png;base64,preview"),
  aspectPreview: vi.fn(async () => null),
  savePrompt: vi.fn(async () => ({ directory: "/tmp", filename: "source_916.mp4" })),
  releaseUrlMedia: vi.fn(async () => {}),
  cancelJob: vi.fn(async () => true),
  toShiftError: (error: Error) => ({ code: "test", message: error.message, hint: null, technical: null }),
}));

const video = (path: string): LocalMedia => ({
  kind: "video", path, name: path.split("/").at(-1)!, ext: "MP4", sizeBytes: 100,
  duration: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: true,
  outputs: ["MP4", "GIF", "MP3"], hasAlpha: false,
});
const wrapper = ({ children }: { children: React.ReactNode }) => <ShiftProvider>{children}</ShiftProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => video(path));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("starts unflipped and toggles each axis independently, beside the aspect", async () => {
  const { result } = renderHook(() => useShift(), { wrapper });
  expect(result.current.flip).toEqual({ horizontal: false, vertical: false });
  act(() => result.current.acceptPaths(["/tmp/a.mp4"]));
  await waitFor(() => expect(result.current.localMedia?.path).toBe("/tmp/a.mp4"));
  act(() => result.current.setAspectRatio("9:16"));
  act(() => result.current.setCropRect({ x: 0, y: 0, width: 606, height: 1078 }));
  act(() => result.current.toggleFlip("horizontal"));
  expect(result.current.flip).toEqual({ horizontal: true, vertical: false });
  act(() => result.current.toggleFlip("vertical"));
  expect(result.current.flip).toEqual({ horizontal: true, vertical: true });
  act(() => result.current.toggleFlip("horizontal"));
  expect(result.current.flip).toEqual({ horizontal: false, vertical: true });
  // Neither the ratio nor the crop carries the mirror.
  expect(result.current.aspect.ratio).toBe("9:16");
  expect(result.current.aspect.crop).toMatchObject({ x: 0, y: 0, width: 606, height: 1078 });
  expect(result.current.aspect).not.toHaveProperty("flip");
  // Changing ratio or scaling keeps the mirror.
  act(() => result.current.setFrameMode("fit"));
  act(() => result.current.setAspectRatio("original"));
  expect(result.current.flip).toEqual({ horizontal: false, vertical: true });
});

it("joins the flip to the exported aspect without touching sound, trim or the crop", async () => {
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/a.mp4"]));
  await waitFor(() => expect(result.current.localMedia?.path).toBe("/tmp/a.mp4"));
  act(() => result.current.toggleFlip("horizontal"));
  act(() => result.current.startExport());
  await waitFor(() => expect(ipc.savePrompt).toHaveBeenCalledTimes(1));
  const original = vi.mocked(ipc.savePrompt).mock.calls[0][0];
  // Original + flip is a valid request.
  expect(original.aspect).toMatchObject({ ratio: "original", crop: null, flip: { horizontal: true, vertical: false } });
  expect(original.soundEnabled).toBe(true);
  expect(original.clip).toBeNull();

  act(() => result.current.setAspectRatio("9:16"));
  act(() => result.current.setCropRect({ x: 0, y: 0, width: 606, height: 1078 }));
  act(() => result.current.toggleFlip("vertical"));
  act(() => result.current.startExport());
  await waitFor(() => expect(ipc.savePrompt).toHaveBeenCalledTimes(2));
  const framed = vi.mocked(ipc.savePrompt).mock.calls[1][0];
  // The crop goes out in unflipped source pixels; the mirror rides beside it.
  expect(framed.aspect?.crop).toMatchObject({ x: 0, y: 0, width: 606, height: 1078, sourceWidth: 1920, sourceHeight: 1080 });
  expect(framed.aspect?.flip).toEqual({ horizontal: true, vertical: true });

  // Audio has no shape, so it carries no aspect and no mirror.
  act(() => result.current.setFormat("MP3"));
  act(() => result.current.startExport());
  await waitFor(() => expect(ipc.savePrompt).toHaveBeenCalledTimes(3));
  expect(vi.mocked(ipc.savePrompt).mock.calls[2][0].aspect).toBeNull();
});

it("New Shift clears both flips and the next source starts unflipped", async () => {
  let shift!: ReturnType<typeof useShift>;
  const Probe = () => { shift = useShift(); return null; };
  render(<ShiftProvider><ViewProvider><Probe /><Sidebar /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/a.mp4"]));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/tmp/a.mp4"));
  act(() => { shift.toggleFlip("horizontal"); shift.toggleFlip("vertical"); });
  expect(shift.flip).toEqual({ horizontal: true, vertical: true });
  fireEvent.click(screen.getByRole("button", { name: "New Shift" }));
  await waitFor(() => expect(shift.localMedia).toBeNull());
  expect(shift.flip).toEqual({ horizontal: false, vertical: false });
  act(() => shift.acceptPaths(["/tmp/b.mp4"]));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/tmp/b.mp4"));
  expect(shift.flip).toEqual({ horizontal: false, vertical: false });
});

it("a new source never inherits the previous source's flip", async () => {
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/a.mp4"]));
  await waitFor(() => expect(result.current.localMedia?.path).toBe("/tmp/a.mp4"));
  act(() => result.current.toggleFlip("horizontal"));
  act(() => result.current.acceptPaths(["/tmp/b.mp4"]));
  await waitFor(() => expect(result.current.localMedia?.path).toBe("/tmp/b.mp4"));
  expect(result.current.flip).toEqual({ horizontal: false, vertical: false });
});

it("mirrors only the media in the stage, and drags the frame in screen space", async () => {
  class TestResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe() {
      this.callback([{ contentRect: { width: 600, height: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.mocked(ipc.aspectPreview).mockImplementation(async (_w, _h, spec) => ({
    width: 1080, height: 1080, upscales: false, mode: spec.frame,
    content: { canvasWidth: 1080, canvasHeight: 1080, frameWidth: 1920, frameHeight: 1080, offsetX: -420, offsetY: 0 },
  }));
  let shift!: ReturnType<typeof useShift>;
  const Probe = () => { shift = useShift(); return null; };
  render(<ShiftProvider><Probe /><ResizeView /></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/a.mp4"]));
  await waitFor(() => expect(shift.localMedia?.width).toBe(1920));

  const hButton = screen.getByRole("button", { name: "Flip horizontally" });
  const vButton = screen.getByRole("button", { name: "Flip vertically" });
  expect(hButton.getAttribute("aria-pressed")).toBe("false");
  expect(hButton.getAttribute("title")).toBe("Flip horizontally");
  expect(vButton.getAttribute("title")).toBe("Flip vertically");

  act(() => shift.setAspectRatio("1:1"));
  const frame = await screen.findByLabelText("Crop frame");
  act(() => shift.setCropRect({ x: 0, y: 0, width: 1080, height: 1080 }));
  fireEvent.click(hButton);
  expect(hButton.getAttribute("aria-pressed")).toBe("true");
  expect(vButton.getAttribute("aria-pressed")).toBe("false");

  // The stage is 600x500, so the media box is 544 wide at 0.2833 px per source px.
  const scale = 544 / 1920;
  // The left-of-source crop is drawn on the right of the mirrored picture.
  expect(parseFloat(frame.style.left)).toBeCloseTo((1920 - 1080) * scale, 3);
  // Only the pictures are mirrored; the frame, handles and label are not.
  const pictures = document.querySelectorAll<HTMLImageElement>('[aria-label="Framing preview"] img');
  expect(pictures.length).toBeGreaterThan(0);
  pictures.forEach((img) => expect(img.style.transform).toBe("scale(-1, 1)"));
  expect(frame.style.transform).toBe("");
  screen.getAllByLabelText(/^Resize /).forEach((handle) => expect(handle.style.transform).toBe("translate(-50%, -50%)"));
  expect(screen.getByText("1:1 · Fill").style.transform).toBe("");

  // Drag the frame 28.33 screen px left: on screen it follows the pointer,
  // so in the source it moves 100 px right.
  Object.defineProperty(frame, "setPointerCapture", { value: vi.fn() });
  Object.defineProperty(frame, "hasPointerCapture", { value: () => false });
  fireEvent.pointerDown(frame, { button: 0, pointerId: 1, clientX: 300, clientY: 100 });
  fireEvent.pointerMove(frame, { pointerId: 1, clientX: 300 - 100 * scale, clientY: 100 });
  fireEvent.pointerUp(frame, { pointerId: 1 });
  expect(shift.aspect.crop).toMatchObject({ x: 100, y: 0, width: 1080, height: 1080 });
  expect(parseFloat(frame.style.left)).toBeCloseTo((1920 - 1080 - 100) * scale, 3);

  fireEvent.click(vButton);
  expect(vButton.getAttribute("aria-pressed")).toBe("true");
  document.querySelectorAll<HTMLImageElement>('[aria-label="Framing preview"] img')
    .forEach((img) => expect(img.style.transform).toBe("scale(-1, -1)"));
  // The stored crop did not move when the mirror changed.
  expect(shift.aspect.crop).toMatchObject({ x: 100, y: 0 });
});
