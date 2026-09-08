import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useShift } from "@/state/shift";
import { formatTimestamp, parseTimestamp } from "@/lib/format";
import { TimeField } from "@/components/TimeField";

export function TrimPlayer() {
  const s = useShift();
  const { info, busy, error, status, cancel, retry, fallback, markReady } = s.playback;
  const media = useRef<HTMLVideoElement>(null);
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
  const change = (which: "in" | "out", value: number) => {
    selection.current = false;
    if (which === "in") s.setClipIn(formatTimestamp(Math.max(0, Math.min(end - 0.001, value))));
    else s.setClipOut(formatTimestamp(Math.min(total, Math.max(start + 0.001, value))));
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
    <div className="relative mb-3 h-10" aria-label="Selected range">
      <div className="absolute inset-x-0 top-7 h-2 rounded bg-shift-track" />
      {valid && <div className="absolute top-7 h-2 bg-shift-emerald/40" style={{left:pct(start),width:pct(end-start)}} />}
      <span className="absolute top-0 text-[10px] text-shift-emerald" style={{left:pct(start),transform:"translateX(-50%)"}}>IN</span>
      <span className="absolute top-0 text-[10px] text-shift-emerald" style={{left:pct(end),transform:"translateX(-50%)"}}>OUT</span>
      <input className="trim-seek absolute inset-x-0 top-5 h-6 w-full" type="range" aria-label="Seek playback" min={0} max={total || 1} step={0.001} value={Math.min(time,total)} disabled={!ready} onChange={(e) => seek(Number(e.target.value))} />
      <input className="trim-bound absolute inset-x-0 top-5 h-6 w-full" aria-label="IN marker" type="range" min={0} max={total || 1} step={0.001} value={Math.min(start,total)} disabled={!total} onChange={(e) => change("in",Number(e.target.value))} />
      <input className="trim-bound absolute inset-x-0 top-5 h-6 w-full" aria-label="OUT marker" type="range" min={0} max={total || 1} step={0.001} value={Math.min(end,total)} disabled={!total} onChange={(e) => change("out",Number(e.target.value))} />
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <TimeField label="IN" value={s.clipIn} onChange={s.setClipIn} invalid={!!s.clipError} />
      <button className={button} disabled={!ready || busy || !!error} onClick={() => change("in",time)}>Set IN</button>
      <TimeField label="OUT" value={s.clipOut} onChange={s.setClipOut} invalid={!!s.clipError} />
      <button className={button} disabled={!ready || busy || !!error} onClick={() => change("out",time)}>Set OUT</button>
    </div>
    <div className={`mt-2 text-[11px] ${s.clipError ? "text-shift-danger" : "text-shift-muted"}`} role="status">{s.clipError ?? playError ?? (s.clipLabel ? `${s.clipLabel} selected` : "Choose a range")}</div>
  </section>;
}
