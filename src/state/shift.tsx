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
import { appendImages, commonFormats, removeImage, selectedImages, setAllSelected, toggleSelected } from "./imageBatch";
import { centeredCrop, cropForSource } from "@/features/resize/framing";
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
  FLIP_NONE,
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
  type CropRect,
  type Flip,
  type FrameMode,
  type LoopSize,
  type ExportRequest,
  type BrowserSessionMode,
  type Health,
  type JobEvent,
  type JobOutput,
  type ImageBatch,
  type LocalMedia,
  type OutputFormat,
  type PostMedia,
  type ShiftError,
  type UrlMedia,
} from "@/types";

export type Screen = "empty" | "url" | "local" | "batch" | "processing" | "complete" | "error";

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
  analysisStage: "resolvingLink" | "fetchingMediaInformation" | null;
  dragging: boolean;
  urlMedia: UrlMedia | null;
  activeMediaIndex: number;
  selectedMediaIds: string[];
  localMedia: LocalMedia | null;
  batch: ImageBatch | null;
  inputWarning: string | null;
  format: OutputFormat;
  quality: string;
  soundEnabled: boolean;
  clipEnabled: boolean;
  clipIn: string;
  clipOut: string;
  clipDurationPreset: TrimDurationPreset;
  /** True once the user has edited IN/OUT, so late metadata never overwrites it. */
  clipTouched: boolean;
  clipError: string | null;
  clipLabel: string | null;
  /** Length of the current IN/OUT range, so the loop cap can be enforced. */
  clipSeconds: number | null;
  compression: Compression;
  loopSize: LoopSize;
  aspect: AspectSpec;
  aspectPreview: AspectPreview | null;
  /** Mirroring of the source. Beside the aspect, never part of its geometry. */
  flip: Flip;
  /** The cached preview image for the current source, inlined, if any. */
  previewSource: string | null;
  /** Why a preview could not be built, so the box explains itself. */
  previewError: string | null;
  job: Job | null;
  output: JobOutput | null;
  error: ShiftError | null;
  browserSession: BrowserSessionMode;
  outputDir: string;
  health: Health | null;
  /** Set when the native layer could not be reached at all. */
  healthError: string | null;
}

interface ShiftApi extends ShiftState {
  playback: ReturnType<typeof usePlayback>;
  activeMedia: PostMedia | null;
  selectedMediaCount: number;
  selectedBatchCount: number;
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
  setCropRect: (crop: CropRect) => void;
  toggleFlip: (axis: keyof Flip) => void;
  aspectLocked: boolean;
  toggleAspectLock: () => void;
  compressionChoices: { id: Compression; label: string }[];
  setCompression: (c: Compression) => void;
  setLoopSize: (l: LoopSize) => void;
  submitUrl: (raw: string) => void;
  openFilePicker: () => void;
  acceptPaths: (paths: string[]) => void;
  setBatchName: (name: string) => void;
  toggleBatchItem: (id: string) => void;
  selectAllBatch: () => void;
  deselectAllBatch: () => void;
  removeBatchItem: (id: string) => void;
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
  /**
   * What the user last handed SHIFT, for display only: the link being resolved,
   * or the one that failed. Read-only; `retry` is still the way to repeat it.
   */
  lastInput: { kind: "url" | "file"; value: string } | null;
  cancel: () => void;
  reset: () => void;
  retry: () => void;
  retryWithChrome: () => void;
}

