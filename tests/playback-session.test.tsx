import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { usePlayback } from "../src/state/playback";
import * as ipc from "../src/lib/ipc";
import type { UrlMedia } from "../src/types";

vi.mock("../src/lib/ipc", () => ({
  createPlayback: vi.fn(),
  preparePlayback: vi.fn(),
  releasePlayback: vi.fn(),
  onPlaybackEvent: vi.fn(),
  toShiftError: (e: Error) => ({ message: e.message }),
}));

const local = { kind: "local" as const, path: "/fixture.mp3" };
const url = { kind: "url" as const, url: "https://x.com/example/status/1", quality: "best" };
const media: UrlMedia = {
  provider: "fixture", url: url.url, title: "Clip", domain: "x.com", duration: 8,
  thumbnailPath: null, qualities: [{ id: "best", label: "Best" }], hasVideo: true,
  width: 640, height: 360,
};
const info = { path: "/preview.mp4", duration: 8, hasVideo: true, hasAudio: true, width: 640, height: 360, proxy: false };

beforeEach(() => {
  vi.mocked(ipc.createPlayback).mockReset().mockResolvedValue("session");
  vi.mocked(ipc.preparePlayback).mockReset().mockResolvedValue(info);
  vi.mocked(ipc.releasePlayback).mockReset().mockResolvedValue();
  vi.mocked(ipc.onPlaybackEvent).mockReset().mockResolvedValue(() => {});
});
afterEach(cleanup);

test("URL preparation starts immediately and reports truthful stages", async () => {
  let event: ((value: ipc.PlaybackEvent) => void) | undefined;
  vi.mocked(ipc.onPlaybackEvent).mockImplementation(async (handler) => { event = handler; return () => {}; });
  const { result } = renderHook(() => usePlayback(url, true, media));
  expect(result.current.status).toBe("resolving");
  await waitFor(() => expect(result.current.info).toEqual(info));
  expect(ipc.createPlayback).toHaveBeenCalledWith(url, media);
  act(() => event?.({ playbackId: "session", stage: "downloadingPreview", elapsedMs: 12, detail: "video" }));
  expect(result.current.status).toBe("downloading");
  act(() => result.current.markReady());
  expect(result.current.status).toBe("ready");
});

test("trim, output, and URL quality changes reuse one preview download", async () => {
  const { result, rerender } = renderHook(
    ({ input, enabled }) => usePlayback(input, enabled, media),
    { initialProps: { input: url as typeof url | null, enabled: true } },
  );
  await waitFor(() => expect(result.current.info).toEqual(info));
  rerender({ input: url, enabled: false });
  rerender({ input: { ...url, quality: "480" }, enabled: true });
  expect(ipc.preparePlayback).toHaveBeenCalledTimes(1);
  expect(ipc.createPlayback).toHaveBeenCalledTimes(1);
});

test("source reset releases the preview session", async () => {
  const { result, rerender } = renderHook(
    ({ input, enabled }) => usePlayback(input, enabled),
    { initialProps: { input: local as typeof local | null, enabled: true } },
  );
  await waitFor(() => expect(result.current.info).toEqual(info));
  rerender({ input: null, enabled: false });
  await waitFor(() => expect(ipc.releasePlayback).toHaveBeenCalledWith("session"));
  expect(result.current.info).toBeNull();
});

test("cancel during creation releases a late session and ignores stale data", async () => {
  let resolve!: (id: string) => void;
  vi.mocked(ipc.createPlayback).mockReturnValue(new Promise((r) => { resolve = r; }));
  const { result } = renderHook(() => usePlayback(url, true, media));
  act(() => result.current.cancel());
  await act(async () => resolve("late"));
  expect(ipc.releasePlayback).toHaveBeenCalledWith("late");
  expect(ipc.preparePlayback).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(false);
});

test("failed preparation cleans the session and leaves preview retryable", async () => {
  vi.mocked(ipc.preparePlayback).mockRejectedValue(new Error("bad preview"));
  const { result } = renderHook(() => usePlayback(url, true, media));
  await waitFor(() => expect(result.current.error).toBe("bad preview"));
  expect(result.current.busy).toBe(false);
  expect(ipc.releasePlayback).toHaveBeenCalledWith("session");
});
