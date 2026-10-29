// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendImages, commonFormats, removeImage, selectedImages, setAllSelected, toggleSelected } from "@/state/imageBatch";
import { ShiftProvider, useShift } from "@/state/shift";
import { ImageBatchView } from "@/features/input/ImageBatchView";
import * as ipc from "@/lib/ipc";
import type { ExportRequest, JobEvent, LocalMedia } from "@/types";
import { open, save } from "@tauri-apps/plugin-dialog";

vi.mock("@/state/playback", () => ({ usePlayback: () => ({ info: null, busy: false, error: null, status: null, timings: {}, cancel: vi.fn() }) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null), save: vi.fn(async () => null) }));
vi.mock("@/lib/ipc", () => ({
  defaultOutputDir: vi.fn(async () => "/tmp"),
  health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })),
  onJobEvent: vi.fn(async () => () => {}),
  analyzeFile: vi.fn(),
  importPdf: vi.fn(),
  exportPdf: vi.fn(),
  setOutputDir: vi.fn(async () => "/tmp/exports"),
  startExport: vi.fn(),
  cancelJob: vi.fn(async () => true),
  previewSource: vi.fn(async () => "data:image/png;base64,preview"),
  aspectPreview: vi.fn(async () => null),
  releaseUrlMedia: vi.fn(async () => {}),
  toShiftError: (error: Error) => ({ code: "test", message: error.message, hint: null, technical: null }),
}));

const image = (index: number, outputs: LocalMedia["outputs"] = ["JPG", "PNG", "WEBP"]): LocalMedia => ({
  kind: "image", path: `/tmp/IMG_${index}.HEIC`, name: `IMG_${index}.HEIC`, ext: "HEIC",
  sizeBytes: 1000, duration: null, width: 3024, height: 4032,
  hasVideo: false, hasAudio: false, outputs, hasAlpha: false,
});
const wrapper = ({ children }: { children: React.ReactNode }) => <ShiftProvider>{children}</ShiftProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => image(Number(path.match(/\d+/)?.[0] ?? 0)));
});
afterEach(cleanup);

it.each([2, 10, 50])("keeps %i images ordered with selection and contiguous export positions", (count) => {
  const batch = appendImages(null, Array.from({ length: count }, (_, index) => image(index + 1)), []);
  expect(batch.items.map((item) => item.media.name)).toEqual(Array.from({ length: count }, (_, index) => `IMG_${index + 1}.HEIC`));
  expect(batch.name).toBe("IMG_1");
  expect(selectedImages(batch)).toHaveLength(count);
  const deselected = toggleSelected(batch, batch.items[1].id);
  expect(selectedImages(deselected)).toHaveLength(count - 1);
  if (count > 2) expect(selectedImages(deselected).map((item, index) => [item.media.name, index + 1])[1]).toEqual(["IMG_3.HEIC", 2]);
  const removed = removeImage(deselected, batch.items[0].id);
  expect(selectedImages(removed)[0]?.media.name).toBe(count > 2 ? "IMG_3.HEIC" : undefined);
  expect(selectedImages(setAllSelected(removed, false))).toHaveLength(0);
  expect(selectedImages(setAllSelected(removed, true))).toHaveLength(count - 1);
});

it("appends in picker order and intersects formats across mixed images", () => {
  const first = appendImages(null, [image(2, ["JPG", "PNG"]), image(1, ["JPG", "WEBP"])], []);
  const next = appendImages(first, [image(10, ["JPG"])], []);
  expect(next.items.map((item) => item.media.name)).toEqual(["IMG_2.HEIC", "IMG_1.HEIC", "IMG_10.HEIC"]);
  expect(next.name).toBe(first.name);
  expect(commonFormats(next)).toEqual(["JPG"]);
});

