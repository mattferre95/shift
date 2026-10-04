/**
 * Words for the export as it is currently configured.
 *
 * Read-only views over the one export state: nothing here decides what is sent,
 * it only says what `startExport` will send, and why it would refuse.
 */
import { formatMediaTime, parseTimestamp } from "@/lib/format";
import type { useShift } from "@/state/shift";
import {
  aspectLabel,
  isAnimationFormat,
  isAudioFormat,
  LOOP_SIZES,
  MAX_DIMENSION,
  MIN_DIMENSION,
} from "@/types";

type Shift = ReturnType<typeof useShift>;

/** One applied setting, for the inspector's summary rows. */
export interface ExportSetting {
  label: string;
  value: string;
  /** The same fact as a short phrase, for one-line summaries. */
  phrase: string;
}

/**
 * The settings that will be applied on top of the chosen format. Only what is
 * actually active is listed; a default is never shown as a choice.
 */
export function exportSettings(s: Shift): ExportSetting[] {
  const out: ExportSetting[] = [];
  if (s.clipEnabled && !s.isImage) {
    const start = parseTimestamp(s.clipIn);
    const end = parseTimestamp(s.clipOut);
    if (start != null && end != null) {
      const range = `${formatMediaTime(start)}–${formatMediaTime(end)}`;
      out.push({ label: "Trim", value: range, phrase: `Trim ${range}` });
    }
  }
  if (s.showAspect && s.aspect.ratio !== "original") {
    const frame = s.aspect.frame === "fill" ? "Fill" : "Fit";
    const shape =
      s.aspect.ratio === "freeform" && s.aspect.width && s.aspect.height
        ? `${s.aspect.width} × ${s.aspect.height}`
        : aspectLabel(s.aspect.ratio);
    out.push({ label: "Aspect", value: `${shape} ${frame}`, phrase: `${shape} ${frame}` });
  }
  if (s.isLoop) {
    const size = LOOP_SIZES.find((l) => l.id === s.loopSize);
    if (size) out.push({ label: "Loop", value: size.label, phrase: `${size.label} loop` });
  }
  if (soundApplies(s) && sourceHasAudio(s) && !s.soundEnabled) {
    out.push({ label: "Sound", value: "Off", phrase: "Sound off" });
  }
  if (s.isImage && s.compression !== "none") {
    const c = s.compressionChoices.find((o) => o.id === s.compression);
    if (c) out.push({ label: "Compression", value: c.label, phrase: `${c.label} compression` });
  }
  return out;
}

/** The modifiers set in other modes, as short phrases. */
export function exportModifiers(s: Shift): string[] {
  return exportSettings(s).map((x) => x.phrase);
}

/** The rule that decides whether the Sound control is shown at all. */
export function soundApplies(s: Shift): boolean {
  return s.sourceMoves && !s.isImage && !isAudioFormat(s.format) && !isAnimationFormat(s.format);
}

/** Whether the source has sound, or null while that is still unknown. */
export function sourceHasAudio(s: Shift): boolean | null {
  return s.localMedia?.hasAudio ?? s.playback.info?.hasAudio ?? null;
}

/** The words that go with a loop output: what it is, and what limits it. */
export function loopNote(s: Shift): { detail: string; warning: string | null; blocking: boolean } {
  const size = LOOP_SIZES.find((l) => l.id === s.loopSize)?.detail ?? "";
  const name = s.format === "GIF" ? "GIF" : "Animated WEBP";
  // Why, not just what — the limit is a file-size consequence, not a rule.
  const reason =
    s.format === "GIF" ? "every frame is a whole image, so length becomes file size" : "long loops get large";
  return {
    detail: `${size} · silent · loops forever. Never upscaled past the source.`,
    warning: s.loopTooLong
      ? `${name} exports are limited to ${s.loopMaxSeconds} seconds — ${reason}. Shorten the range to fit.`
      : // Stated as the rule, not as something SHIFT did: the range may well be
        // one the user set themselves.
        s.loopNeedsTrim
        ? `${name} exports are limited to ${s.loopMaxSeconds} seconds.`
        : null,
    blocking: s.loopTooLong,
  };
}

/**
 * Why Export is unavailable, when there is something the user can do about it.
 * Mirrors the conditions in `canExport`; transient ones (a check still running)
 * return null rather than a message that would flicker.
 */
export function exportBlocker(s: Shift): string | null {
  if (s.analyzing) return null;
  if (s.clipEnabled && s.clipError) return s.clipError;
  if (s.loopTooLong) {
    const name = s.format === "GIF" ? "GIF" : "Animated WEBP";
    return `${name} exports are limited to ${s.loopMaxSeconds} seconds. Shorten the range in Edit.`;
  }
  if (
    s.showAspect &&
    s.aspect.ratio === "freeform" &&
    [s.aspect.width, s.aspect.height].some((v) => v == null || v < MIN_DIMENSION || v > MAX_DIMENSION)
  ) {
    return `Set a size between ${MIN_DIMENSION} and ${MAX_DIMENSION} pixels in Resize.`;
  }
  if (s.urlMedia && s.urlMedia.mediaItems.length > 1 && s.selectedMediaCount === 0) {
    return "Select at least one item to download.";
  }
  return null;
}

/** The primary action's words. The ellipsis is literal: a native panel opens. */
export function exportActionLabel(s: Shift): string {
  return s.clipEnabled && !s.isImage ? "Export Clip…" : s.screen === "url" ? "Download…" : "Export…";
}
