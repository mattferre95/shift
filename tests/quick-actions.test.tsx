// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShiftProvider, useShift } from "@/state/shift";
import { ViewProvider } from "@/state/view";
import { SourceResult } from "@/features/input/SourceResult";
import { ResizeView } from "@/features/resize/ResizeView";
import { EditHeader } from "@/features/edit/EditView";
import * as ipc from "@/lib/ipc";
import type { LocalMedia } from "@/types";

vi.mock("@/state/playback", () => ({ usePlayback: () => ({ info: null, busy: false, error: null, status: null, timings: {}, cancel: vi.fn() }) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => null) }));
vi.mock("@/lib/ipc", () => ({
  defaultOutputDir: vi.fn(async () => "/tmp"),
  health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })),
  onJobEvent: vi.fn(async () => () => {}),
  analyzeFile: vi.fn(),
  previewSource: vi.fn(async () => "data:image/png;base64,preview"),
  aspectPreview: vi.fn(async () => null),
  savePrompt: vi.fn(async () => ({ directory: "/tmp", filename: "clip.mp4" })),
  releaseUrlMedia: vi.fn(async () => {}),
  cancelJob: vi.fn(async () => true),
  toShiftError: (error: Error) => ({ code: "test", message: error.message, hint: null, technical: null }),
}));

const media = (path: string, over: Partial<LocalMedia> = {}): LocalMedia => ({
  kind: "video", path, name: path.split("/").at(-1)!, ext: "MP4", sizeBytes: 100,
  duration: 20, width: 1280, height: 720, hasVideo: true, hasAudio: true,
  outputs: ["MP4", "GIF", "MP3"], hasAlpha: false, ...over,
});
const image = (path: string) => media(path, {
  kind: "image", ext: "JPG", duration: null, hasVideo: false, hasAudio: false, outputs: ["JPG", "PNG", "WEBP"],
});
const audio = (path: string) => media(path, {
  kind: "audio", ext: "MP3", width: null, height: null, hasVideo: false, outputs: ["MP3", "WAV"],
});

let shift!: ReturnType<typeof useShift>;
const Probe = () => { shift = useShift(); return null; };

/** The source screen beside Resize and Edit, all on one provider, as in the app. */
function mount(source: LocalMedia) {
  vi.mocked(ipc.analyzeFile).mockImplementation(async () => source);
  render(
    <ShiftProvider>
      <ViewProvider>
        <Probe />
        <div data-testid="source"><SourceResult /></div>
        <div data-testid="resize"><ResizeView /></div>
        <div data-testid="edit"><EditHeader /></div>
      </ViewProvider>
    </ShiftProvider>,
  );
  act(() => shift.acceptPaths([source.path]));
}
const area = (id: string) => within(screen.getByTestId(id));
const pressed = (id: string, name: string) => area(id).getByRole("button", { name }).getAttribute("aria-pressed");
const quick = () => screen.queryByRole("group", { name: "Quick actions" });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("offers sound and both flips for a video, with Resize's labels and tooltips", async () => {
  mount(media("/clip.mp4"));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/clip.mp4"));
  const group = within(quick()!);
  for (const name of ["Flip horizontally", "Flip vertically"]) {
    const button = group.getByRole("button", { name });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("title")).toBe(name);
  }
  expect(group.getByRole("button", { name: "ON" })).toBeTruthy();
});

it("offers both flips but no sound for an image", async () => {
  mount(image("/photo.jpg"));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/photo.jpg"));
  const group = within(quick()!);
  expect(group.getByRole("button", { name: "Flip horizontally" })).toBeTruthy();
  expect(group.getByRole("button", { name: "Flip vertically" })).toBeTruthy();
  expect(group.queryByRole("button", { name: /^(ON|OFF)$/ })).toBeNull();
  expect(group.queryByText("No audio")).toBeNull();
});

it("offers no flips for an audio source", async () => {
  mount(audio("/song.mp3"));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/song.mp3"));
  expect(area("source").queryByRole("button", { name: "Flip horizontally" })).toBeNull();
  expect(area("source").queryByRole("button", { name: "Flip vertically" })).toBeNull();
  expect(quick()).toBeNull();
  // The same rule holds for a video exported as audio: no shape, no mirror.
  expect(shift.showAspect).toBe(false);
});

