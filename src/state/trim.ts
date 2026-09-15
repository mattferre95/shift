export type TrimDurationPreset = 10 | 15 | 30 | 60 | "custom";

export const DEFAULT_TRIM_DURATION: TrimDurationPreset = 15;
export const TRIM_DURATION_PRESETS: { id: TrimDurationPreset; label: string }[] = [
  { id: 10, label: "10s" },
  { id: 15, label: "15s" },
  { id: 30, label: "30s" },
  { id: 60, label: "1m" },
  { id: "custom", label: "Custom" },
];

export interface TrimRange {
  start: number;
  end: number;
  preset: TrimDurationPreset;
}

const MIN_RANGE = 0.001;
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));
const mediaEnd = (duration: number | null) =>
  duration != null && duration >= 0 ? duration : Number.POSITIVE_INFINITY;

export function defaultTrimRange(duration: number | null): TrimRange {
  return applyTrimPreset({ start: 0, end: 0, preset: DEFAULT_TRIM_DURATION }, DEFAULT_TRIM_DURATION, duration);
}

export function applyTrimPreset(
  range: TrimRange,
  preset: TrimDurationPreset,
  duration: number | null,
): TrimRange {
  if (preset === "custom") return { ...range, preset };
  const limit = mediaEnd(duration);
  const start = clamp(range.start, 0, limit);
  return { start, end: Math.min(limit, start + preset), preset };
}

export function moveTrimStart(
  range: TrimRange,
  value: number,
  duration: number | null,
): TrimRange {
  const limit = mediaEnd(duration);
  if (range.preset !== "custom") {
    const start = clamp(value, 0, limit);
    return { ...range, start, end: Math.min(limit, start + range.preset) };
  }
  return { ...range, start: clamp(value, 0, range.end - MIN_RANGE) };
}

export function resizeTrimStart(
  range: TrimRange,
  value: number,
): TrimRange {
  const start = clamp(value, 0, range.end - MIN_RANGE);
  const changedDuration = Math.abs((range.end - start) - (range.end - range.start)) >= MIN_RANGE;
  return { ...range, start, preset: changedDuration ? "custom" : range.preset };
}

export function resizeTrimEnd(
  range: TrimRange,
  value: number,
  duration: number | null,
): TrimRange {
  const limit = mediaEnd(duration);
  const end = clamp(value, Math.min(limit, range.start + MIN_RANGE), limit);
  const changedDuration = Math.abs((end - range.start) - (range.end - range.start)) >= MIN_RANGE;
  return { ...range, end, preset: changedDuration ? "custom" : range.preset };
}

export function moveTrimRange(
  range: TrimRange,
  value: number,
  duration: number | null,
): TrimRange {
  const length = Math.max(MIN_RANGE, range.end - range.start);
  const limit = mediaEnd(duration);
  const maxStart = Number.isFinite(limit) ? Math.max(0, limit - length) : Number.POSITIVE_INFINITY;
  const start = clamp(value, 0, maxStart);
  return { ...range, start, end: start + length };
}