it("routes one file to single source and multiple files to a 50 row scrolling batch", async () => {
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/IMG_1.HEIC"]));
  await waitFor(() => expect(result.current.screen).toBe("local"));
  expect(result.current.batch).toBeNull();
  act(() => result.current.acceptPaths(Array.from({ length: 50 }, (_, index) => `/tmp/IMG_${index + 1}.HEIC`)));
  await waitFor(() => expect(result.current.batch?.items).toHaveLength(50));
  expect(result.current.screen).toBe("batch");
  expect(result.current.selectedBatchCount).toBe(50);
  act(() => result.current.toggleBatchItem(result.current.batch!.items[4].id));
  expect(result.current.selectedBatchCount).toBe(49);
  act(() => result.current.deselectAllBatch());
  expect(result.current.canExport).toBe(false);
  act(() => result.current.selectAllBatch());
  expect(result.current.selectedBatchCount).toBe(50);
  act(() => result.current.reset());
  expect(result.current.batch).toBeNull();
});

it("renders a compact scrollable list and count-driven export action", async () => {
  const Probe = () => { const shift = useShift(); return <><button onClick={() => shift.acceptPaths(Array.from({ length: 50 }, (_, index) => `/tmp/IMG_${index + 1}.HEIC`))}>Load</button><ImageBatchView /></>; };
  render(<ShiftProvider><Probe /></ShiftProvider>);
  screen.getByRole("button", { name: "Load" }).click();
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(50));
  expect(screen.getByRole("list", { name: "Images in batch" }).className).toContain("overflow-y-auto");
  expect(screen.getByRole("button", { name: "Export 50" })).toBeTruthy();
});

it("preserves native picker order and reports incompatible items without discarding valid images", async () => {
  vi.mocked(open).mockResolvedValue(["/tmp/IMG_10.HEIC", "/tmp/movie.mp4", "/tmp/IMG_2.HEIC"]);
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => path.endsWith(".mp4")
    ? { ...image(0), kind: "video", path, name: "movie.mp4" }
    : image(Number(path.match(/\d+/)?.[0] ?? 0)));
  const { result } = renderHook(() => useShift(), { wrapper });
  await act(async () => result.current.openFilePicker());
  await waitFor(() => expect(result.current.batch?.items).toHaveLength(2));
  expect(result.current.batch?.items.map((item) => item.media.name)).toEqual(["IMG_10.HEIC", "IMG_2.HEIC"]);
  expect(result.current.batch?.skipped[0].path).toBe("/tmp/movie.mp4");
});

it("keeps the single source flow when only one image in a mixed drop is compatible", async () => {
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => path.endsWith(".mp4")
    ? { ...image(0), kind: "video", path, name: "movie.mp4" }
    : image(1));
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/movie.mp4", "/tmp/IMG_1.HEIC"]));
  await waitFor(() => expect(result.current.screen).toBe("local"));
  expect(result.current.batch).toBeNull();
  expect(result.current.localMedia?.name).toBe("IMG_1.HEIC");
  expect(result.current.inputWarning).toContain("movie.mp4");
});

it("uses one folder, Rust batch naming contexts and sequential item jobs despite an item failure", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/exports");
  let emit!: (event: JobEvent) => void;
  vi.mocked(ipc.onJobEvent).mockImplementation(async (handler) => { emit = handler; return () => {}; });
  const requests: ExportRequest[] = [];
  vi.mocked(ipc.startExport).mockImplementation(async (request) => {
    requests.push(request);
    const id = `job-${requests.length}`;
    queueMicrotask(() => emit({
      jobId: id, state: requests.length === 2 ? "failed" : "completed",
      stageLabel: "Done", stageIndex: 1, stageCount: 1, progress: 1,
      outputFilename: `photos_${requests.length}.jpg`, actions: [],
      output: requests.length === 2 ? null : { path: `/tmp/exports/photos_${requests.length}.jpg`, filename: `photos_${requests.length}.jpg`, sizeBytes: 50, remuxed: false, sourceBytes: 100, directory: "/tmp/exports" },
      error: requests.length === 2 ? { code: "image_failed", message: "Damaged image", hint: null, technical: null } : null,
    }));
    return id;
  });
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/IMG_1.HEIC", "/tmp/IMG_2.HEIC", "/tmp/IMG_3.HEIC"]));
  await waitFor(() => expect(result.current.batch?.items).toHaveLength(3));
  act(() => result.current.setBatchName("photos"));
  act(() => result.current.startExport());
  await waitFor(() => expect(result.current.screen).toBe("complete"));
  expect(open).toHaveBeenCalledTimes(1);
  expect(requests.map((request) => request.batchNaming)).toEqual([
    { base: "photos", ordinal: 1 }, { base: "photos", ordinal: 2 }, { base: "photos", ordinal: 3 },
  ]);
  expect(requests.every((request) => request.outputDir === "/tmp/exports" && request.format === "JPG" && request.destinationPath === null)).toBe(true);
  expect(result.current.batch?.items.map((item) => item.status)).toEqual(["success", "failed", "success"]);
  expect(result.current.batch?.items[0].output?.filename).toBe("photos_1.jpg");
  act(() => result.current.reset());
  expect(result.current.batch).toBeNull();
  expect(result.current.screen).toBe("empty");
});

