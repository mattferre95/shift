// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import { afterEach, expect, it, vi } from "vitest";
import App from "@/app/App";
import * as ipc from "@/lib/ipc";

vi.mock("@/state/playback", () => ({
  usePlayback: () => ({ info: null, busy: false, error: null, cancel: vi.fn() }),
}));
vi.mock("@/components/BuildInfo", () => ({ BuildInfo: () => null }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/downloads") }));
vi.mock("@/lib/ipc", () => ({
  defaultOutputDir: vi.fn(async () => "/tmp"),
  health: vi.fn(async () => ({ ffmpeg: true, ffprobe: true, ytdlp: true })),
  onJobEvent: vi.fn(async () => () => {}),
  analyzeUrl: vi.fn(),
  scrapeWebsite: vi.fn(),
  websiteImagePreview: vi.fn(async () => "data:image/png;base64,preview"),
  downloadWebsiteImages: vi.fn(),
  openOutputFolder: vi.fn(async () => {}),
  cancelJob: vi.fn(async () => true),
  releaseUrlMedia: vi.fn(async () => {}),
  toShiftError: (error: Error) => ({ message: error.message, code: "test", hint: null, technical: null }),
}));

const page: ipc.WebsitePage = {
  url: "https://example.com/shop",
  title: "Shop",
  folder: "example-com-shop",
  truncated: false,
  images: [
    { label: "Jacket", group: "jacket", stem: "jacket-01", url: "https://example.com/front.jpg", previewUrl: "https://example.com/front-small.jpg" },
    { label: "Jacket", group: "jacket", stem: "jacket-02", url: "https://example.com/back.jpg", previewUrl: "https://example.com/back-small.jpg" },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("pastes a page without fetching, then scrapes and downloads the selected images into one folder", async () => {
  vi.mocked(ipc.scrapeWebsite).mockResolvedValue(page);
  const folder = "/tmp/downloads/example-com-shop";
  vi.mocked(ipc.downloadWebsiteImages).mockResolvedValue({ folder, saved: 1, failed: [], cancelled: false });

  render(<App />);
  fireEvent.paste(document.body, { clipboardData: { getData: () => page.url } });
  expect(screen.getByRole("textbox", { name: "Media URL" })).toHaveProperty("value", page.url);
  expect(ipc.analyzeUrl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Scrape" }));
  expect(ipc.scrapeWebsite).toHaveBeenCalledWith(page.url);

  const back = await screen.findByRole("checkbox", { name: "Include jacket-02" });
  expect(screen.getByRole("button", { name: "Download Images" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Select All" }));
  expect(screen.getByText("2 of 2 selected")).toBeTruthy();
  fireEvent.click(back);
  expect(screen.getByText("1 of 2 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Download 1 Image…" }));
  expect(await screen.findByText(/1 image saved/)).toBeTruthy();
  expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, defaultPath: "/tmp" });
  expect(ipc.downloadWebsiteImages).toHaveBeenCalledWith(page, [page.images[0]], "/tmp/downloads", expect.any(String), expect.any(Function));
  fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
  expect(ipc.openOutputFolder).toHaveBeenCalledWith(folder);
});

it("can retry a failed scrape with the same page", async () => {
  vi.mocked(ipc.scrapeWebsite).mockRejectedValueOnce(new Error("No images found")).mockResolvedValueOnce(page);
  render(<App />);
  fireEvent.change(screen.getByRole("textbox", { name: "Media URL" }), { target: { value: page.url } });
  fireEvent.click(screen.getByRole("button", { name: "Scrape" }));
  expect((await screen.findByRole("alert")).textContent).toContain("No images found");
  fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
  await waitFor(() => expect(ipc.scrapeWebsite).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("checkbox", { name: "Include jacket-01" })).toBeTruthy();
});
