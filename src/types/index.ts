/** Mirrors the Rust types in `src-tauri/src`. Keep both sides in step. */

export type OutputFormat = "MP4" | "MOV" | "WEBM" | "MP3" | "WAV" | "M4A" | "AAC";

export const AUDIO_FORMATS: OutputFormat[] = ["MP3", "WAV", "M4A", "AAC"];
export const isAudioFormat = (f: OutputFormat) => AUDIO_FORMATS.includes(f);

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

export interface LocalMedia {
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
}
