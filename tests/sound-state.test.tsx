import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SoundControlView } from "../src/features/edit/SoundControl";
import { ShiftProvider, useShift } from "../src/state/shift";
import * as ipc from "../src/lib/ipc";
import type { LocalMedia } from "../src/types";

vi.mock("../src/lib/ipc", () => ({
  defaultOutputDir: vi.fn(async () => "/tmp"),
  health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })),
  onJobEvent: vi.fn(async () => () => {}),
  analyzeFile: vi.fn(),
  previewSource: vi.fn(async () => "data:image/png;base64,preview"),
  releasePlayback: vi.fn(async () => {}),
  releaseUrlMedia: vi.fn(async () => {}),
  toShiftError: (error: Error) => ({ code: "test", message: error.message, hint: null, technical: null }),
}));

const video = (path: string, hasAudio: boolean): LocalMedia => ({
  kind: "video",
  path,
  name: path.split("/").at(-1) ?? path,
  ext: "MP4",
  sizeBytes: 100,
  duration: 20,
  width: 320,
  height: 180,
  hasVideo: true,
  hasAudio,
  outputs: ["MP4", "MP3"],
  hasAlpha: false,
});

const control = (overrides: Partial<React.ComponentProps<typeof SoundControlView>> = {}) => ({
  sourceMoves: true,
  isImage: false,
  format: "MP4" as const,
  hasAudio: true,
  soundEnabled: true,
  toggleSound: vi.fn(),
  ...overrides,
});

afterEach(cleanup);

test("the video sound control defaults on, toggles, and reports silent media honestly", () => {
  const props = control();
  const view = render(<SoundControlView {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "ON" }));
  expect(props.toggleSound).toHaveBeenCalledOnce();

  view.rerender(<SoundControlView {...control({ soundEnabled: false })} />);
  expect(screen.getByRole("button", { name: "OFF" })).toBeTruthy();

  view.rerender(<SoundControlView {...control({ hasAudio: false })} />);
  expect(screen.getByText("No audio")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /ON|OFF/ })).toBeNull();
});

test("audio and animation outputs do not expose the video sound preference", () => {
  const view = render(<SoundControlView {...control({ format: "MP3" })} />);
  expect(screen.queryByText("SOUND")).toBeNull();
  view.rerender(<SoundControlView {...control({ format: "GIF" })} />);
  expect(screen.queryByText("SOUND")).toBeNull();
});

test("loading a new video resets sound to on", async () => {
  vi.mocked(ipc.analyzeFile)
    .mockResolvedValueOnce(video("/first.mp4", true))
    .mockResolvedValueOnce(video("/second.mp4", true));
  const wrapper = ({ children }: { children: React.ReactNode }) => <ShiftProvider>{children}</ShiftProvider>;
  const { result } = renderHook(() => useShift(), { wrapper });

  act(() => result.current.acceptPaths(["/first.mp4"]));
  await waitFor(() => expect(result.current.localMedia?.path).toBe("/first.mp4"));
  expect(result.current.soundEnabled).toBe(true);
  act(() => result.current.toggleSound());
  expect(result.current.soundEnabled).toBe(false);

  act(() => result.current.acceptPaths(["/second.mp4"]));
  await waitFor(() => expect(result.current.localMedia?.path).toBe("/second.mp4"));
  expect(result.current.soundEnabled).toBe(true);
});
