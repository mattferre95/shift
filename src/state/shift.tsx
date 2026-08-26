/**
 * The single source of truth for what the window is showing.
 *
 * The screen sequence mirrors the product's mental model:
 *   INPUT → DETECT → ACTION → PROCESS → OUTPUT
 * Nothing here talks to a process; it only describes intent and reacts to job
 * events coming back from the native layer.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as ipc from "@/lib/ipc";
import { formatTimestamp } from "@/lib/format";
import {
  compressionOptions,
  isAudioFormat,
  type Compression,
  type ExportRequest,
  type Health,
  type JobEvent,
  type JobOutput,
  type LocalMedia,
  type OutputFormat,
  type ShiftError,
  type UrlMedia,
} from "@/types";

export type Screen = "empty" | "url" | "local" | "processing" | "complete" | "error";

/** Output chips for a remote source (URL-03). */
const URL_OUTPUTS: OutputFormat[] = ["MP4", "MP3", "WAV"];

interface Job {
  id: string;
  state: JobEvent["state"];
  stageLabel: string;
  stageIndex: number;
  stageCount: number;
  progress: number | null;
  filename: string;
}

interface ShiftState {
  screen: Screen;
  analyzing: boolean;
  dragging: boolean;
  urlMedia: UrlMedia | null;
  localMedia: LocalMedia | null;
  format: OutputFormat;
  quality: string;
  clipEnabled: boolean;
  clipIn: string;
  clipOut: string;
  clipError: string | null;
  clipLabel: string | null;
  compression: Compression;
  job: Job | null;
  output: JobOutput | null;
  error: ShiftError | null;
  outputDir: string;
  health: Health | null;
  /** Set when the native layer could not be reached at all. */
  healthError: string | null;
}

interface ShiftApi extends ShiftState {
  outputs: OutputFormat[];
  showQuality: boolean;
  duration: number | null;
  canExport: boolean;
  /** Local video only: MP3/WAV selected means "extract the audio". */
  extractAudio: boolean;
  isImage: boolean;
  compressionChoices: { id: Compression; label: string }[];
  setCompression: (c: Compression) => void;
  submitUrl: (raw: string) => void;
  openFilePicker: () => void;
  acceptPaths: (paths: string[]) => void;
  setDragging: (v: boolean) => void;
  setFormat: (f: OutputFormat) => void;
  setQuality: (q: string) => void;
  toggleClip: () => void;
  setClipIn: (v: string) => void;
  setClipOut: (v: string) => void;
  chooseOutputDir: () => void;
  startExport: () => void;
  cancel: () => void;
  reset: () => void;
  retry: () => void;
}

const initial: ShiftState = {
  screen: "empty",
  analyzing: false,
  dragging: false,
  urlMedia: null,
  localMedia: null,
  format: "MP4",
  quality: "best",
  clipEnabled: false,
  clipIn: "00:00.000",
  clipOut: "00:10.000",
  clipError: null,
  clipLabel: null,
  compression: "none",
  job: null,
  output: null,
  error: null,
  outputDir: "",
  health: null,
  healthError: null,
};

const Ctx = createContext<ShiftApi | null>(null);

