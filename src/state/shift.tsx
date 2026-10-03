import { usePlayback } from "./playback";
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
import { convertFileSrc } from "@tauri-apps/api/core";
import * as ipc from "@/lib/ipc";
import { formatTimestamp, parseTimestamp } from "@/lib/format";
import {
  applyTrimPreset,
  clampTrimRange,
  defaultTrimRange,
  moveTrimRange,
  moveTrimStart,
  resizeTrimEnd,
  resizeTrimStart,
  type TrimDurationPreset,
  type TrimRange,
} from "./trim";
import {
  compressionOptions,
  ASPECT_DEFAULT,
  isAnimationFormat,
  isAudioFormat,
  keepsAlpha,
  loopLimit,
  MAX_DIMENSION,
  MIN_DIMENSION,
  type AspectPreview,
  type AspectRatio,
  type AspectSpec,
  type Compression,
  type FrameMode,
  type LoopSize,
  type ExportRequest,
  type Health,
  type JobEvent,
  type JobOutput,
  type LocalMedia,
  type OutputFormat,
  type PostMedia,
  type ShiftError,
  type UrlMedia,
} from "@/types";

export type Screen = "empty" | "url" | "local" | "processing" | "complete" | "error";

/**
 * Output chips for a remote source (URL-03).
 *
 * FLAC is deliberately absent. Everything a URL provider hands back is already
 * lossy, so wrapping it losslessly would produce a much larger file holding
 * exactly the same audio — an honest-looking option that helps nobody.
 */
const URL_OUTPUTS: OutputFormat[] = ["MP4", "GIF", "WEBP", "MP3", "M4A", "WAV"];

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
  activeMediaIndex: number;
  selectedMediaIds: string[];
  localMedia: LocalMedia | null;
  format: OutputFormat;
  quality: string;
  soundEnabled: boolean;
  clipEnabled: boolean;
  clipIn: string;
  clipOut: string;
  clipDurationPreset: TrimDurationPreset;
  clipError: string | null;
  clipLabel: string | null;
  /** Length of the current IN/OUT range, so the loop cap can be enforced. */
  clipSeconds: number | null;
  compression: Compression;
  loopSize: LoopSize;
  aspect: AspectSpec;
  aspectPreview: AspectPreview | null;
  /** The cached preview image for the current source, inlined, if any. */
  previewSource: string | null;
  /** Why a preview could not be built, so the box explains itself. */
  previewError: string | null;
  job: Job | null;
  output: JobOutput | null;
  error: ShiftError | null;
  outputDir: string;
  health: Health | null;
  /** Set when the native layer could not be reached at all. */
  healthError: string | null;
}

interface ShiftApi extends ShiftState {
  playback: ReturnType<typeof usePlayback>;
  activeMedia: PostMedia | null;
  selectedMediaCount: number;
  outputs: OutputFormat[];
  showQuality: boolean;
  duration: number | null;
  canExport: boolean;
  /** Local video only: MP3/WAV selected means "extract the audio". */
  extractAudio: boolean;
  isImage: boolean;
  /** The source has a moving picture, so loop outputs mean something here. */
  sourceMoves: boolean;
  /** The chosen output will be a silent animation from this particular source. */
  isLoop: boolean;
  /** The source is longer than a loop may be, so a trim is required. */
  loopNeedsTrim: boolean;
  /** What is currently selected would exceed the cap; export is blocked. */
  loopTooLong: boolean;
  /** The cap that applies to the format currently chosen. */
  loopMaxSeconds: number;
  /** The output has a shape, so ASPECT is meaningful. Audio never is. */
  showAspect: boolean;
  /** The dimensions this aspect choice produces, or null when unknowable. */
  aspectPreview: AspectPreview | null;
  /** Fit will pad with transparency rather than black. */
  padsTransparent: boolean;
  /** The image the preview draws, already converted for the webview. */
  previewImage: string | null;
  /** True while the preview picture stands in for real frames (URL sources). */
  previewIsApproximate: boolean;
  previewError: string | null;
  /** The custom size entered would enlarge the source. */
  aspectUpscales: boolean;
  setAspectRatio: (r: AspectRatio) => void;
  setFrameMode: (m: FrameMode) => void;
  setAspectSize: (side: "width" | "height", value: number | null) => void;
  aspectLocked: boolean;
  toggleAspectLock: () => void;
  compressionChoices: { id: Compression; label: string }[];
  setCompression: (c: Compression) => void;
  setLoopSize: (l: LoopSize) => void;
  submitUrl: (raw: string) => void;
  openFilePicker: () => void;
  acceptPaths: (paths: string[]) => void;
  setDragging: (v: boolean) => void;
  setFormat: (f: OutputFormat) => void;
  setQuality: (q: string) => void;
  toggleSound: () => void;
  selectPostMedia: (index: number) => void;
  togglePostMedia: (id: string) => void;
  selectAllPostMedia: () => void;
  clearPostMedia: () => void;
  toggleClip: () => void;
  setClipDurationPreset: (preset: TrimDurationPreset) => void;
  setClipIn: (v: string) => void;
  setClipOut: (v: string) => void;
  resizeClipIn: (seconds: number) => void;
  resizeClipOut: (seconds: number) => void;
  moveClipRange: (start: number) => void;
  startExport: () => void;
  saving: boolean;
  cancel: () => void;
  reset: () => void;
  retry: () => void;
}

