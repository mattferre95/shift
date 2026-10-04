import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { PostMediaPicker } from "../src/features/social/PostMediaPicker";

const selectPostMedia = vi.fn();
const togglePostMedia = vi.fn();
const selectAllPostMedia = vi.fn();
const clearPostMedia = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("../src/state/shift", () => ({
  useShift: () => ({
    activeMediaIndex: 0,
    selectedMediaIds: ["photo"],
    selectPostMedia,
    togglePostMedia,
    selectAllPostMedia,
    clearPostMedia,
    urlMedia: {
      mediaItems: [
        {
          id: "photo", type: "image", width: 1080, height: 1350, duration: null,
          thumbnailPath: "/cache/photo.jpg", source: "https://cdn/photo.jpg",
          filenameHint: "instagram-post-01.jpg", qualities: [],
        },
        {
          id: "video", type: "video", width: 720, height: 1280, duration: 4,
          thumbnailPath: "/cache/video.jpg", source: "https://cdn/video.mp4",
          filenameHint: "instagram-post-02.mp4", qualities: [{ id: "best", label: "Best" }],
        },
      ],
    },
  }),
}));

beforeEach(() => vi.clearAllMocks());

test("keeps ordered mixed media compact and independently selectable", () => {
  render(<PostMediaPicker />);
  expect(screen.getAllByRole("button", { name: /image 1|video 2/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "video 2" }));
  expect(selectPostMedia).toHaveBeenCalledWith(1);
  fireEvent.click(screen.getAllByRole("checkbox")[1]);
  expect(togglePostMedia).toHaveBeenCalledWith("video");
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(selectAllPostMedia).toHaveBeenCalledOnce();
  expect(clearPostMedia).toHaveBeenCalledOnce();
});