export function ShiftProvider({ children }: { children: ReactNode }) {
  const [s, set] = useState<ShiftState>(initial);
  const patch = useCallback((p: Partial<ShiftState>) => set((prev) => ({ ...prev, ...p })), []);

  // The last thing the user handed us, so Try again can repeat it.
  const lastInput = useRef<{ kind: "url"; value: string } | { kind: "file"; value: string } | null>(
    null,
  );
  const jobRef = useRef<string | null>(null);

  useEffect(() => {
    ipc.defaultOutputDir().then((dir) => patch({ outputDir: dir })).catch(() => {});
    // A silent failure here would hide a broken install behind a normal-looking
    // empty state, so it is surfaced rather than swallowed.
    ipc
      .health()
      .then((h) => patch({ health: h, healthError: null }))
      .catch((e) => patch({ healthError: ipc.toShiftError(e).message }));
  }, [patch]);

  // ---- job events ---------------------------------------------------------
  useEffect(() => {
    const unlisten = ipc.onJobEvent((event) => {
      // Ignore stragglers from a job the user already walked away from.
      if (jobRef.current && event.jobId !== jobRef.current) return;

      if (event.state === "completed" && event.output) {
        jobRef.current = null;
        patch({ screen: "complete", output: event.output, job: null });
        return;
      }
      if (event.state === "cancelled") {
        jobRef.current = null;
        // Back to the screen the user exported from, with their choices intact.
        set((prev) => ({
          ...prev,
          job: null,
          screen: prev.urlMedia ? "url" : prev.localMedia ? "local" : "empty",
        }));
        return;
      }
      if (event.state === "failed") {
        jobRef.current = null;
        patch({ screen: "error", error: event.error, job: null });
        return;
      }
      patch({
        screen: "processing",
        job: {
          id: event.jobId,
          state: event.state,
          stageLabel: event.stageLabel,
          stageIndex: event.stageIndex,
          stageCount: event.stageCount,
          progress: event.progress,
          filename: event.outputFilename,
        },
      });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [patch]);

  // ---- input --------------------------------------------------------------
  const submitUrl = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!/^https?:\/\//i.test(value)) return;
      lastInput.current = { kind: "url", value };
      patch({ analyzing: true, error: null, dragging: false });
      ipc
        .analyzeUrl(value)
        .then((media) => {
          const defaultOut: OutputFormat = media.hasVideo ? "MP4" : "MP3";
          set((prev) => ({
            ...prev,
            screen: "url",
            analyzing: false,
            urlMedia: media,
            localMedia: null,
            format: defaultOut,
            quality: media.qualities[0]?.id ?? "best",
            clipEnabled: false,
            clipIn: "00:00.000",
            clipOut: formatTimestamp(Math.min(10, media.duration ?? 10)),
            clipError: null,
            clipLabel: null,
            output: null,
            error: null,
          }));
        })
        .catch((e) => patch({ analyzing: false, screen: "error", error: ipc.toShiftError(e) }));
    },
    [patch],
  );

  const acceptFile = useCallback(
    (path: string) => {
      lastInput.current = { kind: "file", value: path };
      patch({ analyzing: true, error: null, dragging: false });
      ipc
        .analyzeFile(path)
        .then((media) => {
          const defaultOut: OutputFormat =
            media.kind === "image" ? "JPG" : media.hasVideo ? "MP4" : "MP3";
          set((prev) => ({
            ...prev,
            screen: "local",
            analyzing: false,
            localMedia: media,
            urlMedia: null,
            format: media.outputs.includes(defaultOut) ? defaultOut : media.outputs[0],
            compression: "none",
            clipEnabled: false,
            clipIn: "00:00.000",
            clipOut: formatTimestamp(Math.min(10, media.duration ?? 10)),
            clipError: null,
            clipLabel: null,
            output: null,
            error: null,
          }));
        })
        .catch((e) => patch({ analyzing: false, screen: "error", error: ipc.toShiftError(e) }));
    },
    [patch],
  );

  const acceptPaths = useCallback(
    (paths: string[]) => {
      // V1 is deliberately single-input; batch is post-V1.
      if (paths.length > 0) acceptFile(paths[0]);
    },
    [acceptFile],
  );

  const openFilePicker = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Media",
          extensions: [
            "mp4", "mov", "webm",
            "mp3", "wav", "m4a", "aac",
            "heic", "heif", "jpg", "jpeg", "png", "webp",
          ],
        },
      ],
    });
    if (typeof picked === "string") acceptFile(picked);
  }, [acceptFile]);

  // ---- derived ------------------------------------------------------------
  const outputs = useMemo<OutputFormat[]>(() => {
    if (s.screen === "url") return URL_OUTPUTS;
    return s.localMedia?.outputs ?? [];
  }, [s.screen, s.localMedia]);

  const duration = s.urlMedia?.duration ?? s.localMedia?.duration ?? null;

  // Source-quality selection is real for a remote video, where yt-dlp actually
  // has separate renditions to choose between. A local file has exactly one,
  // so offering it there would mean downscaling — a post-V1 Resize action.
  const showQuality =
    s.screen === "url" && !isAudioFormat(s.format) && (s.urlMedia?.qualities.length ?? 0) > 1;

  const extractAudio = s.screen === "local" && !!s.localMedia?.hasVideo && isAudioFormat(s.format);
  const isImage = s.localMedia?.kind === "image";
  const compressionChoices = compressionOptions(s.format);

  // ---- clip ---------------------------------------------------------------
  useEffect(() => {
    if (!s.clipEnabled) {
      patch({ clipError: null, clipLabel: null });
      return;
    }
    let live = true;
    ipc
      .validateClip(s.clipIn, s.clipOut, duration)
      .then((check) => live && patch({ clipError: null, clipLabel: check.label }))
      .catch((e) => live && patch({ clipError: ipc.toShiftError(e).message, clipLabel: null }));
    return () => {
      live = false;
    };
  }, [s.clipEnabled, s.clipIn, s.clipOut, duration, patch]);

  const canExport =
    !s.analyzing && (s.screen === "url" || s.screen === "local") && (!s.clipEnabled || !s.clipError);

  // ---- actions ------------------------------------------------------------
  const startExport = useCallback(() => {
    if (!canExport) return;
    const input: ExportRequest["input"] | null = s.urlMedia
      ? { kind: "url", url: s.urlMedia.url, quality: s.quality }
      : s.localMedia
        ? { kind: "local", path: s.localMedia.path }
        : null;
    if (!input) return;

    const request: ExportRequest = {
      input,
      format: s.format,
      clip: s.clipEnabled && !isImage ? { start: s.clipIn, end: s.clipOut } : null,
      outputDir: s.outputDir || null,
      compression: isImage ? s.compression : null,
    };
    patch({ screen: "processing", error: null, output: null });
    ipc
      .startExport(request)
      .then((id) => {
        jobRef.current = id;
      })
      .catch((e) => patch({ screen: "error", error: ipc.toShiftError(e) }));
  }, [canExport, s.urlMedia, s.localMedia, s.quality, s.format, s.clipEnabled, s.clipIn, s.clipOut, s.outputDir, s.compression, isImage, patch]);

  const cancel = useCallback(() => {
    const id = s.job?.id ?? jobRef.current;
    if (id) ipc.cancelJob(id).catch(() => {});
  }, [s.job]);

  const reset = useCallback(() => {
    jobRef.current = null;
    lastInput.current = null;
    set((prev) => ({
      ...initial,
      outputDir: prev.outputDir,
      health: prev.health,
      healthError: prev.healthError,
    }));
  }, []);

  const retry = useCallback(() => {
    const last = lastInput.current;
    if (!last) {
      reset();
      return;
    }
    if (last.kind === "url") submitUrl(last.value);
    else acceptFile(last.value);
  }, [reset, submitUrl, acceptFile]);

  const chooseOutputDir = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, defaultPath: s.outputDir });
    if (typeof picked === "string") {
      const saved = await ipc.setOutputDir(picked).catch(() => picked);
      patch({ outputDir: saved });
    }
  }, [s.outputDir, patch]);

  const api: ShiftApi = {
    ...s,
    outputs,
    showQuality,
    duration,
    canExport,
    extractAudio,
    isImage,
    compressionChoices,
    submitUrl,
    openFilePicker,
    acceptPaths,
    setDragging: (v) => patch({ dragging: v }),
    setFormat: (f) =>
      set((prev) => {
        // The compression ladder differs per format; drop a level the new
        // format does not offer rather than silently sending it.
        const allowed = compressionOptions(f).map((o) => o.id);
        return {
          ...prev,
          format: f,
          compression: allowed.includes(prev.compression) ? prev.compression : "none",
        };
      }),
    setCompression: (c) => patch({ compression: c }),
    setQuality: (q) => patch({ quality: q }),
    toggleClip: () => set((prev) => ({ ...prev, clipEnabled: !prev.clipEnabled })),
    setClipIn: (v) => patch({ clipIn: v }),
    setClipOut: (v) => patch({ clipOut: v }),
    chooseOutputDir,
    startExport,
    cancel,
    reset,
    retry,
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useShift(): ShiftApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useShift must be used inside ShiftProvider");
  return ctx;
}
