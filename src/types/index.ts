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

export interface UrlMedia {
  provider: string;
  url: string;
  title: string;
  domain: string;
  duration: number | null;
  thumbnailPath: string | null;
  qualities: QualityOption[];
  hasVideo: boolean;
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
  outputDir: string | null;
  /** Images only; ignored by the audio/video pipeline. */
  compression: Compression | null;
  /** GIF and animated WEBP only; ignored by every other output. */
  loopSize: LoopSize | null;
  /** Full path chosen in the native Save panel. */
  destinationPath: string | null;
}

export interface SavePrompt {
  filename: string;
  directory: string;
}
