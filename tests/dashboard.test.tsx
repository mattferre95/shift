// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "@/app/App";
import { useShift } from "@/state/shift";
import { useView } from "@/state/view";
import * as ipc from "@/lib/ipc";
import { save } from "@tauri-apps/plugin-dialog";
import type { LocalMedia, UrlMedia } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/components/BuildInfo", () => ({ BuildInfo: () => <footer aria-label="Build information">SHIFT v1.3.1</footer> }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => "/tmp/out.mp4"), open: vi.fn(async () => null) }));
vi.mock("@/state/playback", () => ({ usePlayback: (input: { kind: string; path?: string } | null) => ({ info: { path: "/tmp/preview.mp4", duration: input?.path?.includes("short") ? 8 : 80, hasVideo: true, hasAudio: true, width: 1920, height: 1080, proxy: false }, busy: false, error: null, status: "ready", cancel: vi.fn(), retry: vi.fn(), fallback: vi.fn(), markReady: vi.fn() }) }));
vi.mock("@/lib/ipc", () => ({
  defaultOutputDir: vi.fn(async () => "/tmp"), health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })), onJobEvent: vi.fn(async () => () => {}), onAnalysisEvent: vi.fn(async () => () => {}),
  analyzeFile: vi.fn(), analyzeUrl: vi.fn(), previewSource: vi.fn(async () => "data:image/png;base64,preview"), aspectPreview: vi.fn(async () => null), validateClip: vi.fn(async () => ({ seconds: 10, label: "00:10.000" })),
  releaseUrlMedia: vi.fn(async () => {}), savePrompt: vi.fn(async () => ({ directory: "/tmp", filename: "out.mp4" })), setOutputDir: vi.fn(async () => "/tmp"), startExport: vi.fn(async () => "job-1"), cancelJob: vi.fn(async () => true),
  toShiftError: (error: Error) => ({ code: "test", message: error.message, hint: null, technical: null }),
}));

const media = (path: string, kind: "video" | "image" | "audio" = "video", hasAudio = true): LocalMedia => ({
  kind, path, name: path.split("/").at(-1)!, ext: kind === "image" ? "PNG" : kind === "audio" ? "MP3" : "MP4", sizeBytes: 1000,
  duration: kind === "image" ? null : 80, width: kind === "audio" ? null : 1920, height: kind === "audio" ? null : 1080,
  hasVideo: kind === "video", hasAudio: kind === "video" && hasAudio || kind === "audio", hasAlpha: false,
  outputs: kind === "image" ? ["JPG", "PNG", "WEBP"] : kind === "audio" ? ["MP3", "WAV"] : ["MP4", "MOV", "WEBM", "GIF", "MP3"],
});
const post: UrlMedia = { provider: "test", url: "https://example.com/post", title: "Post", author: null, platform: "Example", domain: "example.com", mediaItems: Array.from({ length: 12 }, (_, i) => ({ id: `item-${i}`, type: "image", source: `https://example.com/${i}.jpg`, filenameHint: `item-${i}.jpg`, thumbnailPath: null, width: 640, height: 480, duration: null, qualities: [] })) };

let shift: ReturnType<typeof useShift>;
let view: ReturnType<typeof useView>;
function Probe() { shift = useShift(); view = useView(); return null; }
function mount() { return render(<AppWithProbe />); }
function AppWithProbe() { return <App />; }

beforeEach(() => { vi.clearAllMocks(); vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => media(path)); });
afterEach(cleanup);

