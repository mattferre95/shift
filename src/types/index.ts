/** Mirrors the Rust types in `src-tauri/src`. Keep both sides in step. */

export type OutputFormat =
  | "MP4" | "MOV" | "WEBM"
  | "MP3" | "WAV" | "M4A" | "AAC"
  | "JPG" | "PNG" | "WEBP";

export const AUDIO_FORMATS: OutputFormat[] = ["MP3", "WAV", "M4A", "AAC"];
export const IMAGE_FORMATS: OutputFormat[] = ["JPG", "PNG", "WEBP"];
export const isAudioFormat = (f: OutputFormat) => AUDIO_FORMATS.includes(f);
export const isImageFormat = (f: OutputFormat) => IMAGE_FORMATS.includes(f);

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
  /** Full path chosen in the native Save panel. */
  destinationPath: string | null;
}

export interface SavePrompt {
  filename: string;
  directory: string;
}