it("a silent video says No audio beside the flips", async () => {
  mount(media("/silent.mp4", { hasAudio: false }));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/silent.mp4"));
  const group = within(quick()!);
  expect(group.getByText("No audio")).toBeTruthy();
  expect(group.queryByRole("button", { name: /^(ON|OFF)$/ })).toBeNull();
  expect(group.getByRole("button", { name: "Flip horizontally" })).toBeTruthy();
});

it("shares horizontal and vertical flip with Resize in both directions", async () => {
  mount(media("/clip.mp4"));
  await waitFor(() => expect(shift.localMedia?.path).toBe("/clip.mp4"));

  fireEvent.click(area("source").getByRole("button", { name: "Flip horizontally" }));
  expect(shift.flip).toEqual({ horizontal: true, vertical: false });
  expect(pressed("resize", "Flip horizontally")).toBe("true");

  fireEvent.click(area("resize").getByRole("button", { name: "Flip vertically" }));
  expect(shift.flip).toEqual({ horizontal: true, vertical: true });
  expect(pressed("source", "Flip vertically")).toBe("true");

  fireEvent.click(area("source").getByRole("button", { name: "Flip vertically" }));
  expect(pressed("resize", "Flip vertically")).toBe("false");
  fireEvent.click(area("resize").getByRole("button", { name: "Flip horizontally" }));
  expect(pressed("source", "Flip horizontally")).toBe("false");
  expect(shift.flip).toEqual({ horizontal: false, vertical: false });
});

it("shares sound with Edit in both directions", async () => {
  mount(media("/clip.mp4"));
  await waitFor(() => expect(area("source").getByRole("button", { name: "ON" })).toBeTruthy());
  fireEvent.click(area("source").getByRole("button", { name: "ON" }));
  expect(shift.soundEnabled).toBe(false);
  expect(area("edit").getByRole("button", { name: "OFF" })).toBeTruthy();
  fireEvent.click(area("edit").getByRole("button", { name: "OFF" }));
  expect(area("source").getByRole("button", { name: "ON" })).toBeTruthy();
});

it("sends quick-action flip and mute through the ordinary export request", async () => {
  mount(media("/clip.mp4"));
  await waitFor(() => expect(area("source").getByRole("button", { name: "ON" })).toBeTruthy());
  const source = area("source");
  fireEvent.click(source.getByRole("button", { name: "Flip horizontally" }));
  fireEvent.click(source.getByRole("button", { name: "ON" }));
  // Shown by the buttons themselves, so not repeated as "Also applied" text.
  expect(screen.queryByText(/Also applied/)).toBeNull();
  fireEvent.click(source.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(ipc.savePrompt).toHaveBeenCalledTimes(1));
  const request = vi.mocked(ipc.savePrompt).mock.calls[0][0];
  expect(request.input).toEqual({ kind: "local", path: "/clip.mp4" });
  expect(request.aspect).toMatchObject({ ratio: "original", flip: { horizontal: true, vertical: false } });
  // The existing audio-removal switch, the one Edit sets.
  expect(request.soundEnabled).toBe(false);
});

it("New Shift returns the quick actions to their defaults", async () => {
  mount(media("/clip.mp4"));
  await waitFor(() => expect(area("source").getByRole("button", { name: "ON" })).toBeTruthy());
  const source = area("source");
  fireEvent.click(source.getByRole("button", { name: "Flip horizontally" }));
  fireEvent.click(source.getByRole("button", { name: "Flip vertically" }));
  fireEvent.click(source.getByRole("button", { name: "ON" }));
  fireEvent.click(source.getByRole("button", { name: "New Shift" }));
  await waitFor(() => expect(shift.localMedia).toBeNull());
  expect(shift.flip).toEqual({ horizontal: false, vertical: false });
  expect(shift.soundEnabled).toBe(true);
  act(() => shift.acceptPaths(["/clip.mp4"]));
  await waitFor(() => expect(area("source").getByRole("button", { name: "ON" })).toBeTruthy());
  expect(pressed("source", "Flip horizontally")).toBe("false");
  expect(pressed("source", "Flip vertically")).toBe("false");
});
