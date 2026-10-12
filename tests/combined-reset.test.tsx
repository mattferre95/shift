// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShiftProvider, useShift } from "@/state/shift";
import * as ipc from "@/lib/ipc";
import { ASPECT_DEFAULT, type LocalMedia, type UrlMedia } from "@/types";

const playbackSpy = vi.hoisted(() => vi.fn((): Record<string, unknown> => ({ info: null })));
vi.mock("@/state/playback", () => ({ usePlayback: playbackSpy }));
vi.mock("@/lib/ipc", () => ({
  analyzeUrl: vi.fn(),
  analyzeFile: vi.fn(),
  defaultOutputDir: vi.fn(async () => "/tmp"),
  health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })),
  onJobEvent: vi.fn(async () => () => {}),
  previewSource: vi.fn(async () => "data:image/png;base64,preview"),
  aspectPreview: vi.fn(async () => null),
  validateClip: vi.fn(async () => ({ seconds: 5, label: "00:05.000" })),
  releaseUrlMedia: vi.fn(async () => {}),
  cancelJob: vi.fn(async () => true),
  toShiftError: (error: unknown) => error,
}));

const url = "https://www.youtube.com/watch?v=mKaioltf6Os";
const botError = { code: "youtube_bot_check", message: "YouTube wants browser verification.", hint: null, technical: null };
const youtube: UrlMedia = {
  provider: "ytdlp", url, title: "Public video", author: null, platform: "YouTube", domain: "youtube.com",
  mediaItems: [{
    id: "mKaioltf6Os", type: "video", width: 1920, height: 1080, duration: 60,
    thumbnailPath: null, source: url, filenameHint: "youtube-post.mp4", qualities: [],
  }],
};
const local: LocalMedia = {
  kind: "video", path: "/tmp/next.mp4", name: "next.mp4", ext: "MP4", sizeBytes: 100,
  duration: 30, width: 1280, height: 720, hasVideo: true, hasAudio: true, outputs: ["MP4", "MP3"], hasAlpha: false,
};

let shift!: ReturnType<typeof useShift>;
const Probe = () => { shift = useShift(); return null; };

beforeEach(() => {
  vi.clearAllMocks();
  playbackSpy.mockImplementation(() => ({ info: null }));
});
afterEach(cleanup);

it("New Shift clears the Chrome session together with flip, sound, framing and trim", async () => {
  vi.mocked(ipc.analyzeUrl).mockRejectedValueOnce(botError).mockResolvedValue(youtube);
  vi.mocked(ipc.analyzeFile).mockResolvedValue(local);
  render(<ShiftProvider><Probe /></ShiftProvider>);

  // 1–2. A URL that needs Chrome, retried explicitly.
  act(() => shift.submitUrl(url));
  await waitFor(() => expect(shift.error?.code).toBe("youtube_bot_check"));
  act(() => shift.retryWithChrome());
  await waitFor(() => expect(shift.urlMedia?.url).toBe(url));
  expect(shift.browserSession).toBe("chrome");
  expect(ipc.analyzeUrl).toHaveBeenLastCalledWith(url, "chrome");

  // 3–5. Flip, sound, framing and trim on that source.
  act(() => shift.toggleFlip("horizontal"));
  act(() => shift.toggleSound());
  act(() => shift.setAspectRatio("9:16"));
  act(() => shift.setCropRect({ x: 0, y: 0, width: 606, height: 1078 }));
  act(() => shift.toggleClip());
  act(() => shift.setClipIn("00:05.000"));
  act(() => shift.setClipOut("00:10.000"));
  expect(shift.flip.horizontal).toBe(true);
  expect(shift.soundEnabled).toBe(false);
  expect(shift.aspect.crop).toMatchObject({ x: 0, width: 606 });
  expect(shift.clipEnabled).toBe(true);

  // 6. New Shift, through the one shared reset.
  act(() => shift.reset());
  expect(shift.browserSession).toBe("none");

  // 7. Another source starts from nothing.
  act(() => shift.acceptPaths([local.path]));
  await waitFor(() => expect(shift.localMedia?.path).toBe(local.path));
  expect(shift.browserSession).toBe("none");
  expect(shift.flip).toEqual({ horizontal: false, vertical: false });
  expect(shift.aspect).toEqual(ASPECT_DEFAULT);
  expect(shift.clipEnabled).toBe(false);
  expect([shift.clipIn, shift.clipOut]).toEqual(["00:00.000", "00:15.000"]);
  expect(shift.soundEnabled).toBe(true);
  expect(shift.urlMedia).toBeNull();
  expect(shift.error).toBeNull();
});

it("a Chrome retry for the same source keeps its flip, and a different link does not", async () => {
  vi.mocked(ipc.analyzeUrl).mockResolvedValue(youtube);
  render(<ShiftProvider><Probe /></ShiftProvider>);
  act(() => shift.submitUrl(url));
  await waitFor(() => expect(shift.urlMedia?.url).toBe(url));
  act(() => shift.toggleFlip("vertical"));

  // The preview, not the analysis, hits the bot check; the retry is the same source.
  playbackSpy.mockImplementation(() => ({ info: null, errorCode: "youtube_bot_check", errorDetails: botError }));
  act(() => shift.setFormat("MP4"));
  await waitFor(() => expect(shift.screen).toBe("error"));
  // The real player is keyed by the session, so a Chrome retry starts clean.
  act(() => {
    playbackSpy.mockImplementation(() => ({ info: null }));
    shift.retryWithChrome();
  });
  await waitFor(() => expect(shift.screen).toBe("url"));
  expect(shift.browserSession).toBe("chrome");
  expect(shift.flip).toEqual({ horizontal: false, vertical: true });

  // A fresh link is a new source: no cookies, no flip.
  const other = "https://www.youtube.com/watch?v=other";
  vi.mocked(ipc.analyzeUrl).mockResolvedValue({ ...youtube, url: other, mediaItems: [{ ...youtube.mediaItems[0], id: "other", source: other }] });
  act(() => shift.submitUrl(other));
  await waitFor(() => expect(shift.urlMedia?.url).toBe(other));
  expect(shift.browserSession).toBe("none");
  expect(shift.flip).toEqual({ horizontal: false, vertical: false });
  expect(ipc.analyzeUrl).toHaveBeenLastCalledWith(other, "none");
});
