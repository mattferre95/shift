// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "@/app/App";
import { Sidebar } from "@/components/Sidebar";
import { ShiftProvider, useShift } from "@/state/shift";
import { ViewProvider, useView } from "@/state/view";
import * as ipc from "@/lib/ipc";
import type { JobEvent, LocalMedia, UrlMedia } from "@/types";

vi.mock("@/state/playback", () => ({ usePlayback: () => ({ info: null, busy: false, error: null, status: null, timings: {}, cancel: vi.fn() }) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/components/BuildInfo", () => ({ BuildInfo: () => null }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => "/tmp/out.mp4"), open: vi.fn(async () => null) }));
vi.mock("@/lib/ipc", () => ({
  defaultOutputDir: vi.fn(async () => "/tmp"),
  health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })),
  onJobEvent: vi.fn(async () => () => {}),
  analyzeFile: vi.fn(), analyzeUrl: vi.fn(),
  previewSource: vi.fn(async () => "data:image/png;base64,preview"),
  aspectPreview: vi.fn(async () => null),
  validateClip: vi.fn(async () => ({ seconds: 5, label: "00:05.000" })),
  releaseUrlMedia: vi.fn(async () => {}),
  savePrompt: vi.fn(async () => ({ directory: "/tmp", filename: "out.mp4" })),
  setOutputDir: vi.fn(async () => "/tmp"),
  startExport: vi.fn(async () => "job-1"),
  cancelJob: vi.fn(async () => true),
  toShiftError: (error: Error) => ({ code: "test", message: error.message, hint: null, technical: null }),
}));

const local = (path: string): LocalMedia => ({
  kind: "video", path, name: path.split("/").at(-1)!, ext: "MP4", sizeBytes: 100,
  duration: 60, width: 1920, height: 1080, hasVideo: true, hasAudio: true,
  outputs: ["MP4", "GIF"], hasAlpha: false,
});
const url = (items = 1): UrlMedia => ({
  provider: "test", url: "https://example.com/post", title: "Post", author: "Author",
  platform: "Example", domain: "example.com",
  mediaItems: Array.from({ length: items }, (_, index) => ({
    id: `item-${index}`, type: "image" as const, source: `https://example.com/${index}.jpg`,
    filenameHint: `image-${index}.jpg`, thumbnailPath: `/tmp/thumb-${index}.jpg`,
    width: 1200, height: 800, duration: null, qualities: [],
  })),
});
const wrapper = ({ children }: { children: React.ReactNode }) => <ShiftProvider><ViewProvider>{children}</ViewProvider></ShiftProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.defaultOutputDir).mockResolvedValue("/tmp");
  vi.mocked(ipc.health).mockResolvedValue({ ffmpeg: true, ffprobe: true, ytdlp: true });
  vi.mocked(ipc.onJobEvent).mockResolvedValue(() => {});
  vi.mocked(ipc.previewSource).mockResolvedValue("data:image/png;base64,preview");
  vi.mocked(ipc.aspectPreview).mockResolvedValue(null);
  vi.mocked(ipc.releaseUrlMedia).mockResolvedValue();
  vi.mocked(ipc.cancelJob).mockResolvedValue(true);
  vi.mocked(ipc.startExport).mockResolvedValue("job-1");
});
afterEach(cleanup);

it("sidebar New Shift clears a local source, trim, framing, and returns navigation to Download", async () => {
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => local(path));
  let shift!: ReturnType<typeof useShift>;
  let view!: ReturnType<typeof useView>;
  const Probe = () => { shift = useShift(); view = useView(); return null; };
  render(<ShiftProvider><ViewProvider><Probe /><Sidebar /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/first.mp4"]));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/tmp/first.mp4"));
  act(() => {
    view.setView("resize");
    shift.setAspectRatio("9:16");
    shift.setCropRect({ x: 700, y: 100, width: 600, height: 1066 });
    shift.setClipIn("00:05.000");
    shift.setClipOut("00:10.000");
    shift.toggleClip();
    shift.setFormat("GIF");
  });
  expect(view.view).toBe("resize");
  expect(shift.aspect.crop?.x).toBe(700);
  fireEvent.click(screen.getByRole("button", { name: "New Shift" }));
  await waitFor(() => expect(view.view).toBe("download"));
  expect(shift).toMatchObject({
    screen: "empty", localMedia: null, urlMedia: null, previewSource: null,
    clipEnabled: false, clipIn: "00:00.000", clipOut: "00:15.000", clipDurationPreset: 15,
    aspect: { ratio: "original", frame: "fill", width: null, height: null, crop: null },
    format: "MP4", job: null, output: null, error: null,
  });
  act(() => shift.acceptPaths(["/tmp/second.mp4"]));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/tmp/second.mp4"));
  expect(shift.aspect.crop).toBeNull();
  expect(view.view).toBe("download");
});

