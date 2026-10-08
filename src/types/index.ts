/** Mirrors the Rust types in `src-tauri/src`. Keep both sides in step. */

export type OutputFormat =
  | "MP4" | "MOV" | "WEBM" | "GIF"
  | "MP3" | "WAV" | "M4A" | "AAC" | "FLAC"
  | "JPG" | "PNG" | "WEBP" | "AVIF";

export const AUDIO_FORMATS: OutputFormat[] = ["MP3", "WAV", "M4A", "AAC", "FLAC"];
export const IMAGE_FORMATS: OutputFormat[] = ["JPG", "PNG", "WEBP", "AVIF"];
/**
 * Formats that carry motion but never sound. WEBP is deliberately in both this
 * list and `IMAGE_FORMATS`: from a still it is a still, from a video it is an
 * animation. Mirrors `OutputFormat::is_animation` on the Rust side — which is
 * why nothing here decides "is this a loop?" without also knowing the source.
 */
export const ANIMATION_FORMATS: OutputFormat[] = ["GIF", "WEBP"];
export const isAudioFormat = (f: OutputFormat) => AUDIO_FORMATS.includes(f);
export const isImageFormat = (f: OutputFormat) => IMAGE_FORMATS.includes(f);
export const isAnimationFormat = (f: OutputFormat) => ANIMATION_FORMATS.includes(f);

/**
 * Formats that can carry an alpha channel, and so are padded with nothing
 * rather than with black. Mirrors `image::keeps_alpha`; it applies to stills
 * only, since a video source has no transparency to preserve.
 */
export const keepsAlpha = (f: OutputFormat) => f === "PNG" || f === "WEBP";

/** Mirrors `profiles::LoopSize`. */
export type LoopSize = "small" | "standard" | "large";

/**
 * Loop length limits, per format. Mirrors `profiles::MAX_GIF_SECONDS` and
 * friends.
 *
 * The two formats do not cost the same per second. Measured at the Standard
 * preset on full-frame motion: a 30s animated WEBP is 2.1 MB, while a 15s GIF
 * is already 2.7 MB. GIF has no interframe compression, so it is treated as the
 * short-loop format it is; holding WEBP to the same limit would be an arbitrary
 * penalty.
 */
export const LOOP_LIMITS: Record<string, { max: number; default: number }> = {
  GIF: { max: 15, default: 10 },
  WEBP: { max: 30, default: 15 },
};

export const loopLimit = (f: OutputFormat) => LOOP_LIMITS[f] ?? LOOP_LIMITS.GIF;

/**
 * The frame rates are not round numbers by accident: GIF stores each frame's
 * delay in hundredths of a second, so only rates dividing 100 evenly play back
 * at the speed they claim. Kept in step with `profiles::LoopSize`.
 */
export const LOOP_SIZES: { id: LoopSize; label: string; detail: string }[] = [
  { id: "small", label: "Small", detail: "320 px · 10 fps" },
  { id: "standard", label: "Standard", detail: "480 px · 12.5 fps" },
  { id: "large", label: "Large", detail: "640 px · 20 fps" },
];

// ------------------------------------------------------------------ aspect

/** Mirrors `aspect::AspectRatio`. */
export type AspectRatio = "original" | "freeform" | "16:9" | "9:16" | "1:1" | "4:5" | "4:3";

/** Mirrors `aspect::FrameMode`. */
export type FrameMode = "fill" | "fit";

/** Mirrors `aspect::AspectSpec`. */
export interface AspectSpec {
  ratio: AspectRatio;
  frame: FrameMode;
  width: number | null;
  height: number | null;
}

export const ASPECT_DEFAULT: AspectSpec = {
  ratio: "original",
  frame: "fill",
  width: null,
  height: null,
};

/**
 * Laid out the way the design groups them: the two modes that are not a fixed
 * ratio on their own, then the ratios two to a row.
 */
export const ASPECT_ROWS: AspectRatio[][] = [
  ["original"],
  ["freeform"],
  ["16:9", "9:16"],
  ["1:1", "4:5"],
  ["4:3"],
];

export const aspectLabel = (r: AspectRatio) =>
  r === "original" ? "Original" : r === "freeform" ? "Freeform" : r;

/** Mirrors `aspect::MIN_DIMENSION` / `MAX_DIMENSION`. */
export const MIN_DIMENSION = 16;
export const MAX_DIMENSION = 8192;

