import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useShift } from "@/state/shift";
import { TRIM_DURATION_PRESETS, type TrimDurationPreset } from "@/state/trim";
import { formatMediaTime, formatTimestamp, parseTimestamp } from "@/lib/format";
import { TimeField } from "@/components/TimeField";
import { Segmented } from "@/components/Segmented";
import { Spinner } from "@/components/Spinner";

/** Half the width of a range thumb: where the browser centres the 0% and 100% thumbs. */
const HALF_THUMB = 9;

/**
 * The player and the trim range. All of the range arithmetic lives in
 * `state/trim.ts`; this only reads the range and calls the existing setters.
 *
 * Layout: the preview takes whatever height is left, the controls sit in one
 * panel beneath it. `header` lets the Edit view put its Trim switch on top.
 */
export function TrimPlayer({ header }: { header?: ReactNode }) {
  const s = useShift();
  const { info, busy, error, status, cancel, retry, fallback, markReady } = s.playback;
  const media = useRef<HTMLVideoElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const rangeDrag = useRef<{ pointerId: number; x: number; start: number; width: number } | null>(null);
  const selection = useRef(false);
  const reportedReady = useRef(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  const total = s.duration ?? 0;
  const start = parseTimestamp(s.clipIn) ?? 0;
  const end = parseTimestamp(s.clipOut) ?? total;
  const valid = !s.clipError && start >= 0 && end > start && end <= total + 0.001;
  const endRef = useRef(end);
  endRef.current = end;
  useEffect(() => {
    setTime(0); setPlaying(false); setReady(false); selection.current = false; reportedReady.current = false; setPlayError(null);
  }, [info?.path]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const el = media.current;
      if (!el) return;
      if (selection.current && el.currentTime >= endRef.current) {
        el.pause(); el.currentTime = endRef.current; selection.current = false;
      }
      setTime(el.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  // The framed preview is sized from the room the stage actually has.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setStageSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const seek = (value: number) => {
    const el = media.current;
    if (!el || !ready) return;
    selection.current = false;
    el.currentTime = Math.max(0, Math.min(total, value)); setTime(el.currentTime);
  };
  const playerReady = () => {
    setReady(true);
    if (!reportedReady.current) { reportedReady.current = true; markReady(); }
  };
  const play = async (selected = false) => {
    const el = media.current;
    if (!el || !ready) return;
    setPlayError(null);
    if (!selected && !el.paused) { el.pause(); selection.current = false; return; }
    selection.current = selected;
    if (selected) el.currentTime = start;
    else if (el.ended || el.currentTime >= total) el.currentTime = 0;
    try { await el.play(); } catch { selection.current = false; setPlayError("Playback couldn't start. Try again."); }
  };
  const resize = (which: "in" | "out", value: number) => {
    selection.current = false;
    if (which === "in") s.resizeClipIn(value);
    else s.resizeClipOut(value);
  };
  const beginRangeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const bounds = timeline.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || !valid || total <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    selection.current = false;
    rangeDrag.current = { pointerId: event.pointerId, x: event.clientX, start, width: bounds.width };
  };
  const dragRange = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = rangeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    s.moveClipRange(drag.start + ((event.clientX - drag.x) / drag.width) * total);
  };
  const endRangeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (rangeDrag.current?.pointerId === event.pointerId) rangeDrag.current = null;
  };

  const p = s.showAspect ? s.aspectPreview : null;
  const box = p?.content;
  const fit = box && stageSize ? Math.min(stageSize.w / box.canvasWidth, stageSize.h / box.canvasHeight) : null;
  const pct = (n: number) => `${Math.max(0, Math.min(100, n / (total || 1) * 100))}%`;
  const statusLabel = status === "resolving" ? "Resolving link" : status === "downloading" ? "Downloading preview" : status === "preparing" ? "Preparing player" : "Ready";
  const transport = "flex h-8 items-center justify-center gap-[6px] rounded-[8px] border border-[var(--hairline-strong)] bg-[image:var(--control-gradient)] px-3 text-[12.5px] font-medium text-shift-text transition-colors duration-[140ms] enabled:hover:border-[var(--hairline-bright)] disabled:cursor-not-allowed disabled:opacity-40";
  const message = s.clipError ?? playError ?? (s.clipSeconds != null ? `${formatMediaTime(s.clipSeconds)} selected` : "Choose a range");

  return <section aria-label="Trim player" className="flex min-h-0 flex-1 flex-col gap-3 outline-none" onKeyDown={(e) => {
    if (e.code === "Space" && !["INPUT", "TEXTAREA", "BUTTON"].includes((e.target as HTMLElement).tagName)) { e.preventDefault(); void play(); }
  }} tabIndex={0}>
    {/* ---- preview ---------------------------------------------------- */}
    <div className="relative flex min-h-[130px] flex-1 overflow-hidden rounded-[14px] border border-[var(--hairline)] bg-black">
      <span className="pointer-events-none absolute left-[10px] top-[10px] z-10 rounded-[6px] bg-[var(--scrim)] px-2 py-[3px] font-mono text-[10px] tracking-[0.06em] text-shift-dim">
        {info?.hasVideo === false ? "AUDIO PREVIEW" : "VIDEO PREVIEW"}
      </span>
      {status && !busy && status !== "ready" && (
        <span className="pointer-events-none absolute right-[10px] top-[10px] z-10 rounded-[6px] bg-[var(--scrim)] px-2 py-[3px] text-[11px] text-shift-dim">{statusLabel}</span>
      )}
      <div ref={stage} className="absolute inset-0 flex items-center justify-center p-[2px]">
        {busy ? (
          <div className="flex items-center gap-3 text-[13px] text-shift-dim" role="status">
            <Spinner />
            {statusLabel}…
            <button type="button" className={transport} onClick={cancel}>Cancel</button>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 px-6 text-center text-[13px] text-shift-dim">
            <span>{error}</span>
            <button type="button" className={transport} onClick={retry}>Retry Preview</button>
          </div>
        ) : info && (
          <div
            className={info.hasVideo ? "flex h-full w-full items-center justify-center" : "flex flex-col items-center gap-2 text-shift-soft"}
          >
            {!info.hasVideo && (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" /></svg>
            )}
            <div style={info.hasVideo ? box && fit ? { position: "relative", overflow: "hidden", width: box.canvasWidth * fit, height: box.canvasHeight * fit } : { width: "100%", height: "100%" } : { height: 0, overflow: "hidden" }}>
              <video ref={media} src={convertFileSrc(info.path)} preload="auto" playsInline
                muted={!s.soundEnabled}
                aria-label={info.hasVideo ? "Media preview" : "Audio playback"}
                style={box && fit && info.hasVideo ? { position: "absolute", maxWidth: "none", width: `${box.frameWidth / box.canvasWidth * 100}%`, height: `${box.frameHeight / box.canvasHeight * 100}%`, left: `${box.offsetX / box.canvasWidth * 100}%`, top: `${box.offsetY / box.canvasHeight * 100}%` } : { width: "100%", height: "100%", objectFit: "contain" }}
                onLoadedMetadata={playerReady} onCanPlay={playerReady} onError={() => void fallback()}
                onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => {setPlaying(false); selection.current = false;}}
                onTimeUpdate={() => { const el = media.current; if (!el) return; if (selection.current && el.currentTime >= endRef.current) { el.pause(); el.currentTime = endRef.current; selection.current = false; } setTime(el.currentTime); }} />
            </div>
            {!info.hasVideo && <span className="text-[12px]">Audio</span>}
          </div>
        )}
      </div>
      {info?.proxy && (
        <span className="pointer-events-none absolute bottom-[10px] left-3 z-10 rounded-[6px] bg-[var(--scrim)] px-2 py-[3px] text-[11px] text-shift-dim">
          Preview copy · original used for export
        </span>
      )}
    </div>

    {/* ---- controls --------------------------------------------------- */}
    <div className="shift-panel flex shrink-0 flex-col gap-3 p-3">
      {header}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={transport.replace("px-3", "w-9 px-0")} disabled={!ready || busy || !!error} onClick={() => void play()} aria-label={playing ? "Pause" : "Play"}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d={playing ? "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" : "M7 4.5v15l13-7.5z"} />
          </svg>
        </button>
        <button type="button" className={transport} disabled={!ready || !valid || busy || !!error} onClick={() => void play(true)}>Play Selection</button>
        <span className="ml-auto font-mono text-[12px] text-shift-dim">{formatMediaTime(time)} / {formatMediaTime(total)}</span>
      </div>

      {/* The inputs span the whole row; everything drawn sits in a track inset by
          half a thumb, so the visible handles land exactly under the hit areas. */}
      <div className="relative h-[52px] select-none" aria-label="Selected range">
        <div ref={timeline} className="absolute bottom-[8px] top-0" style={{ left: HALF_THUMB, right: HALF_THUMB }}>
          <div className="absolute inset-x-0 bottom-0 top-[14px] rounded-[8px] border border-[var(--hairline)] bg-shift-input" />
          {valid && (
            <>
              <div
                className="pointer-events-none absolute bottom-0 top-[14px] z-10 rounded-[6px] border-2 border-shift-accent bg-[var(--accent-veil)]"
                style={{ left: pct(start), width: pct(end - start) }}
              />
              <button
                type="button"
                aria-label="Move selection"
                title="Drag to move the selected range"
                className="trim-window group absolute bottom-0 top-[14px] z-20 min-w-7 -translate-x-1/2 touch-none"
                style={{ left: pct((start + end) / 2), width: pct(end - start) }}
                onPointerDown={beginRangeDrag}
                onPointerMove={dragRange}
                onPointerUp={endRangeDrag}
                onPointerCancel={endRangeDrag}
              >
                <span className="absolute left-1/2 top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded bg-[var(--accent-edge)] opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </>
          )}
          <Handle at={pct(start)} label="IN" />
          <Handle at={pct(end)} label="OUT" />
          {ready && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-[-3px] top-[11px] z-30 w-[2px] -translate-x-1/2 rounded-full bg-shift-text shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
              style={{ left: pct(Math.min(time, total)) }}
            />
          )}
        </div>
        <input className="trim-seek absolute inset-x-0 top-[14px] z-10 h-[30px] w-full" type="range" aria-label="Seek playback" min={0} max={total || 1} step={0.001} value={Math.min(time,total)} disabled={!ready} onChange={(e) => seek(Number(e.target.value))} />
        <input className="trim-bound absolute inset-x-0 top-[14px] z-30 h-[30px] w-full" aria-label="IN marker" type="range" min={0} max={total || 1} step={0.001} value={Math.min(start,total)} disabled={!total} onChange={(e) => resize("in",Number(e.target.value))} />
        <input className="trim-bound absolute inset-x-0 top-[14px] z-30 h-[30px] w-full" aria-label="OUT marker" type="range" min={0} max={total || 1} step={0.001} value={Math.min(end,total)} disabled={!total} onChange={(e) => resize("out",Number(e.target.value))} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex min-w-0 items-end gap-2">
          <TimeField fill label="IN" displayValue={formatMediaTime(start)} onChange={s.setClipIn} invalid={!!s.clipError} />
          <button type="button" className={transport.replace("px-3", "px-[10px]")} disabled={!ready || busy || !!error} onClick={() => s.setClipIn(formatTimestamp(time))}>Set IN</button>
        </div>
        <div className="flex min-w-0 items-end gap-2">
          <TimeField fill label="OUT" displayValue={formatMediaTime(end)} onChange={s.setClipOut} invalid={!!s.clipError} />
          <button type="button" className={transport.replace("px-3", "px-[10px]")} disabled={!ready || busy || !!error} onClick={() => s.setClipOut(formatTimestamp(time))}>Set OUT</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-[240px]">
          <Segmented<TrimDurationPreset>
            label="Duration"
            options={TRIM_DURATION_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))}
            value={s.clipDurationPreset}
            onChange={s.setClipDurationPreset}
          />
        </div>
        {s.clipDurationPreset !== "custom" && (
          <span className="flex items-center gap-[6px] text-[11.5px] text-shift-soft">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
            OUT follows IN
          </span>
        )}
      </div>

      <div className={`text-[12px] ${s.clipError ? "text-shift-danger" : "text-shift-dim"}`} role="status">{message}</div>
    </div>
  </section>;
}

/** A visible trim handle. The draggable part is the range input's thumb above it. */
function Handle({ at, label }: { at: string; label: string }) {
  return (
    <>
      <span aria-hidden="true" className="pointer-events-none absolute top-0 z-20 -translate-x-1/2 text-[10px] font-semibold text-shift-link" style={{ left: at }}>
        {label}
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 top-[14px] z-20 flex w-[8px] -translate-x-1/2 items-center justify-center rounded-[3px] bg-shift-accent shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
        style={{ left: at }}
      >
        <span className="h-3 w-[2px] rounded bg-white/80" />
      </span>
    </>
  );
}