it("clears URL metadata, thumbnails, social selections, and source choices", async () => {
  vi.mocked(ipc.analyzeUrl).mockResolvedValue(url(2));
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.submitUrl("https://example.com/post"));
  await waitFor(() => expect(result.current.urlMedia?.mediaItems).toHaveLength(2));
  act(() => {
    result.current.clearPostMedia();
    result.current.selectPostMedia(1);
    result.current.setAspectRatio("freeform");
    result.current.setAspectSize("width", 400);
    result.current.setFrameMode("fit");
  });
  act(() => result.current.reset());
  expect(result.current).toMatchObject({
    screen: "empty", urlMedia: null, localMedia: null, activeMediaIndex: 0,
    selectedMediaIds: [], lastInput: null, quality: "best", previewSource: null,
    aspect: { ratio: "original", frame: "fill", width: null, height: null, crop: null },
  });
  expect(ipc.releaseUrlMedia).toHaveBeenCalledWith(["/tmp/thumb-0.jpg", "/tmp/thumb-1.jpg"]);
});

it("clears a failed input and ignores analysis that finishes after New Shift", async () => {
  let resolve!: (media: LocalMedia) => void;
  vi.mocked(ipc.analyzeFile).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/late.mp4"]));
  expect(result.current.analyzing).toBe(true);
  act(() => result.current.reset());
  await act(async () => resolve(local("/tmp/late.mp4")));
  expect(result.current.screen).toBe("empty");
  expect(result.current.localMedia).toBeNull();

  vi.mocked(ipc.analyzeFile).mockRejectedValueOnce(new Error("bad file"));
  act(() => result.current.acceptPaths(["/tmp/bad.mp4"]));
  await waitFor(() => expect(result.current.screen).toBe("error"));
  act(() => result.current.reset());
  expect(result.current.error).toBeNull();
  expect(result.current.lastInput).toBeNull();
});

it("cancels an active export, ignores late job events, and clears completed results", async () => {
  vi.mocked(ipc.analyzeFile).mockResolvedValue(local("/tmp/first.mp4"));
  vi.mocked(ipc.startExport).mockResolvedValueOnce("job-1").mockResolvedValueOnce("job-2");
  let event!: (value: JobEvent) => void;
  vi.mocked(ipc.onJobEvent).mockImplementation(async (handler) => { event = handler; return () => {}; });
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/first.mp4"]));
  await waitFor(() => expect(result.current.localMedia).not.toBeNull());
  act(() => result.current.startExport());
  await waitFor(() => expect(ipc.startExport).toHaveBeenCalled());
  await waitFor(() => expect(result.current.saving).toBe(false));
  act(() => event({ jobId: "job-1", state: "processing", stageLabel: "Exporting", stageIndex: 0, stageCount: 1, progress: 0.2, outputFilename: "out.mp4", output: null, error: null, actions: [] }));
  act(() => result.current.reset());
  expect(ipc.cancelJob).toHaveBeenCalledWith("job-1");
  expect(result.current.screen).toBe("empty");
  const output = { path: "/tmp/out.mp4", filename: "out.mp4", sizeBytes: 10, sourceBytes: 100, remuxed: false, directory: "/tmp" };
  act(() => event({ jobId: "job-1", state: "completed", stageLabel: "Done", stageIndex: 0, stageCount: 1, progress: 1, outputFilename: "out.mp4", output, error: null, actions: [] }));
  expect(result.current.screen).toBe("empty");

  act(() => result.current.acceptPaths(["/tmp/first.mp4"]));
  await waitFor(() => expect(result.current.screen).toBe("local"));
  act(() => result.current.startExport());
  await waitFor(() => expect(result.current.saving).toBe(false));
  act(() => event({ jobId: "job-2", state: "completed", stageLabel: "Done", stageIndex: 0, stageCount: 1, progress: 1, outputFilename: "out.mp4", output, error: null, actions: [] }));
  expect(result.current.screen).toBe("complete");
  act(() => result.current.reset());
  expect(result.current.output).toBeNull();
});

it("Command+N uses the same reset, skips IME composition, and is stable on empty input", async () => {
  vi.mocked(ipc.analyzeUrl).mockResolvedValue(url());
  render(<App />);
  const field = screen.getByRole("textbox", { name: /Media link/ });
  fireEvent.change(field, { target: { value: "https://example.com/post" } });
  fireEvent.click(screen.getByRole("button", { name: "New Shift" }));
  expect(screen.getByRole("textbox", { name: /Media link/ })).toHaveProperty("value", "https://example.com/post");
  expect(document.activeElement).toBe(field);
  fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
  await waitFor(() => expect(screen.queryByText("Anything in. Anything out.")).toBeNull());
  fireEvent.keyDown(window, { key: "n", metaKey: true, isComposing: true });
  expect(screen.queryByText("Anything in. Anything out.")).toBeNull();
  fireEvent.keyDown(window, { key: "n", metaKey: true });
  expect(await screen.findByText("Anything in. Anything out.")).toBeTruthy();
});