const initial: ShiftState = {
  screen: "empty",
  analyzing: false,
  dragging: false,
  urlMedia: null,
  activeMediaIndex: 0,
  selectedMediaIds: [],
  localMedia: null,
  format: "MP4",
  quality: "best",
  soundEnabled: true,
  clipEnabled: false,
  clipIn: "00:00.000",
  clipOut: "00:15.000",
  clipDurationPreset: 15,
  clipError: null,
  clipLabel: null,
  clipSeconds: null,
  compression: "none",
  loopSize: "standard",
  aspect: ASPECT_DEFAULT,
  aspectPreview: null,
  previewSource: null,
  previewError: null,
  job: null,
  output: null,
  error: null,
  outputDir: "",
  health: null,
  healthError: null,
};

const trimRangeFrom = (state: ShiftState, duration: number | null): TrimRange => {
  const fallback = defaultTrimRange(duration);
  return {
    start: parseTimestamp(state.clipIn) ?? fallback.start,
    end: parseTimestamp(state.clipOut) ?? fallback.end,
    preset: state.clipDurationPreset,
  };
};

const trimFields = (range: TrimRange) => ({
  clipIn: formatTimestamp(range.start),
  clipOut: formatTimestamp(range.end),
  clipDurationPreset: range.preset,
});

const Ctx = createContext<ShiftApi | null>(null);

