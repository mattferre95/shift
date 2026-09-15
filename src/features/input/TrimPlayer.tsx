import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useShift } from "@/state/shift";
import { TRIM_DURATION_PRESETS } from "@/state/trim";
import { formatTimestamp, parseTimestamp } from "@/lib/format";
import { TimeField } from "@/components/TimeField";

export function TrimPlayer() {
  const s = useShift();
  const { info, busy, error, status, cancel, retry, fallback, markReady } = s.playback;
  const media = useRef<HTMLVideoElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const rangeDrag = useRef<{ pointerId: number; x: number; start: number; width: number } | null>(null);
  const selection = useRef(false);
  const reportedReady = useRef(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
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
  const scale = box ? Math.min(420 / box.canvasWidth, 180 / box.canvasHeight) : 1;
  const pct = (n: number) => `${Math.max(0, Math.min(100, n / (total || 1) * 100))}%`;
  const button = "rounded-md bg-shift-chip px-3 py-2 text-[11px] text-shift-body hover:bg-shift-chip-hi disabled:opacity-40";
  return <section aria-label="Trim player" className="min-w-0" onKeyDown={(e) => {
    if (e.code === "Space" && !["INPUT", "TEXTAREA", "BUTTON"].includes((e.target as HTMLElement).tagName)) { e.preventDefault(); void play(); }
  }} tabIndex={0}>
    <div className="mb-2 flex items-center justify-between text-[11px] text-shift-muted">
      <span>{info?.hasVideo ? "VIDEO PREVIEW" : "AUDIO PREVIEW"}</span>
      {status && <span>{status === "resolving" ? "Resolving link" : status === "downloading" ? "Downloading preview" : status === "preparing" ? "Preparing player" : "Ready"}</span>}
      {info?.proxy && <span>Preview copy · original used for export</span>}
    </div>
    {busy ? <div className="flex h-[120px] items-center justify-center gap-4 text-shift-muted" role="status"><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border border-shift-quiet border-t-shift-emerald" />{status === "resolving" ? "Resolving link" : status === "downloading" ? "Downloading preview" : "Preparing player"}<button className={button} onClick={cancel}>Cancel</button></div>
      : error ? <div role="status" className="my-5 text-[12px] text-shift-muted">{error} <button className={button} onClick={retry}>Retry preview</button></div>
      : info && <div className={info.hasVideo ? "mb-2 flex h-[180px] items-center justify-center overflow-hidden rounded-md bg-black" : ""}>
        <div style={info.hasVideo ? box ? { position: "relative", overflow: "hidden", width: box.canvasWidth * scale, height: box.canvasHeight * scale } : { width: "100%", height: "100%" } : { height: 0, overflow: "hidden" }}>
          <video ref={media} src={convertFileSrc(info.path)} preload="auto" playsInline
            aria-label={info.hasVideo ? "Media preview" : "Audio playback"}
            style={box && info.hasVideo ? { position: "absolute", maxWidth: "none", width: `${box.frameWidth / box.canvasWidth * 100}%`, height: `${box.frameHeight / box.canvasHeight * 100}%`, left: `${box.offsetX / box.canvasWidth * 100}%`, top: `${box.offsetY / box.canvasHeight * 100}%` } : { width: "100%", height: "100%", objectFit: "contain" }}
            onLoadedMetadata={playerReady} onCanPlay={playerReady} onError={() => void fallback()}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => {setPlaying(false); selection.current = false;}}
            onTimeUpdate={() => { const el = media.current; if (!el) return; if (selection.current && el.currentTime >= endRef.current) { el.pause(); el.currentTime = endRef.current; selection.current = false; } setTime(el.currentTime); }} />
        </div>
      </div>}
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <button className={button} disabled={!ready || busy || !!error} onClick={() => void play()} aria-label={playing ? "Pause" : "Play"}>{playing ? "Pause" : "Play"}</button>
      <button className={button} disabled={!ready || !valid || busy || !!error} onClick={() => void play(true)}>Play Selection</button>
      <span className="ml-auto font-mono text-[11px] text-shift-muted">{formatTimestamp(time)} / {formatTimestamp(total)}</span>
    </div>
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="mr-1 text-[10px] tracking-[0.08em] text-shift-label">DURATION</span>
      {TRIM_DURATION_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          aria-pressed={s.clipDurationPreset === preset.id}
          onClick={() => s.setClipDurationPreset(preset.id)}
          className={[
            "rounded-md border px-[10px] py-[5px] text-[11px] font-medium transition-colors duration-[140ms]",
            s.clipDurationPreset === preset.id
              ? "border-[var(--emerald-edge)] bg-[var(--emerald-tint)] text-[oklch(0.90_0.05_155)]"
              : "border-[var(--hairline-strong)] bg-shift-chip text-shift-dim hover:bg-shift-chip-hi hover:text-shift-body",
          ].join(" ")}
        >
          {preset.label}
        </button>
      ))}
    </div>
    <div ref={timeline} className="relative mb-3 h-12" aria-label="Selected range">
      <div className="absolute inset-x-0 top-8 h-2 rounded bg-shift-track" />
      {valid && (
        <>
          <div className="pointer-events-none absolute top-8 z-10 h-2 rounded bg-shift-emerald/40" style={{ left: pct(start), width: pct(end - start) }} />
          <button
            type="button"
            aria-label="Move selection"
            title="Drag to move the selected range"
            className="trim-window group absolute top-5 z-20 h-7 min-w-7 -translate-x-1/2 touch-none"
            style={{ left: pct((start + end) / 2), width: pct(end - start) }}
            onPointerDown={beginRangeDrag}
            onPointerMove={dragRange}
            onPointerUp={endRangeDrag}
            onPointerCancel={endRangeDrag}
          >
            <span className="absolute left-1/2 top-[11px] h-2 w-[3px] -translate-x-1/2 rounded bg-shift-emerald/70 opacity-70 transition-opacity group-hover:opacity-100" />
          </button>
        </>
      )}
      <span className="pointer-events-none absolute top-0 z-40 text-[10px] text-shift-emerald" style={{left:pct(start),transform:"translateX(-50%)"}}>IN</span>
      <span className="pointer-events-none absolute top-0 z-40 text-[10px] text-shift-emerald" style={{left:pct(end),transform:"translateX(-50%)"}}>OUT</span>
      <input className="trim-seek absolute inset-x-0 top-6 z-10 h-6 w-full" type="range" aria-label="Seek playback" min={0} max={total || 1} step={0.001} value={Math.min(time,total)} disabled={!ready} onChange={(e) => seek(Number(e.target.value))} />
      <input className="trim-bound absolute inset-x-0 top-6 z-30 h-6 w-full" aria-label="IN marker" type="range" min={0} max={total || 1} step={0.001} value={Math.min(start,total)} disabled={!total} onChange={(e) => resize("in",Number(e.target.value))} />
      <input className="trim-bound absolute inset-x-0 top-6 z-30 h-6 w-full" aria-label="OUT marker" type="range" min={0} max={total || 1} step={0.001} value={Math.min(end,total)} disabled={!total} onChange={(e) => resize("out",Number(e.target.value))} />
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <TimeField label="IN" value={s.clipIn} onChange={s.setClipIn} invalid={!!s.clipError} />
      <button className={button} disabled={!ready || busy || !!error} onClick={() => s.setClipIn(formatTimestamp(time))}>Set IN</button>
      <TimeField label="OUT" value={s.clipOut} onChange={s.setClipOut} invalid={!!s.clipError} />
      <button className={button} disabled={!ready || busy || !!error} onClick={() => s.setClipOut(formatTimestamp(time))}>Set OUT</button>
    </div>
    <div className={`mt-2 text-[11px] ${s.clipError ? "text-shift-danger" : "text-shift-muted"}`} role="status">{s.clipError ?? playError ?? (s.clipLabel ? `${s.clipLabel} selected` : "Choose a range")}</div>
  </section>;
}
