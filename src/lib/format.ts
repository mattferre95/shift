/** Display helpers. Nothing here influences what the backend is asked to do. */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * `00:05` / `65:04` — the one user-facing clock used by media and trim UI.
 * Minutes deliberately keep growing past 59; fractional precision stays in
 * state and export requests rather than leaking into the compact display.
 */
export function formatMediaTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Compact media length, kept as an alias for existing non-player call sites. */
export function formatDuration(seconds: number | null | undefined): string {
  return formatMediaTime(seconds);
}

/** Precise transport value used by validation and export, never as UI copy. */
export function formatTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad = (v: number, n = 2) => String(v).padStart(n, "0");
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
    : `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** Best-effort local parse, only used to draw the clip range bar. */
export function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length === 0 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0 || part.trim() === "") return null;
    total = total * 60 + n;
  }
  return total;
}

export function resolutionLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  return `${width} × ${height}`;
}