/**
 * What an aspect choice would produce, as answered by `aspect_preview`.
 *
 * Deliberately not recomputed here: the geometry has one implementation, in
 * `media::aspect`, and the number on screen is the one the export will use.
 * `null` means there is nothing to show yet — Original, or a source whose size
 * is not known (a URL before it is fetched).
 */
export interface AspectPreview {
  width: number;
  height: number;
  upscales: boolean;
  /** Where the picture sits inside the frame — the numbers the encoder gets. */
  content: ContentBox;
  mode: FrameMode;
}

/**
 * Mirrors `aspect::ContentBox`. One shape for both modes: the source, at the
 * size it meets the canvas, offset from the canvas's top-left. Fit offsets are
 * positive and the gap is padding; Fill offsets are negative and the overflow
 * is cropped away.
 *
 * Given in canvas pixels. The UI only ever uses ratios of these, which any
 * later resize leaves untouched.
 */
export interface ContentBox {
  canvasWidth: number;
  canvasHeight: number;
  frameWidth: number;
  frameHeight: number;
  offsetX: number;
  offsetY: number;
}

/** Mirrors `media::image::Compression`. */
export type Compression = "none" | "light" | "balanced" | "strong" | "optimize";

/**
 * PNG is lossless, so it never gets a quality ladder — only whether to spend
 * time recompressing. This mirrors `image::options_for` on the Rust side.
 */
export function compressionOptions(format: OutputFormat): { id: Compression; label: string }[] {
  if (format === "PNG") {
    return [
      { id: "none", label: "None" },
      { id: "optimize", label: "Optimize" },
    ];
  }
  return [
    { id: "none", label: "None" },
    { id: "light", label: "Light" },
    { id: "balanced", label: "Balanced" },
    { id: "strong", label: "Strong" },
  ];
}

export interface ShiftError {
  code: string;
  message: string;
  hint: string | null;
  technical: string | null;
}

export interface QualityOption {
  id: string;
  label: string;
}

export type PostMediaType = "video" | "image" | "audio";

export interface PostMedia {
  id: string;
  type: PostMediaType;
  width: number | null;
  height: number | null;
  duration: number | null;
  thumbnailPath: string | null;
  source: string;
  filenameHint: string | null;
  qualities: QualityOption[];
}

export interface UrlMedia {
  provider: string;
  url: string;
  title: string;
  author: string | null;
  platform: string;
  domain: string;
  mediaItems: PostMedia[];
}

export interface PostDownloadResult {
  paths: string[];
  sizeBytes: number;
  directory: string;
}

export type MediaKind = "video" | "audio" | "image";

export interface LocalMedia {
  kind: MediaKind;
  path: string;
  name: string;
  ext: string;
  sizeBytes: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  outputs: OutputFormat[];
  /** Images only: transparency, which decides whether AVIF is on offer. */
  hasAlpha: boolean;
}

export type JobState =
  | "queued"
  | "analyzing"
  | "downloading"
  | "processing"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobOutput {
  path: string;
  filename: string;
  sizeBytes: number;
  remuxed: boolean;
  /** Size of the local input, when known, for the before/after line. */
  sourceBytes: number | null;
  /** Home-abbreviated folder the file landed in. */
  directory: string;
}

export interface JobEvent {
  jobId: string;
  state: JobState;
  stageLabel: string;
  stageIndex: number;
  stageCount: number;
  /** 0–1 inside the current stage, or null when it cannot be trusted. */
  progress: number | null;
  outputFilename: string;
  output: JobOutput | null;
  error: ShiftError | null;
  actions: unknown[];
}

export interface ClipCheck {
  seconds: number;
  label: string;
}

export interface Health {
  ffmpeg: boolean;
  ffprobe: boolean;
  ytdlp: boolean;
}

export type ExportInput =
  | { kind: "url"; url: string; quality: string | null }
  | { kind: "local"; path: string };

export interface ExportRequest {
  input: ExportInput;
  format: OutputFormat;
  clip: { start: string; end: string } | null;
  sourceTitle: string | null;
  sourceHint: string | null;
  sourceDuration: number | null;
  outputDir: string | null;
  /** Images only; ignored by the audio/video pipeline. */
  compression: Compression | null;
  /** GIF and animated WEBP only; ignored by every other output. */
  loopSize: LoopSize | null;
  /** Visual outputs only; ignored by audio, which has no shape. */
  aspect: AspectSpec | null;
  /** Video outputs only. False removes the audio stream entirely. */
  soundEnabled: boolean;
  /** Full path chosen in the native Save panel. */
  destinationPath: string | null;
}

export interface SavePrompt {
  filename: string;
  directory: string;
}