export function ShiftProvider({ children }: { children: ReactNode }) {
  const [s, set] = useState<ShiftState>(initial);
  // True while the Save panel is open, so the action cannot be fired twice.
  const [saving, setSaving] = useState(false);
  // A UI preference rather than part of the request: the backend is told a
  // width and a height, never how the user arrived at them.
  const [aspectLocked, setAspectLocked] = useState(true);
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
          const first = media.mediaItems[0];
          if (!first) throw new Error("No downloadable media was found.");
          const defaultOut: OutputFormat =
            first.type === "image" ? "JPG" : first.type === "video" ? "MP4" : "MP3";
          const trim = defaultTrimRange(first.duration);
          set((prev) => ({
            ...prev,
            screen: "url",
            analyzing: false,
            urlMedia: media,
            activeMediaIndex: 0,
            selectedMediaIds: media.mediaItems.map((item) => item.id),
            localMedia: null,
            format: defaultOut,
            quality: first.qualities[0]?.id ?? "best",
            soundEnabled: true,
            clipEnabled: false,
            clipIn: formatTimestamp(trim.start),
            clipOut: formatTimestamp(trim.end),
            clipDurationPreset: trim.preset,
            clipError: null,
            clipLabel: null,
            clipSeconds: null,
            aspect: ASPECT_DEFAULT,
            previewSource: null,
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
          const trim = defaultTrimRange(media.duration);
          set((prev) => ({
            ...prev,
            screen: "local",
            analyzing: false,
            localMedia: media,
            urlMedia: null,
            activeMediaIndex: 0,
            selectedMediaIds: [],
            format: media.outputs.includes(defaultOut) ? defaultOut : media.outputs[0],
            compression: "none",
            soundEnabled: true,
            clipEnabled: false,
            clipIn: formatTimestamp(trim.start),
            clipOut: formatTimestamp(trim.end),
            clipDurationPreset: trim.preset,
            clipError: null,
            clipLabel: null,
            clipSeconds: null,
            aspect: ASPECT_DEFAULT,
            previewSource: null,
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
          // Kept in step with VIDEO_EXTS / AUDIO_EXTS / IMAGE_EXTS in Rust.
          extensions: [
            "mp4", "mov", "webm", "mkv", "m4v", "avi",
            "mp3", "wav", "m4a", "aac", "flac", "aiff", "aif", "ogg", "opus",
            "heic", "heif", "jpg", "jpeg", "png", "webp", "avif", "gif",
          ],
        },
      ],
    });
    if (typeof picked === "string") acceptFile(picked);
  }, [acceptFile]);

  // ---- derived ------------------------------------------------------------
  const outputs = useMemo<OutputFormat[]>(() => {
    if (s.screen === "url") {
      const kind = s.urlMedia?.mediaItems[s.activeMediaIndex]?.type;
      if (kind === "image") return ["JPG", "PNG", "WEBP", "AVIF"];
      if (kind === "audio") return ["MP3", "M4A", "WAV"];
      return URL_OUTPUTS;
    }
    return s.localMedia?.outputs ?? [];
  }, [s.screen, s.localMedia, s.urlMedia, s.activeMediaIndex]);

  const activeMedia = s.urlMedia?.mediaItems[s.activeMediaIndex] ?? null;
  const playbackInput = activeMedia && activeMedia.type !== "image"
    ? { kind: "url" as const, url: activeMedia.source, quality: s.quality }
    : s.localMedia && s.localMedia.kind !== "image"
      ? { kind: "local" as const, path: s.localMedia.path }
      : null;
  // Remote preparation begins as soon as URL detection succeeds. Local media
  // remains lazy because it is already immediately available from disk.
  const playback = usePlayback(
    playbackInput,
    (!!activeMedia && activeMedia.type !== "image") || s.clipEnabled,
    activeMedia,
  );
  const duration = playback.info?.duration ?? activeMedia?.duration ?? s.localMedia?.duration ?? null;

  // Source-quality selection is real for a remote video, where yt-dlp actually
  // has separate renditions to choose between. A local file has exactly one,
  // so offering it there would mean downscaling — a post-V1 Resize action.
  const showQuality =
    s.screen === "url" && !isAudioFormat(s.format) && (activeMedia?.qualities.length ?? 0) > 1;

  const extractAudio = s.screen === "local" && !!s.localMedia?.hasVideo && isAudioFormat(s.format);
  const isImage = s.localMedia?.kind === "image" || activeMedia?.type === "image";
  const compressionChoices = compressionOptions(s.format);

  // WEBP is a still from a photo and an animation from a video, so the source
  // has to answer this, never the format alone.
  const sourceMoves = activeMedia?.type === "video" || (s.localMedia?.hasVideo ?? false);
  const isLoop = isAnimationFormat(s.format) && sourceMoves && !isImage;
  // Sound has no shape. ASPECT appears only when the thing being produced is
  // something you can look at.
  const showAspect = (sourceMoves || isImage) && !isAudioFormat(s.format);
  // Reported by the native layer alongside the dimensions, so the warning and
  // the numbers can never disagree.
  const aspectUpscales = s.aspectPreview?.upscales ?? false;
  // A still headed for a format with an alpha channel is padded with nothing
  // instead of black, so the words describing Fit have to follow the format.
  const padsTransparent = isImage && keepsAlpha(s.format);

  // A local source gets a real frame; a URL has only the poster the site gave
  // us, which stands in until the media itself exists.
  // A local source arrives already inlined; a URL has only the poster the site
  // gave us, which still goes through the asset protocol.
  const previewImage =
    s.previewSource ??
    (activeMedia?.thumbnailPath ? convertFileSrc(activeMedia.thumbnailPath) : null);
  const previewIsApproximate = !s.previewSource && !!activeMedia?.thumbnailPath && activeMedia.type !== "image";
  // A custom size has to be a real size before Export means anything. The
  // native layer refuses the same values; this only stops the user reaching the
  // Save panel first.
  const aspectInvalid =
    showAspect &&
    s.aspect.ratio === "freeform" &&
    [s.aspect.width, s.aspect.height].some(
      (v) => v == null || v < MIN_DIMENSION || v > MAX_DIMENSION,
    );

  // GIF and animated WEBP have different limits, so the format decides.
  const limit = loopLimit(s.format);
  const loopMaxSeconds = limit.max;
  const loopNeedsTrim = isLoop && (duration ?? 0) > limit.max;
  // What will actually be encoded: the trimmed range if there is one, else all
  // of it. Checked here so an over-long loop is refused before the Save panel
  // opens, rather than after the user has already named a file.
  const loopSeconds = s.clipEnabled ? s.clipSeconds : duration;
  const loopTooLong = isLoop && (loopSeconds ?? 0) > limit.max + 0.05;

  // ---- aspect preview -----------------------------------------------------
  // Pure arithmetic in the native layer: no process is spawned, so this is
  // cheap enough to run on every keystroke and keeps one implementation of the
  // geometry rather than a second one over here that could drift.
  const sourceW = playback.info?.width ?? s.localMedia?.width ?? activeMedia?.width ?? null;
  const sourceH = playback.info?.height ?? s.localMedia?.height ?? activeMedia?.height ?? null;
  useEffect(() => {
    if (!sourceW || !sourceH || s.aspect.ratio === "original") {
      patch({ aspectPreview: null });
      return;
    }
    let live = true;
    // A loop preset caps the result, so the number on screen has to know about
    // it or it would promise a size the file will not have.
    ipc
      .aspectPreview(sourceW, sourceH, s.aspect, isLoop ? s.loopSize : null)
      .then((p) => live && patch({ aspectPreview: p }))
      .catch(() => live && patch({ aspectPreview: null }));
    return () => {
      live = false;
    };
  }, [sourceW, sourceH, s.aspect, isLoop, s.loopSize, patch]);

  // ---- preview material ---------------------------------------------------
  // One cheap image per source, cached in the native layer. Cycling through
  // ratios never touches this effect: it depends on the file and, for moving
  // media, on the IN point — not on the aspect at all.
  const previewAt = useMemo(() => {
    if (!s.localMedia || s.localMedia.kind === "image") return null;
    const inPoint = s.clipEnabled ? parseTimestamp(s.clipIn) : null;
    // Whole seconds only, so scrubbing does not re-extract.
    const at = inPoint ?? (s.localMedia.duration ? s.localMedia.duration / 2 : null);
    return at == null ? null : Math.floor(at);
  }, [s.localMedia, s.clipEnabled, s.clipIn]);

  const localPath = !s.clipEnabled && (s.localMedia?.hasVideo || s.localMedia?.kind === "image") ? s.localMedia.path : null;
  useEffect(() => {
    if (!localPath) {
      patch({ previewSource: null, previewError: null });
      return;
    }
    let live = true;
    ipc
      .previewSource(localPath, previewAt)
      .then((uri) => live && patch({ previewSource: uri, previewError: null }))
      // A preview is a convenience: a failure explains itself inside the box
      // and never takes over the screen the way an export failure does.
      .catch(
        (e) =>
          live &&
          patch({ previewSource: null, previewError: ipc.toShiftError(e).message }),
      );
    return () => {
      live = false;
    };
  }, [localPath, previewAt, patch]);

  const [validatedClip, setValidatedClip] = useState<string | null>(null);
  const clipKey = JSON.stringify([s.clipIn, s.clipOut, duration]);
  // ---- clip ---------------------------------------------------------------
  // Provider metadata can publish a rounded duration, while the player later
  // measures the exact file. Keep the one authoritative range inside that
  // measured boundary without moving a valid user-selected IN point.
  useEffect(() => {
    if (!s.clipEnabled || duration == null) return;
    set((prev) => {
      const range = trimRangeFrom(prev, duration);
      if (range.end <= duration + 0.0005) return prev;
      return {
        ...prev,
        ...trimFields(clampTrimRange(range, duration)),
      };
    });
  }, [s.clipEnabled, duration]);

  useEffect(() => {
    if (!s.clipEnabled) {
      patch({ clipError: null, clipLabel: null, clipSeconds: null });
      return;
    }
    let live = true;
    ipc
      .validateClip(s.clipIn, s.clipOut, duration)
      .then(
        (check) =>
          live && (setValidatedClip(clipKey), patch({ clipError: null, clipLabel: check.label, clipSeconds: check.seconds })),
      )
      .catch(
        (e) =>
          live &&
          patch({
            clipError: ipc.toShiftError(e).message,
            clipLabel: null,
            clipSeconds: null,
          }),
      );
    return () => {
      live = false;
    };
  }, [s.clipEnabled, s.clipIn, s.clipOut, duration, patch]);

  const canExport =
    !s.analyzing &&
    (s.screen === "url" || s.screen === "local") &&
    (!s.clipEnabled || (!s.clipError && validatedClip === clipKey)) &&
    !loopTooLong &&
    !aspectInvalid &&
    (!s.urlMedia || s.urlMedia.mediaItems.length === 1 || s.selectedMediaIds.length > 0);

  // ---- actions ------------------------------------------------------------
  /**
   * Export… — the ellipsis is literal: this opens the native Save panel and
   * nothing is processed until the user confirms it.
   */
  const startExport = useCallback(async () => {
    if (!canExport || saving) return;
    const selectedItems = s.urlMedia?.mediaItems.filter((item) =>
      s.selectedMediaIds.includes(item.id),
    ) ?? [];
    if (s.urlMedia && s.urlMedia.mediaItems.length > 1) {
      setSaving(true);
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const chosen = await open({
          multiple: false,
          directory: true,
          defaultPath: s.outputDir || undefined,
        });
        if (typeof chosen !== "string" || chosen.length === 0) return;
        const id = crypto.randomUUID();
        jobRef.current = id;
        patch({
          screen: "processing",
          error: null,
          output: null,
          job: {
            id,
            state: "downloading",
            stageLabel: `Downloading ${selectedItems.length} media items…`,
            stageIndex: 0,
            stageCount: 1,
            progress: null,
            filename: "",
          },
        });
        const result = await ipc.downloadPostItems(selectedItems, chosen, id);
        jobRef.current = null;
        const saved = await ipc.setOutputDir(chosen).catch(() => chosen);
        patch({
          screen: "complete",
          outputDir: saved,
          output: {
            path: chosen,
            filename: `${result.paths.length} media items`,
            sizeBytes: result.sizeBytes,
            remuxed: true,
            sourceBytes: null,
            directory: result.directory,
          },
        });
      } catch (e) {
        jobRef.current = null;
        const error = ipc.toShiftError(e);
        if (error.code === "cancelled") {
          patch({ screen: "url", job: null });
        } else {
          patch({ screen: "error", error });
        }
      } finally {
        setSaving(false);
      }
      return;
    }
    const item = selectedItems[0] ?? activeMedia;
    const input: ExportRequest["input"] | null = item
      ? { kind: "url", url: item.source, quality: s.quality }
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
      loopSize: isLoop ? s.loopSize : null,
      aspect: showAspect ? s.aspect : null,
      soundEnabled: s.soundEnabled,
      destinationPath: null,
    };

    setSaving(true);
    try {
      // The backend owns the naming rules, so the panel is prefilled from it
      // rather than from a second copy of them over here.
      const sourceTitle =
        item?.filenameHint?.replace(/\.[^.]+$/, "") ??
        s.urlMedia?.title ??
        s.localMedia?.name ??
        "";
      const prompt = await ipc.savePrompt(request, sourceTitle);

      const { save } = await import("@tauri-apps/plugin-dialog");
      const ext = s.format.toLowerCase();
      const chosen = await save({
        defaultPath: `${prompt.directory}/${prompt.filename}`,
        // One extension, so the panel appends it and never becomes a second
        // format selector.
        filters: [{ name: s.format, extensions: [ext] }],
      });

      // Cancelled: no job, no temp directory, configuration left intact.
      if (typeof chosen !== "string" || chosen.length === 0) return;

      const directory = chosen.slice(0, chosen.lastIndexOf("/")) || prompt.directory;
      // Remember the folder as soon as it is confirmed, not only on success.
      const saved = await ipc.setOutputDir(directory).catch(() => directory);

      patch({ screen: "processing", error: null, output: null, outputDir: saved });
      const id = await ipc.startExport({ ...request, destinationPath: chosen });
      jobRef.current = id;
    } catch (e) {
      patch({ screen: "error", error: ipc.toShiftError(e) });
    } finally {
      setSaving(false);
    }
  }, [canExport, saving, s.urlMedia, s.selectedMediaIds, activeMedia, s.localMedia, s.quality, s.format, s.soundEnabled, s.clipEnabled, s.clipIn, s.clipOut, s.outputDir, s.compression, s.loopSize, s.aspect, isImage, isLoop, showAspect, patch]);

  const cancel = useCallback(() => {
    const id = s.job?.id ?? jobRef.current;
    if (id) ipc.cancelJob(id).catch(() => {});
  }, [s.job]);

  const reset = useCallback(() => {
    void ipc.releaseUrlMedia(
      s.urlMedia?.mediaItems.flatMap((item) => item.thumbnailPath ? [item.thumbnailPath] : []) ?? [],
    );
    jobRef.current = null;
    lastInput.current = null;
    set((prev) => ({
      ...initial,
      outputDir: prev.outputDir,
      health: prev.health,
      healthError: prev.healthError,
    }));
  }, [s.urlMedia]);

  const retry = useCallback(() => {
    const last = lastInput.current;
    if (!last) {
      reset();
      return;
    }
    if (last.kind === "url") submitUrl(last.value);
    else acceptFile(last.value);
  }, [reset, submitUrl, acceptFile]);


  const api: ShiftApi = {
    ...s,
    outputs,
    activeMedia,
    selectedMediaCount: s.selectedMediaIds.length,
    showQuality,
    duration,
    canExport,
    playback,
    saving,
    extractAudio,
    isImage,
    sourceMoves,
    isLoop,
    loopNeedsTrim,
    loopTooLong,
    loopMaxSeconds,
    showAspect,
    aspectPreview: s.aspectPreview,
    aspectUpscales,
    padsTransparent,
    previewImage,
    previewIsApproximate,
    previewError: s.previewError,
    aspectLocked,
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
        const next: ShiftState = {
          ...prev,
          format: f,
          compression: allowed.includes(prev.compression) ? prev.compression : "none",
        };

        // Picking a loop on a source longer than its cap turns the trim on and
        // proposes a range, rather than letting the user walk into a refusal.
        // It happens in plain sight — the toggle flips and the fields appear —
        // and nothing stops them changing or switching it back off.
        //
        // This also re-arms when moving *between* loop formats, because the
        // limits differ: a 20s range is a fine WEBP and too long as a GIF, and
        // leaving it would strand the user on a disabled Export button.
        const willLoop = isAnimationFormat(f) && sourceMoves && !isImage;
        if (willLoop) {
          const lim = loopLimit(f);
          const current = prev.clipEnabled ? (prev.clipSeconds ?? 0) : (duration ?? 0);
          if (current > lim.max) {
            next.clipEnabled = true;
            next.clipIn = "00:00.000";
            next.clipOut = formatTimestamp(Math.min(lim.default, duration ?? lim.default));
            next.clipDurationPreset =
              lim.default === 10 || lim.default === 15 || lim.default === 30 || lim.default === 60
                ? lim.default
                : "custom";
          }
        }
        return next;
      }),
    setCompression: (c) => patch({ compression: c }),
    setAspectRatio: (ratio) =>
      set((prev) => {
        // Moving to Freeform seeds the fields with the source's own size, so
        // the first thing shown is the truth rather than an empty box.
        if (ratio === "freeform" && prev.aspect.ratio !== "freeform") {
          return {
            ...prev,
            aspect: {
              ...prev.aspect,
              ratio,
              width: prev.aspect.width ?? prev.localMedia?.width ?? null,
              height: prev.aspect.height ?? prev.localMedia?.height ?? null,
            },
          };
        }
        return { ...prev, aspect: { ...prev.aspect, ratio } };
      }),
    setFrameMode: (frame) => set((prev) => ({ ...prev, aspect: { ...prev.aspect, frame } })),
    setAspectSize: (side, value) =>
      set((prev) => {
        const next = { ...prev.aspect, [side]: value };
        // With the lock on, the other side follows the source's proportions,
        // which is what keeps a custom size from becoming a stretch by hand.
        const sw = prev.localMedia?.width ?? null;
        const sh = prev.localMedia?.height ?? null;
        if (aspectLocked && value && sw && sh) {
          if (side === "width") next.height = Math.max(1, Math.round((value * sh) / sw));
          else next.width = Math.max(1, Math.round((value * sw) / sh));
        }
        return { ...prev, aspect: next };
      }),
    toggleAspectLock: () => setAspectLocked((v) => !v),
    setLoopSize: (l) => patch({ loopSize: l }),
    setQuality: (q) => patch({ quality: q }),
    toggleSound: () => set((prev) => ({ ...prev, soundEnabled: !prev.soundEnabled })),
    selectPostMedia: (index) =>
      set((prev) => {
        const item = prev.urlMedia?.mediaItems[index];
        if (!item) return prev;
        const nextFormat: OutputFormat =
          item.type === "image" ? "JPG" : item.type === "video" ? "MP4" : "MP3";
        const trim = defaultTrimRange(item.duration);
        return {
          ...prev,
          activeMediaIndex: index,
          format: nextFormat,
          quality: item.qualities[0]?.id ?? "best",
          soundEnabled: true,
          clipEnabled: false,
          ...trimFields(trim),
          aspect: ASPECT_DEFAULT,
          previewSource: null,
          previewError: null,
        };
      }),
    togglePostMedia: (id) =>
      set((prev) => ({
        ...prev,
        selectedMediaIds: prev.selectedMediaIds.includes(id)
          ? prev.selectedMediaIds.filter((value) => value !== id)
          : [...prev.selectedMediaIds, id],
      })),
    selectAllPostMedia: () =>
      set((prev) => ({
        ...prev,
        selectedMediaIds: prev.urlMedia?.mediaItems.map((item) => item.id) ?? [],
      })),
    clearPostMedia: () => patch({ selectedMediaIds: [] }),
    toggleClip: () => set((prev) => ({ ...prev, clipEnabled: !prev.clipEnabled })),
    setClipDurationPreset: (preset) =>
      set((prev) => ({
        ...prev,
        ...trimFields(applyTrimPreset(trimRangeFrom(prev, duration), preset, duration)),
      })),
    setClipIn: (v) =>
      set((prev) => {
        const seconds = parseTimestamp(v);
        if (seconds == null) return { ...prev, clipIn: v };
        const range = moveTrimStart(trimRangeFrom(prev, duration), seconds, duration);
        return {
          ...prev,
          ...trimFields(range),
          clipIn: Math.abs(range.start - seconds) < 0.0005 ? v : formatTimestamp(range.start),
        };
      }),
    setClipOut: (v) =>
      set((prev) => {
        const seconds = parseTimestamp(v);
        if (seconds == null) return { ...prev, clipOut: v };
        const range = resizeTrimEnd(trimRangeFrom(prev, duration), seconds, duration);
        return {
          ...prev,
          ...trimFields(range),
          clipOut: Math.abs(range.end - seconds) < 0.0005 ? v : formatTimestamp(range.end),
        };
      }),
    resizeClipIn: (seconds) =>
      set((prev) => ({
        ...prev,
        ...trimFields(resizeTrimStart(trimRangeFrom(prev, duration), seconds, duration)),
      })),
    resizeClipOut: (seconds) =>
      set((prev) => ({
        ...prev,
        ...trimFields(resizeTrimEnd(trimRangeFrom(prev, duration), seconds, duration)),
      })),
    moveClipRange: (start) =>
      set((prev) => ({
        ...prev,
        ...trimFields(moveTrimRange(trimRangeFrom(prev, duration), start, duration)),
      })),
    startExport: () => {
      void startExport();
    },
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