const initial: ShiftState = {
  screen: "empty",
  analyzing: false,
  analysisStage: null,
  dragging: false,
  urlMedia: null,
  activeMediaIndex: 0,
  selectedMediaIds: [],
  localMedia: null,
  batch: null,
  inputWarning: null,
  format: "MP4",
  quality: "best",
  soundEnabled: true,
  clipEnabled: false,
  clipIn: "00:00.000",
  clipOut: "00:00.000",
  clipDurationPreset: "custom",
  clipTouched: false,
  clipError: null,
  clipLabel: null,
  clipSeconds: null,
  compression: "none",
  loopSize: "standard",
  aspect: ASPECT_DEFAULT,
  aspectPreview: null,
  flip: FLIP_NONE,
  previewSource: null,
  previewError: null,
  job: null,
  output: null,
  error: null,
  browserSession: "none",
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
  const savingRef = useRef(false);
  // A UI preference rather than part of the request: the backend is told a
  // width and a height, never how the user arrived at them.
  const [aspectLocked, setAspectLocked] = useState(true);
  const lockedFreeformRatio = useRef<number | null>(null);
  const patch = useCallback((p: Partial<ShiftState>) => set((prev) => ({ ...prev, ...p })), []);

  // The last thing the user handed us, so Try again can repeat it.
  const lastInput = useRef<{ kind: "url"; value: string } | { kind: "file"; value: string } | null>(
    null,
  );
  const jobRef = useRef<string | null>(null);
  const awaitingJobId = useRef(false);
  const retiredJobs = useRef(new Set<string>());
  const sourceGeneration = useRef(0);
  const pendingUrl = useRef(false);
  const batchRun = useRef<{ cancelled: boolean; itemId: string | null; resolve: ((event: JobEvent) => void) | null } | null>(null);

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
      if (retiredJobs.current.has(event.jobId)) return;
      if (!jobRef.current && awaitingJobId.current) {
        jobRef.current = event.jobId;
        awaitingJobId.current = false;
      }
      if (event.jobId !== jobRef.current) return;

      const runningBatch = batchRun.current;
      if (runningBatch) {
        const itemId = runningBatch.itemId;
        if (itemId) {
          set((prev) => prev.batch ? ({ ...prev, batch: {
            ...prev.batch,
            items: prev.batch.items.map((item) => item.id === itemId ? {
              ...item,
              status: event.state === "completed" ? "success" : event.state === "failed" ? "failed" : event.state === "cancelled" ? "cancelled" : "processing",
              output: event.output ?? item.output,
              error: event.error ?? item.error,
            } : item),
          } }) : prev);
        }
        if (event.state === "completed" || event.state === "failed" || event.state === "cancelled") {
          jobRef.current = null;
          runningBatch.resolve?.(event);
          runningBatch.resolve = null;
        } else {
          patch({ job: { id: event.jobId, state: event.state, stageLabel: event.stageLabel, stageIndex: event.stageIndex, stageCount: event.stageCount, progress: event.progress, filename: event.outputFilename } });
        }
        return;
      }

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
    (raw: string, browserSession: BrowserSessionMode = "none", preserveSettings = false) => {
      const value = raw.trim();
      if (!/^https?:\/\//i.test(value) || pendingUrl.current) return;
      pendingUrl.current = true;
      const generation = ++sourceGeneration.current;
      const requestId = crypto.randomUUID();
      const started = performance.now();
      let redirectMs: number | null = null;
      lastInput.current = { kind: "url", value };
      // A Chrome retry can begin from the error screen. Leave that screen
      // immediately, or its cleared error renders as "Something went wrong"
      // while yt-dlp is still waiting for the native Keychain prompt.
      set((prev) => ({ ...prev, analyzing: true, analysisStage: "resolvingLink", error: null, dragging: false,
        browserSession, screen: browserSession === "chrome" ? "empty" : prev.screen }));
      let unlisten: (() => void) | null = null;
      const analyze = async () => {
        try {
          unlisten = await ipc.onAnalysisEvent((event) => {
            if (generation !== sourceGeneration.current || event.requestId !== requestId) return;
            redirectMs = event.elapsedMs;
            patch({ analysisStage: "fetchingMediaInformation" });
          });
        } catch { /* Analysis remains available if the optional stage listener fails. */ }
        return ipc.analyzeUrl(value, browserSession, requestId);
      };
      void analyze()
        .then((media) => {
          if (generation !== sourceGeneration.current) return;
          if (import.meta.env.DEV && import.meta.env.MODE !== "test") console.debug("[SHIFT timing] URL analysis", { redirectMs, totalMs: Math.round(performance.now() - started) });
          const first = media.mediaItems[0];
          if (!first) throw new Error("No downloadable media was found.");
          const defaultOut: OutputFormat =
            first.type === "image" ? "JPG" : first.type === "video" ? "MP4" : "MP3";
          const trim = defaultTrimRange(first.duration);
          set((prev) => {
            const sameSource = preserveSettings && prev.urlMedia?.url === media.url;
            const activeIndex = sameSource && prev.activeMediaIndex < media.mediaItems.length
              ? prev.activeMediaIndex : 0;
            const active = media.mediaItems[activeIndex];
            const selected = sameSource
              ? prev.selectedMediaIds.filter((id) => media.mediaItems.some((item) => item.id === id))
              : [];
            return {
              ...prev,
              screen: "url",
              analyzing: false,
              analysisStage: null,
              urlMedia: media,
              activeMediaIndex: activeIndex,
              selectedMediaIds: sameSource ? selected : media.mediaItems.map((item) => item.id),
              localMedia: null,
              batch: null,
              inputWarning: null,
              format: sameSource && prev.urlMedia?.mediaItems[prev.activeMediaIndex]?.type === active.type
                ? prev.format : defaultOut,
              quality: sameSource && active.qualities.some((quality) => quality.id === prev.quality)
                ? prev.quality : active.qualities[0]?.id ?? "best",
              soundEnabled: sameSource ? prev.soundEnabled : true,
              clipEnabled: sameSource ? prev.clipEnabled : false,
              clipIn: sameSource ? prev.clipIn : formatTimestamp(trim.start),
              clipOut: sameSource ? prev.clipOut : formatTimestamp(trim.end),
              clipDurationPreset: sameSource ? prev.clipDurationPreset : trim.preset,
              clipTouched: sameSource ? prev.clipTouched : false,
              clipError: null,
              clipLabel: null,
              clipSeconds: null,
              aspect: sameSource ? prev.aspect : ASPECT_DEFAULT,
              flip: sameSource ? prev.flip : FLIP_NONE,
              previewSource: null,
              output: null,
              error: null,
            };
          });
        })
        .catch((e) => {
          if (generation === sourceGeneration.current)
            patch({ analyzing: false, analysisStage: null, screen: "error", error: ipc.toShiftError(e) });
        })
        .finally(() => { unlisten?.(); if (generation === sourceGeneration.current) pendingUrl.current = false; });
    },
    [patch],
  );

  const acceptFile = useCallback(
    (path: string) => {
      pendingUrl.current = false;
      const generation = ++sourceGeneration.current;
      lastInput.current = { kind: "file", value: path };
      patch({ analyzing: true, error: null, inputWarning: null, dragging: false });
      if (/\.pdf$/i.test(path)) {
        void ipc.importPdf(path).then(({ sourceName, pages }) => {
          if (generation !== sourceGeneration.current) return;
          const batch = appendImages(null, pages, []);
          set((prev) => ({ ...prev, screen: "batch", analyzing: false,
            localMedia: null, urlMedia: null, batch: { ...batch, name: sourceName, pdfSource: path },
            format: "PNG", compression: "none", aspect: ASPECT_DEFAULT, flip: FLIP_NONE,
            clipEnabled: false, clipError: null, clipSeconds: null,
            previewSource: null, previewError: null, output: null, error: null }));
        }).catch((error) => {
          if (generation === sourceGeneration.current)
            patch({ analyzing: false, screen: "error", error: ipc.toShiftError(error) });
        });
        return;
      }
      ipc
        .analyzeFile(path)
        .then((media) => {
          if (generation !== sourceGeneration.current) return;
          const defaultOut: OutputFormat =
            media.kind === "image" ? "JPG" : media.hasVideo ? "MP4" : "MP3";
          const trim = defaultTrimRange(media.duration);
          set((prev) => ({
            ...prev,
            screen: "local",
            analyzing: false,
            localMedia: media,
            batch: null,
            urlMedia: null,
            browserSession: "none",
            activeMediaIndex: 0,
            selectedMediaIds: [],
            format: media.outputs.includes(defaultOut) ? defaultOut : media.outputs[0],
            compression: "none",
            soundEnabled: true,
            clipEnabled: false,
            clipIn: formatTimestamp(trim.start),
            clipOut: formatTimestamp(trim.end),
            clipDurationPreset: trim.preset,
            clipTouched: false,
            clipError: null,
            clipLabel: null,
            clipSeconds: null,
            aspect: ASPECT_DEFAULT,
            flip: FLIP_NONE,
            previewSource: null,
            output: null,
            error: null,
          }));
        })
        .catch((e) => {
          if (generation === sourceGeneration.current)
            patch({ analyzing: false, screen: "error", error: ipc.toShiftError(e) });
        });
    },
    [patch],
  );

  const acceptPaths = useCallback(
    (paths: string[]) => {
      if (!paths.length || s.analyzing) return;
      pendingUrl.current = false;
      if (paths.some((path) => /\.pdf$/i.test(path)) && (paths.length !== 1 || !!s.batch)) {
        patch({ screen: "error", error: { code: "pdf_selection", message: "Open one PDF at a time.",
          hint: "Choose a single PDF to export its pages as images.", technical: null } });
        return;
      }
      if (paths.length === 1 && !s.batch) { acceptFile(paths[0]); return; }
      const generation = ++sourceGeneration.current;
      lastInput.current = null;
      patch({ analyzing: true, error: null, inputWarning: null, dragging: false });
      void (async () => {
        const media: LocalMedia[] = [];
        const skipped: ImageBatch["skipped"] = [];
        // Analyze in input order. One native decoder at a time keeps large drops responsive.
        for (const path of paths) {
          try {
            const result = await ipc.analyzeFile(path);
            if (result.kind === "image") media.push(result);
            else skipped.push({ path, reason: `${result.kind} is not a still image` });
          } catch (error) { skipped.push({ path, reason: ipc.toShiftError(error).message }); }
          if (generation !== sourceGeneration.current) return;
        }
        if (generation !== sourceGeneration.current) return;
        const current = s.batch;
        if (!current && media.length === 1) {
          acceptFile(media[0].path);
          if (skipped.length) patch({ inputWarning: `Skipped ${skipped.length} incompatible item${skipped.length === 1 ? "" : "s"}: ${skipped.map((entry) => `${entry.path.split("/").pop()} (${entry.reason})`).join("; ")}` });
          return;
        }
        if (!current && media.length < 2) {
          patch({ analyzing: false, screen: "error", error: { code: "batch_input", message: "Choose at least two compatible images for a batch.", hint: skipped.map((entry) => `${entry.path}: ${entry.reason}`).join("\n"), technical: null } });
          return;
        }
        set((prev) => {
          const batch = appendImages(prev.batch, media, skipped);
          const formats = commonFormats(batch);
          const format = prev.batch && formats.includes(prev.format) ? prev.format : formats[0] ?? "JPG";
          return { ...prev, analyzing: false, screen: "batch", batch, localMedia: null, urlMedia: null,
          format, compression: current && compressionOptions(format).some((option) => option.id === prev.compression) ? prev.compression : "none",
          aspect: ASPECT_DEFAULT, flip: FLIP_NONE,
          clipEnabled: false, clipError: null, clipSeconds: null,
          previewSource: null, previewError: null, inputWarning: null, output: null, error: null };
        });
      })();
    },
    [acceptFile, patch, s.batch, s.analyzing],
  );

  const openFilePicker = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Media",
          // Kept in step with VIDEO_EXTS / AUDIO_EXTS / IMAGE_EXTS in Rust.
          extensions: [
            "mp4", "mov", "webm", "mkv", "m4v", "avi",
            "mp3", "wav", "m4a", "aac", "flac", "aiff", "aif", "ogg", "opus",
            "heic", "heif", "jpg", "jpeg", "png", "webp", "avif", "gif", "pdf",
          ],
        },
      ],
    });
    if (typeof picked === "string") acceptPaths([picked]);
    else if (Array.isArray(picked)) acceptPaths(picked);
  }, [acceptPaths]);

  // ---- derived ------------------------------------------------------------
  const outputs = useMemo<OutputFormat[]>(() => {
    if (s.batch) return commonFormats(s.batch);
    if (s.screen === "url") {
      const kind = s.urlMedia?.mediaItems[s.activeMediaIndex]?.type;
      if (kind === "image") return ["JPG", "PNG", "WEBP", "AVIF"];
      if (kind === "audio") return ["MP3", "M4A", "WAV"];
      return URL_OUTPUTS;
    }
    return s.localMedia?.outputs ?? [];
  }, [s.screen, s.localMedia, s.urlMedia, s.activeMediaIndex, s.batch]);

  const activeMedia = s.urlMedia?.mediaItems[s.activeMediaIndex] ?? null;
  // A post with several items downloads its original files and is shown from
  // its thumbnails; nothing plays, so no preview is prepared for it.
  const multiPost = (s.urlMedia?.mediaItems.length ?? 0) > 1;
  const playbackInput = multiPost
    ? null
    : activeMedia && activeMedia.type !== "image"
    ? { kind: "url" as const, url: activeMedia.source, quality: s.quality, browserSession: s.browserSession }
    : s.localMedia && s.localMedia.kind !== "image"
      ? { kind: "local" as const, path: s.localMedia.path }
      : null;
  // Remote preparation begins as soon as URL detection succeeds. Local media
  // remains lazy because it is already immediately available from disk.
  const playback = usePlayback(
    playbackInput,
    !!playbackInput,
    activeMedia,
  );
  useEffect(() => {
    if (s.screen === "url" && (playback.errorDetails?.code === "youtube_bot_check"
      || (s.browserSession === "chrome" && playback.errorDetails?.code === "chrome_session_unavailable"))) {
      patch({ screen: "error", error: playback.errorDetails });
    }
  }, [s.screen, s.browserSession, playback.errorDetails, patch]);
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
  const showAspect = (sourceMoves || isImage) && !isAudioFormat(s.format) && s.format !== "PDF";
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
  const measuredSource = s.localMedia?.width && s.localMedia.height
    ? s.localMedia : activeMedia?.width && activeMedia.height ? activeMedia : playback.info;
  const sourceW = measuredSource?.width ?? null;
  const sourceH = measuredSource?.height ?? null;
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
  // The cached derivative is always the real opening frame. Its stable cache
  // key avoids a second extraction when playback later reports a duration.
  const localPath = s.localMedia?.hasVideo || s.localMedia?.kind === "image"
    ? s.localMedia.path
    : activeMedia?.type === "video" ? playback.info?.path ?? null : null;
  useEffect(() => {
    if (!localPath) {
      patch({ previewSource: null, previewError: null });
      return;
    }
    let live = true;
    ipc
      .previewSource(localPath, null)
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
  }, [localPath, patch]);

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

  // An untouched selection is the whole source, so it follows the duration as
  // better metadata arrives (provider estimate, then the player's measurement).
  useEffect(() => {
    if (s.clipTouched || duration == null || duration <= 0) return;
    set((prev) => {
      const range = defaultTrimRange(duration);
      if (prev.clipTouched || prev.clipIn === formatTimestamp(range.start) && prev.clipOut === formatTimestamp(range.end)) return prev;
      return { ...prev, ...trimFields(range) };
    });
  }, [s.clipTouched, duration]);

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
    (s.screen === "url" || s.screen === "local" || s.screen === "batch") &&
    (!s.clipEnabled || (!s.clipError && validatedClip === clipKey)) &&
    !loopTooLong &&
    !aspectInvalid &&
    (!s.urlMedia || s.urlMedia.mediaItems.length === 1 || s.selectedMediaIds.length > 0) &&
    (!s.batch || (selectedImages(s.batch).length > 0 && outputs.includes(s.format)));

  // ---- actions ------------------------------------------------------------
  /**
   * Export… — the ellipsis is literal: this opens the native Save panel and
   * nothing is processed until the user confirms it.
   */
  const startExport = useCallback(async () => {
    if (!canExport || savingRef.current) return;
    const generation = sourceGeneration.current;
    if (s.format === "PDF") {
      const sources = s.batch ? selectedImages(s.batch).map((item) => item.media.path)
        : s.localMedia?.kind === "image" ? [s.localMedia.path] : [];
      if (!sources.length) return;
      savingRef.current = true;
      setSaving(true);
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const folder = s.outputDir || await ipc.defaultOutputDir();
        const base = (s.batch?.name ?? s.localMedia?.name.replace(/\.[^.]+$/, "") ?? "images")
          .replace(/[/:]/g, "-");
        const chosen = await save({ defaultPath: `${folder}/${base}.pdf`,
          filters: [{ name: "PDF", extensions: ["pdf"] }] });
        if (typeof chosen !== "string" || !chosen) return;
        const directory = chosen.slice(0, chosen.lastIndexOf("/")) || folder;
        const saved = await ipc.setOutputDir(directory).catch(() => directory);
        if (generation !== sourceGeneration.current) return;
        const id = crypto.randomUUID();
        jobRef.current = id;
        patch({ screen: "processing", outputDir: saved, error: null, output: null,
          job: { id, state: "processing", stageLabel: `Creating PDF from ${sources.length} image${sources.length === 1 ? "" : "s"}…`,
            stageIndex: 0, stageCount: 1, progress: null, filename: `${base}.pdf` } });
        setSaving(false);
        const output = await ipc.exportPdf(sources, chosen, id);
        if (generation !== sourceGeneration.current) return;
        jobRef.current = null;
        patch({ screen: "complete", job: null, output });
      } catch (error) {
        if (generation === sourceGeneration.current) {
          jobRef.current = null;
          const failure = ipc.toShiftError(error);
          patch(failure.code === "cancelled" ? { screen: s.batch ? "batch" : "local", job: null }
            : { screen: "error", job: null, error: failure });
        }
      } finally { savingRef.current = false; setSaving(false); }
      return;
    }
    if (s.batch) {
      savingRef.current = true;
      setSaving(true);
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const chosen = await open({ multiple: false, directory: true, defaultPath: s.outputDir || undefined });
        if (typeof chosen !== "string" || !chosen) return;
        const items = selectedImages(s.batch);
        const run = { cancelled: false, itemId: null as string | null, resolve: null as ((event: JobEvent) => void) | null };
        batchRun.current = run;
        const saved = await ipc.setOutputDir(chosen).catch(() => chosen);
        if (generation !== sourceGeneration.current) return;
        patch({ screen: "processing", outputDir: saved, batch: { ...s.batch, destination: chosen,
          items: s.batch.items.map((item) => ({ ...item, status: "pending" as const, output: null, error: null })) },
          job: { id: "", state: "queued", stageLabel: `Converting 1 of ${items.length}`, stageIndex: 0, stageCount: 1, progress: null, filename: "" } });
        setSaving(false);
        for (const [index, item] of items.entries()) {
          if (run.cancelled || generation !== sourceGeneration.current) break;
          run.itemId = item.id;
          patch({ job: { id: "", state: "queued", stageLabel: `Converting ${index + 1} of ${items.length}`, stageIndex: 0, stageCount: 1, progress: null, filename: item.media.name } });
          const request: ExportRequest = {
            input: { kind: "local", path: item.media.path }, format: s.format,
            clip: null, sourceTitle: null, sourceHint: null, sourceDuration: null,
            outputDir: chosen, compression: s.compression, loopSize: null,
            aspect: null, soundEnabled: true, destinationPath: null,
            batchNaming: { base: s.batch.name, ordinal: s.batch.pdfSource
              ? s.batch.items.findIndex((entry) => entry.id === item.id) + 1 : index + 1 },
          };
          try {
            const finished = new Promise<JobEvent>((resolve) => { run.resolve = resolve; });
            awaitingJobId.current = true;
            const id = await ipc.startExport(request);
            awaitingJobId.current = false;
            if (generation !== sourceGeneration.current) { void ipc.cancelJob(id).catch(() => {}); break; }
            if (run.resolve) jobRef.current = id;
            else jobRef.current = null;
            if (run.cancelled) void ipc.cancelJob(id).catch(() => {});
            const event = await finished;
            if (event.state === "cancelled") run.cancelled = true;
            if (event.error && ["missing_dir", "not_a_dir", "missing_binary", "io_error"].includes(event.error.code)) run.cancelled = true;
          } catch (error) {
            awaitingJobId.current = false;
            run.resolve = null;
            const failure = ipc.toShiftError(error);
            set((prev) => prev.batch ? ({ ...prev, batch: { ...prev.batch,
              items: prev.batch.items.map((entry) => entry.id === item.id ? { ...entry, status: "failed", error: failure } : entry) } }) : prev);
          }
        }
        if (generation !== sourceGeneration.current) return;
        set((prev) => ({ ...prev, screen: "complete", job: null, batch: prev.batch ? { ...prev.batch,
          items: prev.batch.items.map((item) => item.status === "pending" ? { ...item, status: "cancelled" } : item) } : null }));
        batchRun.current = null;
      } catch (error) {
        if (generation === sourceGeneration.current) patch({ screen: "batch", error: ipc.toShiftError(error), job: null });
        batchRun.current = null;
      } finally { savingRef.current = false; setSaving(false); }
      return;
    }
    const selectedItems = s.urlMedia?.mediaItems.filter((item) =>
      s.selectedMediaIds.includes(item.id),
    ) ?? [];
    if (s.urlMedia && s.urlMedia.mediaItems.length > 1) {
      savingRef.current = true;
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
        setSaving(false);
        const result = await ipc.downloadPostItems(selectedItems, chosen, id, s.browserSession);
        if (generation !== sourceGeneration.current) return;
        jobRef.current = null;
        const saved = await ipc.setOutputDir(chosen).catch(() => chosen);
        if (generation !== sourceGeneration.current) return;
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
        if (generation !== sourceGeneration.current) return;
        jobRef.current = null;
        const error = ipc.toShiftError(e);
        if (error.code === "cancelled") {
          patch({ screen: "url", job: null });
        } else {
          patch({ screen: "error", error });
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
      return;
    }
    const item = selectedItems[0] ?? activeMedia;
    const input: ExportRequest["input"] | null = item
      ? { kind: "url", url: item.source, quality: s.quality, browserSession: s.browserSession }
      : s.localMedia
        ? { kind: "local", path: s.localMedia.path }
        : null;
    if (!input) return;

    const request: ExportRequest = {
      input,
      format: s.format,
      clip: s.clipEnabled && !isImage ? { start: s.clipIn, end: s.clipOut } : null,
      sourceTitle: item ? s.urlMedia?.title ?? null : null,
      sourceHint: item?.filenameHint ?? null,
      sourceDuration: isImage ? null : duration,
      outputDir: s.outputDir || null,
      compression: isImage ? s.compression : null,
      loopSize: isLoop ? s.loopSize : null,
      aspect: showAspect ? { ...s.aspect, flip: s.flip } : null,
      soundEnabled: s.soundEnabled,
      destinationPath: null,
    };

    savingRef.current = true;
    setSaving(true);
    try {
      // The backend owns the naming rules, so the panel is prefilled from it
      // rather than from a second copy of them over here.
      const prompt = await ipc.savePrompt(request);

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
      awaitingJobId.current = true;
      const id = await ipc.startExport({ ...request, destinationPath: chosen });
      awaitingJobId.current = false;
      if (generation !== sourceGeneration.current) {
        retiredJobs.current.add(id);
        void ipc.cancelJob(id).catch(() => {});
        return;
      }
      jobRef.current = id;
    } catch (e) {
      awaitingJobId.current = false;
      if (generation === sourceGeneration.current)
        patch({ screen: "error", error: ipc.toShiftError(e) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [canExport, s.batch, s.urlMedia, s.selectedMediaIds, activeMedia, s.localMedia, s.quality, s.browserSession, s.format, s.soundEnabled, s.clipEnabled, s.clipIn, s.clipOut, s.outputDir, s.compression, s.loopSize, s.aspect, s.flip, duration, isImage, isLoop, showAspect, patch]);

  const cancel = useCallback(() => {
    if (batchRun.current) batchRun.current.cancelled = true;
    const id = jobRef.current ?? s.job?.id;
    if (id) ipc.cancelJob(id).catch(() => {});
  }, [s.job]);

  const reset = useCallback(() => {
    if (saving) return;
    if (s.screen === "empty" && !s.analyzing && !lastInput.current && !s.batch) {
      document.querySelector<HTMLInputElement>('input[type="url"]')?.focus();
      return;
    }
    ++sourceGeneration.current;
    pendingUrl.current = false;
    cancel();
    batchRun.current?.resolve?.({ jobId: jobRef.current ?? "", state: "cancelled", stageLabel: "", stageIndex: 0, stageCount: 1, progress: null, outputFilename: "", output: null, error: null, actions: [] });
    batchRun.current = null;
    if (jobRef.current) retiredJobs.current.add(jobRef.current);
    awaitingJobId.current = false;
    void ipc.releaseUrlMedia(
      s.urlMedia?.mediaItems.flatMap((item) => item.thumbnailPath ? [item.thumbnailPath] : []) ?? [],
    ).catch(() => {});
    jobRef.current = null;
    lastInput.current = null;
    lockedFreeformRatio.current = null;
    set((prev) => ({
      ...initial,
      outputDir: prev.outputDir,
      health: prev.health,
      healthError: prev.healthError,
    }));
  }, [cancel, saving, s.screen, s.analyzing, s.urlMedia, s.batch]);

  const retry = useCallback(() => {
    if (s.batch && s.screen === "error") {
      patch({ screen: "batch", error: null });
      return;
    }
    const last = lastInput.current;
    if (!last) {
      reset();
      return;
    }
    if (last.kind === "url") submitUrl(last.value, s.browserSession);
    else acceptFile(last.value);
  }, [reset, submitUrl, acceptFile, s.browserSession, s.batch, s.screen, patch]);

  const retryWithChrome = useCallback(() => {
    const last = lastInput.current;
    const botCheck = (s.error?.code === "youtube_bot_check" || playback.errorCode === "youtube_bot_check") && s.browserSession === "none";
    const chromeFailure = s.error?.code === "chrome_session_unavailable" && s.browserSession === "chrome";
    if (last?.kind === "url" && (botCheck || chromeFailure)) {
      submitUrl(last.value, "chrome", true);
    }
  }, [submitUrl, s.error, s.browserSession, playback.errorCode]);


  const api: ShiftApi = {
    ...s,
    outputs,
    activeMedia,
    selectedMediaCount: s.selectedMediaIds.length,
    selectedBatchCount: s.batch ? selectedImages(s.batch).length : 0,
    showQuality,
    duration,
    canExport,
    playback,
    saving,
    lastInput: lastInput.current,
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
    setBatchName: (name) => set((prev) => prev.batch ? ({ ...prev, batch: { ...prev.batch, name } }) : prev),
    toggleBatchItem: (id) => set((prev) => {
      if (!prev.batch) return prev;
      const batch = toggleSelected(prev.batch, id);
      const formats = commonFormats(batch);
      const format = formats.includes(prev.format) ? prev.format : formats[0] ?? prev.format;
      return { ...prev, batch, format, compression: compressionOptions(format).some((option) => option.id === prev.compression) ? prev.compression : "none" };
    }),
    selectAllBatch: () => set((prev) => {
      if (!prev.batch) return prev;
      const batch = setAllSelected(prev.batch, true);
      const formats = commonFormats(batch);
      const format = formats.includes(prev.format) ? prev.format : formats[0] ?? prev.format;
      return { ...prev, batch, format, compression: compressionOptions(format).some((option) => option.id === prev.compression) ? prev.compression : "none" };
    }),
    deselectAllBatch: () => set((prev) => prev.batch ? ({ ...prev, batch: setAllSelected(prev.batch, false) }) : prev),
    removeBatchItem: (id) => set((prev) => {
      if (!prev.batch) return prev;
      const batch = removeImage(prev.batch, id);
      const formats = commonFormats(batch);
      const format = formats.includes(prev.format) ? prev.format : formats[0] ?? prev.format;
      return { ...prev, batch, format, compression: compressionOptions(format).some((option) => option.id === prev.compression) ? prev.compression : "none" };
    }),
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

        // A format choice does not turn on Trim. Long loops remain visibly
        // blocked until the user chooses a valid range themselves.
        return next;
      }),
    setCompression: (c) => patch({ compression: c }),
    setAspectRatio: (ratio) =>
      set((prev) => {
        // Moving to Freeform seeds the fields with the source's own size, so
        // the first thing shown is the truth rather than an empty box.
        if (ratio === "freeform" && prev.aspect.ratio !== "freeform") {
          lockedFreeformRatio.current = null;
          return {
            ...prev,
            aspectPreview: null,
            aspect: {
              ...prev.aspect,
              ratio,
              width: prev.aspect.width ?? sourceW,
              height: prev.aspect.height ?? sourceH,
              crop: null,
            },
          };
        }
        return { ...prev, aspect: { ...prev.aspect, ratio, crop: null }, aspectPreview: null };
      }),
    setFrameMode: (frame) => set((prev) => ({ ...prev, aspect: { ...prev.aspect, frame }, aspectPreview: null })),
    setAspectSize: (side, value) =>
      set((prev) => {
        const next = { ...prev.aspect, [side]: value };
        const sw = sourceW;
        const sh = sourceH;
        if (aspectLocked && value && sw && sh) {
          const ratio = lockedFreeformRatio.current ?? sw / sh;
          if (side === "width") next.height = Math.max(1, Math.round(value / ratio));
          else next.width = Math.max(1, Math.round(value * ratio));
        }
        if (next.frame === "fill" && next.ratio === "freeform" && sw && sh && next.width && next.height
          && next.width >= MIN_DIMENSION && next.height >= MIN_DIMENSION
          && next.width % 2 === 0 && next.height % 2 === 0
          && next.width <= sw && next.height <= sh) {
          const prior = prev.aspect.crop ? cropForSource(prev.aspect.crop, { w: sw, h: sh }) : null;
          const cx = prior ? prior.x + prior.width / 2 : sw / 2;
          const cy = prior ? prior.y + prior.height / 2 : sh / 2;
          const crop = centeredCrop({ w: sw, h: sh }, next.width, next.height);
          const maxX = sw - crop.width;
          const maxY = sh - crop.height;
          crop.x = Math.max(0, Math.min(maxX - maxX % 2, Math.round((cx - crop.width / 2) / 2) * 2));
          crop.y = Math.max(0, Math.min(maxY - maxY % 2, Math.round((cy - crop.height / 2) / 2) * 2));
          next.crop = { ...crop, sourceWidth: sw, sourceHeight: sh };
        } else next.crop = null;
        return { ...prev, aspect: next };
      }),
    setCropRect: (crop) => set((prev) => ({
      ...prev,
      aspect: {
        ...prev.aspect,
        crop: { ...crop, sourceWidth: sourceW ?? crop.sourceWidth, sourceHeight: sourceH ?? crop.sourceHeight },
        ...(prev.aspect.ratio === "freeform" ? { width: crop.width, height: crop.height } : {}),
      },
    })),
    toggleFlip: (axis) => set((prev) => ({ ...prev, flip: { ...prev.flip, [axis]: !prev.flip[axis] } })),
    toggleAspectLock: () => {
      if (!aspectLocked) {
        lockedFreeformRatio.current = s.aspect.crop
          ? s.aspect.crop.width / s.aspect.crop.height
          : s.aspect.width && s.aspect.height ? s.aspect.width / s.aspect.height : null;
      }
      setAspectLocked((v) => !v);
    },
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
          clipTouched: false,
          aspect: ASPECT_DEFAULT,
          flip: FLIP_NONE,
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
      set((prev) => duration == null || duration <= 0 ? prev : ({
        ...prev,
        clipEnabled: true,
        clipTouched: true,
        ...trimFields(applyTrimPreset(trimRangeFrom(prev, duration), preset, duration)),
      })),
    setClipIn: (v) =>
      set((prev) => {
        const seconds = parseTimestamp(v);
        if (seconds == null) return { ...prev, clipIn: v, clipTouched: true };
        const range = moveTrimStart(trimRangeFrom(prev, duration), seconds, duration);
        return {
          ...prev,
          clipTouched: true,
          ...trimFields(range),
          clipIn: Math.abs(range.start - seconds) < 0.0005 ? v : formatTimestamp(range.start),
        };
      }),
    setClipOut: (v) =>
      set((prev) => {
        const seconds = parseTimestamp(v);
        if (seconds == null) return { ...prev, clipOut: v, clipTouched: true };
        const range = resizeTrimEnd(trimRangeFrom(prev, duration), seconds, duration);
        return {
          ...prev,
          clipTouched: true,
          ...trimFields(range),
          clipOut: Math.abs(range.end - seconds) < 0.0005 ? v : formatTimestamp(range.end),
        };
      }),
    resizeClipIn: (seconds) =>
      set((prev) => ({
        ...prev,
        clipTouched: true,
        ...trimFields(resizeTrimStart(trimRangeFrom(prev, duration), seconds, duration)),
      })),
    resizeClipOut: (seconds) =>
      set((prev) => ({
        ...prev,
        clipTouched: true,
        ...trimFields(resizeTrimEnd(trimRangeFrom(prev, duration), seconds, duration)),
      })),
    moveClipRange: (start) =>
      set((prev) => ({
        ...prev,
        clipTouched: true,
        ...trimFields(moveTrimRange(trimRangeFrom(prev, duration), start, duration)),
      })),
    startExport: () => {
      void startExport();
    },
    cancel,
    reset,
    retry,
    retryWithChrome,
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useShift(): ShiftApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useShift must be used inside ShiftProvider");
  return ctx;
}