test("Dashboard is the empty default with URL and local entry", () => {
  mount();
  expect(screen.getByRole("button", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("textbox", { name: "Media URL" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Choose Files…" })).toBeTruthy();
  expect(screen.getByText("Drop files to start")).toBeTruthy();
  fireEvent.keyDown(window, { key: "1", metaKey: true });
  expect(screen.getByRole("button", { name: "Download" }).getAttribute("aria-current")).toBe("page");
  fireEvent.keyDown(window, { key: "0", metaKey: true });
  expect(screen.getByRole("button", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");
});

test("Fetch acknowledges immediately, reports native stages, and ignores duplicate submissions", async () => {
  let finish!: (value: UrlMedia) => void;
  let analysisHandler!: (event: ipc.AnalysisEvent) => void;
  vi.mocked(ipc.analyzeUrl).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  vi.mocked(ipc.onAnalysisEvent).mockImplementation(async (handler) => { analysisHandler = handler; return () => {}; });
  mount();
  fireEvent.change(screen.getByRole("textbox", { name: "Media URL" }), { target: { value: post.url } });
  fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
  expect(screen.getByRole("status").textContent).toBe("Resolving link…");
  expect((screen.getByRole("button", { name: "Resolving…" }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(ipc.analyzeUrl).toHaveBeenCalledTimes(1));
  fireEvent.submit(screen.getByRole("form", { name: "Fetch a link" }));
  expect(ipc.analyzeUrl).toHaveBeenCalledTimes(1);
  const requestId = vi.mocked(ipc.analyzeUrl).mock.calls[0][2]!;
  act(() => analysisHandler({ requestId, stage: "fetchingMediaInformation", elapsedMs: 25 }));
  expect(screen.getByRole("status").textContent).toBe("Fetching media information…");
  await act(async () => finish(post));
  expect(screen.getByLabelText("Post media")).toBeTruthy();
});

test("a local file reads as a file, never as a link being resolved", async () => {
  vi.mocked(ipc.analyzeFile).mockImplementationOnce(() => new Promise(() => {}));
  const { ShiftProvider } = await import("@/state/shift"); const { ViewProvider } = await import("@/state/view"); const { DashboardView } = await import("@/features/dashboard/DashboardView");
  render(<ShiftProvider><ViewProvider><Probe /><DashboardView /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/video.mp4"]));
  expect(screen.getByRole("status").textContent).toBe("Reading file…");
  expect(screen.queryByText(/Resolving/)).toBeNull();
  expect(screen.getByRole("button", { name: "Fetch" })).toBeTruthy();
});

test("a failed Fetch returns to an actionable state and a late result after New Shift is ignored", async () => {
  vi.mocked(ipc.analyzeUrl).mockRejectedValueOnce(new Error("Link failed"));
  const { ShiftProvider } = await import("@/state/shift"); const { ViewProvider } = await import("@/state/view");
  render(<ShiftProvider><ViewProvider><Probe /></ViewProvider></ShiftProvider>);
  act(() => shift.submitUrl(post.url));
  await waitFor(() => expect(shift.screen).toBe("error"));
  expect(shift.analyzing).toBe(false);
  expect(shift.analysisStage).toBeNull();

  let finish!: (value: UrlMedia) => void;
  vi.mocked(ipc.analyzeUrl).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => shift.submitUrl(post.url));
  await waitFor(() => expect(ipc.analyzeUrl).toHaveBeenCalledTimes(2));
  act(() => shift.reset());
  await act(async () => finish(post));
  expect(shift.screen).toBe("empty");
  expect(shift.urlMedia).toBeNull();
  // The guard was released by New Shift, so a new link can be fetched at once.
  vi.mocked(ipc.analyzeUrl).mockImplementationOnce(() => new Promise(() => {}));
  act(() => shift.submitUrl(post.url));
  await waitFor(() => expect(ipc.analyzeUrl).toHaveBeenCalledTimes(3));
});

test("Export shows destination feedback and returns to ready after Save As cancellation", async () => {
  let finishDialog!: (value: null) => void;
  vi.mocked(save).mockImplementationOnce(() => new Promise((resolve) => { finishDialog = resolve; }));
  const { ShiftProvider } = await import("@/state/shift"); const { ViewProvider } = await import("@/state/view"); const { DashboardView } = await import("@/features/dashboard/DashboardView");
  render(<ShiftProvider><ViewProvider><Probe /><DashboardView /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/video.mp4"]));
  await waitFor(() => expect(shift.screen).toBe("local"));
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  expect(screen.getByText("Choose destination…", { selector: ".sr-only" })).toBeTruthy();
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  await act(async () => finishDialog(null));
  expect(shift.screen).toBe("local");
  expect(screen.getByRole("button", { name: "Export…" })).toBeTruthy();
  expect(ipc.startExport).not.toHaveBeenCalled();
});

test("video editor exposes timeline, trim, sound, format, framing and shared export state", async () => {
  // A small probe is rendered through a separate provider in this test's
  // harness so the same state drives both the Dashboard and focused pages.
  const { ShiftProvider } = await import("@/state/shift");
  const { ViewProvider } = await import("@/state/view");
  const { DashboardView } = await import("@/features/dashboard/DashboardView");
  const { EditHeader } = await import("@/features/edit/EditView");
  render(<ShiftProvider><ViewProvider><Probe /><DashboardView /><div data-testid="focused"><EditHeader /></div></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/video.mp4"]));
  await waitFor(() => expect(shift.screen).toBe("local"));
  expect(view.view).toBe("dashboard");
  expect(screen.getByLabelText("Selected range")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Trim" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("SOUND ON")).toBeTruthy();
  fireEvent.click(within(screen.getByLabelText("Editing actions")).getByRole("button", { name: "ON" }));
  expect(shift.soundEnabled).toBe(false);
  expect(screen.getByText("SOUND OFF")).toBeTruthy();
  expect(screen.getByTestId("focused").textContent).toContain("Muted");
  fireEvent.change(screen.getByLabelText("Output format"), { target: { value: "WEBM" } });
  fireEvent.change(screen.getByLabelText("Aspect ratio"), { target: { value: "9:16" } });
  fireEvent.click(screen.getByRole("button", { name: "Flip horizontally" }));
  fireEvent.click(screen.getByRole("switch", { name: "Trim" }));
  expect(shift).toMatchObject({ format: "WEBM", aspect: { ratio: "9:16" }, flip: { horizontal: true }, clipEnabled: true, soundEnabled: false });
  fireEvent.change(screen.getByLabelText("IN", { selector: "input" }), { target: { value: "00:01.250" } });
  expect(shift.clipIn).toBe("00:01.250");
  await waitFor(() => expect((screen.getByRole("button", { name: "Export Clip…" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Export Clip…" }));
  await waitFor(() => expect(ipc.savePrompt).toHaveBeenCalled());
  expect(vi.mocked(ipc.savePrompt).mock.calls[0][0]).toMatchObject({ format: "WEBM", soundEnabled: false, clip: { start: "00:01.250" }, aspect: { ratio: "9:16", flip: { horizontal: true } } });
});

test("Dashboard presets enable shared Trim, clamp, and Custom retains precise boundaries", async () => {
  const { ShiftProvider } = await import("@/state/shift"); const { ViewProvider } = await import("@/state/view"); const { DashboardView } = await import("@/features/dashboard/DashboardView");
  render(<ShiftProvider><ViewProvider><Probe /><DashboardView /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/video.mp4"]));
  await waitFor(() => expect(shift.screen).toBe("local"));
  const duration = screen.getByRole("group", { name: "Duration" });
  for (const label of ["10s", "15s", "30s", "1m", "Custom"]) expect(within(duration).getByRole("button", { name: label })).toBeTruthy();
  expect(shift.clipEnabled).toBe(false);
  expect(within(duration).getByRole("button", { name: "15s" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(within(duration).getByRole("button", { name: "10s" }));
  expect(shift.clipEnabled).toBe(true);
  expect(shift.clipOut).toBe("00:10.000");
  fireEvent.change(screen.getByLabelText("IN", { selector: "input" }), { target: { value: "00:05.250" } });
  expect(shift.clipOut).toBe("00:15.250");
  for (const [label, out] of [["15s", "00:20.250"], ["30s", "00:35.250"], ["1m", "01:05.250"]]) {
    fireEvent.click(within(duration).getByRole("button", { name: label }));
    expect(shift.clipOut).toBe(out);
  }
  fireEvent.click(within(duration).getByRole("button", { name: "Custom" }));
  expect(shift.clipOut).toBe("01:05.250");
  fireEvent.change(screen.getByLabelText("OUT", { selector: "input" }), { target: { value: "00:17.375" } });
  expect(shift.clipDurationPreset).toBe("custom");
  expect(shift.clipOut).toBe("00:17.375");
  expect((screen.getByLabelText("IN", { selector: "input" }) as HTMLInputElement).value).toBe("00:05.250");
  expect(screen.getByText("SOUND ON")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Export Clip…" })).toBeTruthy();
  act(() => view.setView("edit"));
  expect(shift.clipDurationPreset).toBe("custom");
});

test("a preset longer than the source shows the actual short range", async () => {
  const { ShiftProvider } = await import("@/state/shift"); const { ViewProvider } = await import("@/state/view"); const { DashboardView } = await import("@/features/dashboard/DashboardView");
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => ({ ...media(path), duration: 8 }));
  render(<ShiftProvider><ViewProvider><Probe /><DashboardView /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/short.mp4"]));
  await waitFor(() => expect(shift.screen).toBe("local"));
  fireEvent.click(screen.getByRole("button", { name: "10s" }));
  expect(shift.clipOut).toBe("00:08.000");
  expect((screen.getByLabelText("OUT", { selector: "input" }) as HTMLInputElement).value).toBe("00:08.000");
});

test("audio and image show only applicable controls", async () => {
  const { ShiftProvider } = await import("@/state/shift"); const { ViewProvider } = await import("@/state/view"); const { DashboardView } = await import("@/features/dashboard/DashboardView");
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => path.endsWith(".mp3") ? media(path, "audio") : media(path, "image"));
  render(<ShiftProvider><ViewProvider><Probe /><DashboardView /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/audio.mp3"])); await waitFor(() => expect(shift.localMedia?.kind).toBe("audio"));
  expect(screen.getByLabelText("Selected range")).toBeTruthy();
  expect(screen.queryByLabelText("Aspect ratio")).toBeNull();
  expect(screen.queryByText("SOUND ON")).toBeNull();
  act(() => shift.acceptPaths(["/tmp/image.png"])); await waitFor(() => expect(shift.localMedia?.kind).toBe("image"));
  expect(screen.queryByLabelText("Selected range")).toBeNull();
  expect(screen.getByLabelText("Framing preview")).toBeTruthy();
  expect(screen.getByLabelText("Compression")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Flip vertically" })).toBeTruthy();
});

test("choosing a long GIF never enables Trim automatically", async () => {
  const { ShiftProvider } = await import("@/state/shift"); const { ViewProvider } = await import("@/state/view"); const { DashboardView } = await import("@/features/dashboard/DashboardView");
  render(<ShiftProvider><ViewProvider><Probe /><DashboardView /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(["/tmp/long.mp4"])); await waitFor(() => expect(shift.screen).toBe("local"));
  fireEvent.change(screen.getByLabelText("Output format"), { target: { value: "GIF" } });
  expect(shift.clipEnabled).toBe(false);
  expect(shift.loopTooLong).toBe(true);
  expect(screen.getByRole("button", { name: "Export…" })).toHaveProperty("disabled", true);
  expect(screen.queryByText("SOUND ON")).toBeNull();
  expect(screen.getByLabelText("Loop size")).toBeTruthy();
});

test("image batch and social collection paginate without mounting every item", async () => {
  const { ShiftProvider } = await import("@/state/shift"); const { ViewProvider } = await import("@/state/view"); const { DashboardView } = await import("@/features/dashboard/DashboardView");
  vi.mocked(ipc.analyzeFile).mockImplementation(async (path) => media(path, "image"));
  render(<ShiftProvider><ViewProvider><Probe /><DashboardView /></ViewProvider></ShiftProvider>);
  act(() => shift.acceptPaths(Array.from({ length: 12 }, (_, i) => `/tmp/image-${i}.png`)));
  await waitFor(() => expect(shift.batch?.items).toHaveLength(12));
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("6. image-5.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
  expect(shift.selectedBatchCount).toBe(0);
  act(() => shift.reset());
  vi.mocked(ipc.analyzeUrl).mockResolvedValue(post);
  act(() => shift.submitUrl(post.url));
  await waitFor(() => expect(shift.urlMedia?.mediaItems).toHaveLength(12));
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(screen.getByText("Original files")).toBeTruthy();
  const inspector = screen.getByLabelText("Selected post item");
  expect(within(inspector).getByText("item-0.jpg")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "2. item-1.jpg" }));
  expect(within(inspector).getByText("item-1.jpg")).toBeTruthy();
  expect(within(inspector).getByText("image · 640 × 480")).toBeTruthy();
});
