/**
 * What is known about the open source, as display text. Only facts the
 * provider or the probe reported; anything unknown is left out, not guessed.
 */
import { formatBytes, formatDuration, resolutionLabel } from "@/lib/format";
import type { useShift } from "@/state/shift";

type Shift = ReturnType<typeof useShift>;

// A link and a file are never open together (each clears the other), so the
// source itself says which it is — the screen does not, once a job starts.
const fromUrl = (s: Shift) => !!s.urlMedia && !s.localMedia;

export function sourceName(s: Shift): string {
  return (fromUrl(s) ? s.urlMedia?.title : s.localMedia?.name) ?? "";
}

/** Type · dimensions · duration · size · container · audio. */
export function sourceMeta(s: Shift): string[] {
  const isUrl = fromUrl(s);
  const item = s.activeMedia;
  const local = s.localMedia;

  const typeLabel = isUrl
    ? item?.type === "video" ? "Video" : item?.type === "image" ? "Image" : "Audio"
    : local?.kind === "image"
      ? "Image"
      : local?.kind === "audio" || !local?.hasVideo
        ? "Audio"
        : local?.ext === "GIF"
          ? "Animated GIF"
          : "Video";
  const width = isUrl ? (s.playback.info?.width ?? item?.width ?? null) : (local?.width ?? null);
  const height = isUrl ? (s.playback.info?.height ?? item?.height ?? null) : (local?.height ?? null);
  const hasAudio = isUrl ? (s.playback.info?.hasAudio ?? null) : (local?.hasVideo ? local.hasAudio : null);

  return [
    typeLabel,
    resolutionLabel(width, height),
    item?.type !== "image" && local?.kind !== "image" && s.duration != null ? formatDuration(s.duration) : null,
    !isUrl ? formatBytes(local?.sizeBytes) : null,
    !isUrl && local?.ext ? local.ext : null,
    hasAudio == null ? null : hasAudio ? "with audio" : "no audio",
  ].filter((x): x is string => !!x);
}