it("cancels the active item and keeps completed outputs", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/exports");
  let emit!: (event: JobEvent) => void;
  vi.mocked(ipc.onJobEvent).mockImplementation(async (handler) => { emit = handler; return () => {}; });
  const requests: ExportRequest[] = [];
  const event = (jobId: string, state: JobEvent["state"]): JobEvent => ({
    jobId, state, stageLabel: "Converting", stageIndex: 0, stageCount: 1, progress: null,
    outputFilename: "", actions: [], error: null,
    output: state === "completed" ? { path: "/tmp/exports/one.jpg", filename: "one.jpg", sizeBytes: 50, sourceBytes: 100, directory: "/tmp/exports", remuxed: false } : null,
  });
  vi.mocked(ipc.startExport).mockImplementation(async (request) => {
    requests.push(request);
    const id = `job-${requests.length}`;
    queueMicrotask(() => emit(event(id, requests.length === 1 ? "completed" : "processing")));
    return id;
  });
  vi.mocked(ipc.cancelJob).mockImplementation(async (id) => { queueMicrotask(() => emit(event(id, "cancelled"))); return true; });
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/IMG_1.HEIC", "/tmp/IMG_2.HEIC", "/tmp/IMG_3.HEIC"]));
  await waitFor(() => expect(result.current.batch?.items).toHaveLength(3));
  act(() => result.current.startExport());
  await waitFor(() => expect(requests).toHaveLength(2));
  act(() => result.current.cancel());
  await waitFor(() => expect(result.current.screen).toBe("complete"));
  expect(requests).toHaveLength(2);
  expect(result.current.batch?.items.map((item) => item.status)).toEqual(["success", "cancelled", "cancelled"]);
  expect(result.current.batch?.items[0].output?.filename).toBe("one.jpg");
});


it("opens a PDF as an ordered page batch with image outputs", async () => {
  vi.mocked(ipc.importPdf).mockResolvedValue({ sourceName: "report", pages: [
    { ...image(1, ["JPG", "PNG", "WEBP"]), path: "/tmp/page-0001.png", name: "report - Page 1.png", ext: "PNG" },
    { ...image(2, ["JPG", "PNG", "WEBP"]), path: "/tmp/page-0002.png", name: "report - Page 2.png", ext: "PNG" },
  ] });
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/report.pdf"]));
  await waitFor(() => expect(result.current.screen).toBe("batch"));
  expect(result.current.batch?.pdfSource).toBe("/tmp/report.pdf");
  expect(result.current.batch?.items.map((item) => item.media.name)).toEqual(["report - Page 1.png", "report - Page 2.png"]);
  expect(result.current.format).toBe("PNG");
  expect(result.current.outputs).not.toContain("PDF");
});

