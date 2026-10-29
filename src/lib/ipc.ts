/**
 * The whole native surface, in one place.
 *
 * Every call is a named command with structured arguments. Nothing here builds
 * a command line, and there is deliberately no escape hatch that could.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ClipCheck,
  ExportRequest,
  Health,
  JobEvent,
  LocalMedia,
  JobOutput,
  SavePrompt,
  PostDownloadResult,
  PostMedia,
  UrlMedia,
  BrowserSessionMode,
} from "@/types";

const JOB_EVENT = "shift://job";
const PLAYBACK_EVENT = "shift://playback";
const ANALYSIS_EVENT = "shift://analysis";

export interface AnalysisEvent {
  requestId: string;
  stage: "fetchingMediaInformation";
  elapsedMs: number;
}

export type PlaybackStage =
  | "resolvingLink"
  | "sourceSelected"
  | "downloadingPreview"
  | "mediaAvailable"
  | "preparingPlayer"
  | "proxying"
  | "backendReady";

export interface PlaybackEvent {
  playbackId: string;
  stage: PlaybackStage;
  elapsedMs: number;
  detail: string | null;
}

export const analyzeUrl = (url: string, browserSession: BrowserSessionMode = "none", requestId?: string) =>
  invoke<UrlMedia>("analyze_url", { url, browserSession, requestId });
export const onAnalysisEvent = (handler: (event: AnalysisEvent) => void): Promise<UnlistenFn> =>
  listen<AnalysisEvent>(ANALYSIS_EVENT, (e) => handler(e.payload));
export const downloadPostItems = (items: PostMedia[], destinationDir: string, jobId: string, browserSession: BrowserSessionMode) =>
  invoke<PostDownloadResult>("download_post_items", {
    request: { items, destinationDir, jobId, browserSession },
  });

export const analyzeFile = (path: string) => invoke<LocalMedia>("analyze_file", { path });
export const importPdf = (path: string) => invoke<{ sourceName: string; pages: LocalMedia[] }>("import_pdf", { path });
export const exportPdf = (sources: string[], destinationPath: string, jobId: string) =>
  invoke<JobOutput>("export_pdf", { request: { sources, destinationPath, jobId } });

/** The dimensions an aspect choice would produce, or null when unknowable. */
export const aspectPreview = (
  sourceWidth: number,
  sourceHeight: number,
  spec: import("@/types").AspectSpec,
  loopSize: import("@/types").LoopSize | null,
) =>
  invoke<import("@/types").AspectPreview | null>("aspect_preview", {
    sourceWidth,
    sourceHeight,
    spec,
    loopSize,
  });

/**
 * A small cached image for the framing preview, inlined as a data URI.
 * Never an export input. `at` is a position in seconds for moving media.
 */
export const previewSource = (path: string, at: number | null) =>
  invoke<string>("preview_source", { path, at });

export const validateClip = (start: string, end: string, duration: number | null) =>
  invoke<ClipCheck>("validate_clip", { start, end, duration });

export const startExport = (request: ExportRequest) =>
  invoke<string>("start_export", { request });

/** Filename and folder the native Save panel should open with. */
export const savePrompt = (request: ExportRequest) =>
  invoke<SavePrompt>("save_prompt", { request });

export const cancelJob = (jobId: string) => invoke<boolean>("cancel_job", { jobId });

export const defaultOutputDir = () => invoke<string>("default_output_dir");

export const setOutputDir = (dir: string) => invoke<string>("set_output_dir", { dir });

export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });
export const openOutputFolder = (path: string) => invoke<void>("open_output_folder", { path });

export const health = () => invoke<Health>("health");

export const onJobEvent = (handler: (event: JobEvent) => void): Promise<UnlistenFn> =>
  listen<JobEvent>(JOB_EVENT, (e) => handler(e.payload));

/**
 * Anything thrown across the IPC boundary comes back as a `ShiftError` shape.
 * This keeps a stray string or plugin error from reaching the UI raw.
 */
export function toShiftError(e: unknown): import("@/types").ShiftError {
  if (e && typeof e === "object" && "message" in e && "code" in e) {
    return e as import("@/types").ShiftError;
  }
  // Anything unexpected still has to arrive with something to look at, or a
  // real failure shows up as a bare "Something went wrong." with no trail.
  let technical: string;
  if (e instanceof Error) technical = `${e.name}: ${e.message}\n${e.stack ?? ""}`;
  else if (typeof e === "string") technical = e;
  else if (e === undefined) technical = "the native layer rejected without a value";
  else {
    try {
      technical = JSON.stringify(e) ?? String(e);
    } catch {
      technical = String(e);
    }
  }
  console.error("[shift] unnormalized failure", e);
  return { code: "unknown", message: "Something went wrong.", hint: null, technical };
}

export const createPlayback = (input: ExportRequest["input"], knownMedia: PostMedia | null = null) =>
  invoke<string>("create_playback", { input, knownMedia });
export const preparePlayback = (id: string, forceProxy: boolean) => invoke<import("@/state/playback").PlaybackInfo>("prepare_playback", { id, forceProxy });
export const releasePlayback = (id: string) => invoke<void>("release_playback", { id });
export const releaseUrlMedia = (thumbnailPaths: string[]) =>
  invoke<void>("release_url_media", { thumbnailPaths });
export const onPlaybackEvent = (handler: (event: PlaybackEvent) => void): Promise<UnlistenFn> =>
  listen<PlaybackEvent>(PLAYBACK_EVENT, (e) => handler(e.payload));
