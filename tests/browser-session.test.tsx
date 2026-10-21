// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorState } from "@/features/export/ErrorState";
import { Home } from "@/features/input/Home";
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
    <output data-testid="screen">{shift.screen}</output>
    <output data-testid="format">{shift.format}</output>
    {shift.screen === "empty" && shift.analyzing && <Home />}
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
    fireEvent.click(screen.getByRole("button", { name: "Retry with Chrome" }));
    expect(screen.getByRole("dialog", { name: "Chrome permission required" })).toBeTruthy();
    expect(screen.getByText(/SHIFT does not store your cookies/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /password/i })).toBeNull();
    expect(ipc.analyzeUrl).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ipc.analyzeUrl).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry with Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Chrome" }));
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
        hint: "Try again and allow Chrome Safe Storage access when macOS asks.",
        technical: "ERROR: Keychain access denied for Chrome Safe Storage",
      });
    render(<ShiftProvider><Probe /></ShiftProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Load URL" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry with Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Chrome" }));
    await screen.findByText("Couldn't use the Chrome session.");
    expect(screen.getByText(/allow Chrome Safe Storage access/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry with Chrome" })).toBeTruthy();
    expect(ipc.analyzeUrl).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText(/Keychain access denied/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry with Chrome" }));
    expect(screen.getByRole("dialog", { name: "Chrome permission required" })).toBeTruthy();
    expect(ipc.analyzeUrl).toHaveBeenCalledTimes(2);
  });

  it("keeps export choices when a loaded source needs Chrome for preview", async () => {
    vi.mocked(ipc.analyzeUrl).mockResolvedValue(media);
    render(<ShiftProvider><Probe /></ShiftProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Load URL" }));
    await waitFor(() => expect(screen.getByTestId("format").textContent).toBe("MP4"));
    playbackSpy.mockImplementation(() => ({ info: null, errorCode: "youtube_bot_check", errorDetails: botError }));
    fireEvent.click(screen.getByRole("button", { name: "Choose MP3" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry with Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Chrome" }));
    await waitFor(() => expect(ipc.analyzeUrl).toHaveBeenCalledWith(url, "chrome"));
    expect(screen.getByTestId("format").textContent).toBe("MP3");
  });

  it("keeps the same Chrome request pending without showing a generic failure", async () => {
    let resolveChrome!: (value: typeof media) => void;
    vi.mocked(ipc.analyzeUrl).mockRejectedValueOnce(botError)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveChrome = resolve; }));
    render(<ShiftProvider><Probe /></ShiftProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Load URL" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry with Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Chrome" }));
    await waitFor(() => expect(screen.getByTestId("screen").textContent).toBe("empty"));
    expect(screen.getByText(/Follow the macOS permission prompt if it appears/)).toBeTruthy();
    expect(screen.queryByText("Something went wrong.")).toBeNull();
    expect(screen.queryByText("Couldn't open this link")).toBeNull();
    resolveChrome(media);
    await waitFor(() => expect(screen.getByTestId("screen").textContent).toBe("url"));
    expect(screen.getByTestId("browser-session").textContent).toBe("chrome");
  });

  it("shows the Chrome-session recovery action when preview access fails", async () => {
    vi.mocked(ipc.analyzeUrl).mockRejectedValueOnce(botError).mockResolvedValue(media);
    render(<ShiftProvider><Probe /></ShiftProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Load URL" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry with Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Chrome" }));
    await waitFor(() => expect(screen.getByTestId("screen").textContent).toBe("url"));
    playbackSpy.mockImplementation(() => ({ info: null, errorCode: "chrome_session_unavailable", errorDetails: {
      code: "chrome_session_unavailable", message: "Couldn't use the Chrome session.", hint: null, technical: null,
    } }));
    fireEvent.click(screen.getByRole("button", { name: "Choose MP3" }));
    await screen.findByText("Couldn't use the Chrome session.");
    expect(screen.getByRole("button", { name: "Retry with Chrome" })).toBeTruthy();
  });
});