it("exports selected images as one PDF in source order", async () => {
  vi.mocked(save).mockResolvedValue("/tmp/exports/photos.pdf");
  vi.mocked(ipc.exportPdf).mockResolvedValue({ path: "/tmp/exports/photos.pdf", filename: "photos.pdf",
    sizeBytes: 500, sourceBytes: 2000, remuxed: false, directory: "/tmp/exports" });
  const { result } = renderHook(() => useShift(), { wrapper });
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => image(Number(path.match(/\d+/)?.[0] ?? 0), ["JPG", "PNG", "PDF"]));
  act(() => result.current.acceptPaths(["/tmp/IMG_1.HEIC", "/tmp/IMG_2.HEIC", "/tmp/IMG_3.HEIC"]));
  await waitFor(() => expect(result.current.batch?.items).toHaveLength(3));
  act(() => result.current.toggleBatchItem(result.current.batch!.items[1].id));
  act(() => result.current.setFormat("PDF"));
  act(() => result.current.startExport());
  await waitFor(() => expect(result.current.screen).toBe("complete"));
  expect(save).toHaveBeenCalledTimes(1);
  expect(ipc.exportPdf).toHaveBeenCalledTimes(1);
  expect(vi.mocked(ipc.exportPdf).mock.calls[0][0]).toEqual(["/tmp/IMG_1.HEIC", "/tmp/IMG_3.HEIC"]);
  expect(ipc.startExport).not.toHaveBeenCalled();
  expect(result.current.output?.filename).toBe("photos.pdf");
});

it("exports one local image as a one-page PDF", async () => {
  vi.mocked(save).mockResolvedValue("/tmp/exports/portrait.pdf");
  vi.mocked(ipc.exportPdf).mockResolvedValue({ path: "/tmp/exports/portrait.pdf", filename: "portrait.pdf",
    sizeBytes: 250, sourceBytes: 1000, remuxed: false, directory: "/tmp/exports" });
  vi.mocked(ipc.analyzeFile).mockResolvedValue(image(1, ["JPG", "PNG", "PDF"]));
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/IMG_1.HEIC"]));
  await waitFor(() => expect(result.current.screen).toBe("local"));
  act(() => result.current.setFormat("PDF"));
  act(() => result.current.startExport());
  await waitFor(() => expect(result.current.screen).toBe("complete"));
  expect(ipc.exportPdf).toHaveBeenCalledWith(["/tmp/IMG_1.HEIC"], "/tmp/exports/portrait.pdf", expect.any(String));
  expect(result.current.output?.filename).toBe("portrait.pdf");
});

it("keeps original PDF page numbers when exporting a selected page", async () => {
  vi.mocked(ipc.importPdf).mockResolvedValue({ sourceName: "report", pages: [1, 2, 3].map((n) => ({
    ...image(n, ["PNG", "JPG"]), path: `/tmp/page-${String(n).padStart(4, "0")}.png`, name: `report - Page ${n}.png`, ext: "PNG",
  })) });
  vi.mocked(open).mockResolvedValue("/tmp/exports");
  let emit!: (event: JobEvent) => void;
  vi.mocked(ipc.onJobEvent).mockImplementation(async (handler) => { emit = handler; return () => {}; });
  vi.mocked(ipc.startExport).mockImplementation(async (request) => {
    queueMicrotask(() => emit({ jobId: "page-job", state: "completed", stageLabel: "Done",
      stageIndex: 1, stageCount: 1, progress: 1, outputFilename: "report_3.png", actions: [],
      output: { path: "/tmp/exports/report_3.png", filename: "report_3.png", sizeBytes: 50,
        remuxed: false, sourceBytes: 1000, directory: "/tmp/exports" }, error: null }));
    return "page-job";
  });
  const { result } = renderHook(() => useShift(), { wrapper });
  act(() => result.current.acceptPaths(["/tmp/report.pdf"]));
  await waitFor(() => expect(result.current.batch?.items).toHaveLength(3));
  act(() => result.current.deselectAllBatch());
  act(() => result.current.toggleBatchItem(result.current.batch!.items[2].id));
  act(() => result.current.startExport());
  await waitFor(() => expect(result.current.screen).toBe("complete"));
  expect(vi.mocked(ipc.startExport).mock.calls[0][0].batchNaming).toEqual({ base: "report", ordinal: 3 });
});
