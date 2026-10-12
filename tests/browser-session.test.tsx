// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorState } from "@/features/export/ErrorState";
import { ShiftProvider, useShift } from "@/state/shift";
import * as ipc from "@/lib/ipc";

const playbackSpy = vi.hoisted(() => vi.fn(() => ({ info: null })));
vi.mock("@/state/playback", () => ({ usePlayback: playbackSpy }));
vi.mock("@/lib/ipc", () => ({
  analyzeUrl: vi.fn(),
  defaultOutputDir: () => Promise.resolve("/tmp"),
  health: () => Promise.resolve({ ffmpeg: true, ffprobe: true, ytdlp: true }),
  onJobEvent: () => Promise.resolve(() => {}),
  releaseUrlMedia: () => Promise.resolve(undefined),
  toShiftError: (error: unknown) => error,
}));

const url = "https://www.youtube.com/watch?v=mKaioltf6Os";
const botError = {
  code: "youtube_bot_check",
  message: "YouTube wants browser verification.",
  hint: "YouTube is asking SHIFT to verify this request through a browser session.",
  technical: "ERROR: Sign in to confirm you’re not a bot",
};
const media = {
  provider: "ytdlp", url, title: "Public video", author: null,
  platform: "YouTube", domain: "youtube.com", mediaItems: [{
    id: "mKaioltf6Os", type: "video" as const, width: 1920, height: 1080,
    duration: 60, thumbnailPath: null, source: url,
    filenameHint: "youtube-post.mp4", qualities: [],
  }],
};

function Probe() {
  const shift = useShift();
  return <>
    <button onClick={() => shift.submitUrl(url)}>Load URL</button>
    <button onClick={() => shift.setFormat("MP3")}>Choose MP3</button>
    <button onClick={shift.reset}>New Shift</button>
    <output data-testid="browser-session">{shift.browserSession}</output>
    <output data-testid="format">{shift.format}</output>
    {shift.screen === "error" && <ErrorState />}
  </>;
}

describe("YouTube browser-session retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playbackSpy.mockImplementation(() => ({ info: null }));
  });
  afterEach(cleanup);

  it("starts without cookies, retries only on click, and clears the mode on New Shift", async () => {
    vi.mocked(ipc.analyzeUrl)
      .mockRejectedValueOnce(botError)
      .mockResolvedValueOnce(media);
    render(<ShiftProvider><Probe /></ShiftProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Load URL" }));
    await screen.findByRole("button", { name: "Retry with Chrome" });
    expect(ipc.analyzeUrl).toHaveBeenCalledTimes(1);
    expect(ipc.analyzeUrl).toHaveBeenCalledWith(url, "none");
    expect(screen.getByText(/SHIFT does not store your cookies/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry with Chrome" }));
    await waitFor(() => expect(ipc.analyzeUrl).toHaveBeenCalledWith(url, "chrome"));
    await waitFor(() => expect(screen.getByTestId("browser-session").textContent).toBe("chrome"));
    expect(playbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "url", url, browserSession: "chrome" }),
      true,
      expect.objectContaining({ source: url }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New Shift" }));
    expect(screen.getByTestId("browser-session").textContent).toBe("none");
  });

  it("stops after a failed Chrome attempt and retains technical details", async () => {
    vi.mocked(ipc.analyzeUrl)
      .mockRejectedValueOnce(botError)
      .mockRejectedValueOnce({
        code: "chrome_session_unavailable", message: "Couldn't use the Chrome session.",
        hint: "Check that Chrome has a usable local session, then start over.",
        technical: "ERROR: Could not copy Chrome cookie database",
      });
    render(<ShiftProvider><Probe /></ShiftProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Load URL" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry with Chrome" }));
    await screen.findByText("Couldn't use the Chrome session.");
    expect(screen.queryByRole("button", { name: "Retry with Chrome" })).toBeNull();
    expect(ipc.analyzeUrl).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText(/Could not copy Chrome cookie database/)).toBeTruthy();
  });

  it("keeps export choices when a loaded source needs Chrome for preview", async () => {
    vi.mocked(ipc.analyzeUrl).mockResolvedValue(media);
    render(<ShiftProvider><Probe /></ShiftProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Load URL" }));
    await waitFor(() => expect(screen.getByTestId("format").textContent).toBe("MP4"));
    playbackSpy.mockImplementation(() => ({ info: null, errorCode: "youtube_bot_check", errorDetails: botError }));
    fireEvent.click(screen.getByRole("button", { name: "Choose MP3" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry with Chrome" }));
    await waitFor(() => expect(ipc.analyzeUrl).toHaveBeenCalledWith(url, "chrome"));
    expect(screen.getByTestId("format").textContent).toBe("MP3");
  });
});
