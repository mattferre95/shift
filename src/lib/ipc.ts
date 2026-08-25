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
  UrlMedia,
} from "@/types";

const JOB_EVENT = "shift://job";

export const analyzeUrl = (url: string) => invoke<UrlMedia>("analyze_url", { url });

export const analyzeFile = (path: string) => invoke<LocalMedia>("analyze_file", { path });

export const validateClip = (start: string, end: string, duration: number | null) =>
  invoke<ClipCheck>("validate_clip", { start, end, duration });

export const startExport = (request: ExportRequest) =>
  invoke<string>("start_export", { request });

export const cancelJob = (jobId: string) => invoke<boolean>("cancel_job", { jobId });

export const defaultOutputDir = () => invoke<string>("default_output_dir");

export const setOutputDir = (dir: string) => invoke<string>("set_output_dir", { dir });

export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });

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
