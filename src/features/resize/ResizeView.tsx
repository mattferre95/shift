import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Field, Inspector, SummaryRow } from "@/components/Panel";
import { Segmented } from "@/components/Segmented";
import { SizeField } from "@/components/SizeField";
import { exportActionLabel, exportBlocker, exportSettings } from "@/features/export/summary";
import { useShift } from "@/state/shift";
import {
  ASPECT_ROWS,
  aspectLabel,
  MAX_DIMENSION,
  MIN_DIMENSION,
  type AspectRatio,
  type FrameMode,
} from "@/types";

const RATIOS: AspectRatio[] = ASPECT_ROWS.flat();

/**
 * Resize: the framing stage on the left, the shape on the right.
 *
 * Every number drawn here is `aspect_preview`'s answer — the same `ContentBox`
 * the encoder is given. The stage only scales that box to fit the screen; it
 * never works out a crop or a pad of its own. Opening this view changes
 * nothing: the shape is whatever the export already holds, Original included.
 */
export function ResizeView() {
  return (
    <div className="shift-enter absolute inset-0 grid grid-cols-[minmax(0,1fr)_232px] gap-3 p-3 min-[900px]:grid-cols-[minmax(0,1fr)_256px] min-[900px]:gap-4 min-[900px]:p-4">
      <FramingStage />
      <ResizeInspector />
    </div>
  );
}

function useSourceSize() {
  const s = useShift();
  const w = s.playback.info?.width ?? s.localMedia?.width ?? s.activeMedia?.width ?? null;
  const h = s.playback.info?.height ?? s.localMedia?.height ?? s.activeMedia?.height ?? null;
  return { w, h };
}

/** Measure an element so the stage can scale the real geometry into it. */
function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function FramingStage() {
  const s = useShift();
  const src = useSourceSize();
  const p = s.aspectPreview;
  const [stageRef, stage] = useBox<HTMLDivElement>();
  const original = s.aspect.ratio === "original";

  return (
    <div className="shift-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div ref={stageRef} className="relative min-h-[150px] flex-1 overflow-hidden" aria-label="Framing preview">
        {stage && (original || !p ? <SourceOnly stage={stage} /> : <Framed stage={stage} />)}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--hairline)] px-4 py-[10px]">
        <Dims label="Source" value={src.w && src.h ? `${src.w} × ${src.h}` : "—"} />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="stroke-shift-soft" strokeWidth="1.8" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        <Dims
          label="Output"
          value={original ? "Same shape" : p ? `${p.width} × ${p.height}` : "—"}
          strong
        />
        {s.previewIsApproximate && (
          <span className="ml-auto text-[11.5px] text-shift-soft">
            Framing is exact; the picture is the site's poster until the media is fetched.
          </span>
        )}
      </div>
    </div>
  );
}

function Dims({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className={`text-[11px] ${strong ? "text-shift-link" : "text-shift-soft"}`}>{label}</span>
      <span className={`font-mono text-[13px] ${strong ? "font-semibold text-shift-text" : "text-shift-body"}`}>{value}</span>
    </div>
  );
}

const PAD = 28;

/** Original, or a reframe whose result is not known yet: the source as it is. */
function SourceOnly({ stage }: { stage: { w: number; h: number } }) {
  const s = useShift();
  const src = useSourceSize();
  const original = s.aspect.ratio === "original";
  const room = { w: Math.max(0, stage.w - PAD * 2), h: Math.max(0, stage.h - PAD * 2) };
  const scale = src.w && src.h ? Math.min(room.w / src.w, room.h / src.h) : 0;
  const box = scale ? { width: src.w! * scale, height: src.h! * scale } : { width: room.w, height: room.h };

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative overflow-hidden rounded-[4px] bg-black shadow-[0_0_0_1px_var(--hairline-bright)]" style={box}>
        {s.previewImage ? (
          <img src={s.previewImage} alt="" draggable={false} className="h-full w-full object-contain" style={{ maxWidth: "none" }} />
        ) : (
          <Placeholder text={s.previewError ?? "No preview"} />
        )}
        <FrameTag text={original ? "Original" : "Measuring…"} />
      </div>
    </div>
  );
}

/**
 * A reframe: the output canvas outlined, the picture placed in it by the
 * content box. Under Fill the part that will be cropped stays visible, dimmed,
 * outside the outline; under Fit the padding is drawn as what it will be.
 */
function Framed({ stage }: { stage: { w: number; h: number } }) {
  const s = useShift();
  const p = s.aspectPreview!;
  const { canvasWidth: cw, canvasHeight: ch, frameWidth: fw, frameHeight: fh, offsetX: ox, offsetY: oy } = p.content;

  // The drawing is the union of canvas and picture, so a Fill crop has room to
  // show what it removes. Only a display scale is applied to these numbers.
  const minX = Math.min(0, ox);
  const minY = Math.min(0, oy);
  const unionW = Math.max(cw, ox + fw) - minX;
  const unionH = Math.max(ch, oy + fh) - minY;
  const scale = Math.min((stage.w - PAD * 2) / unionW, (stage.h - PAD * 2) / unionH);
  if (!(scale > 0)) return null;

  const px = (v: number) => v * scale;
  const fill = p.mode === "fill";
  const transparent = !fill && s.padsTransparent;
  const imgStyle = {
    maxWidth: "none",
    maxHeight: "none",
    // A stand-in poster may not share the source's shape; the real frame does.
    objectFit: s.previewIsApproximate ? ("cover" as const) : ("fill" as const),
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative" style={{ width: px(unionW), height: px(unionH) }}>
        {fill && s.previewImage && (
          <img
            src={s.previewImage}
            alt=""
            draggable={false}
            className="absolute opacity-[0.28]"
            style={{ ...imgStyle, left: px(ox - minX), top: px(oy - minY), width: px(fw), height: px(fh) }}
          />
        )}
        <div
          className={[
            "absolute overflow-hidden rounded-[2px]",
            transparent ? "shift-alpha" : "bg-black",
          ].join(" ")}
          style={{ left: px(-minX), top: px(-minY), width: px(cw), height: px(ch) }}
          aria-label={`Output ${p.width} by ${p.height}`}
        >
          {s.previewImage ? (
            <img
              src={s.previewImage}
              alt=""
              draggable={false}
              className="absolute"
              style={{ ...imgStyle, left: px(ox), top: px(oy), width: px(fw), height: px(fh) }}
            />
          ) : (
            <div className="absolute bg-shift-chip-hi" style={{ left: px(ox), top: px(oy), width: px(fw), height: px(fh) }}>
              <Placeholder text={s.previewError ?? `${p.width} × ${p.height}`} />
            </div>
          )}
          <FrameTag text={`${aspectLabel(s.aspect.ratio)} · ${fill ? "Fill" : "Fit"}`} />
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-[2px] border-2 border-shift-accent"
          style={{ left: px(-minX) - 1, top: px(-minY) - 1, width: px(cw) + 2, height: px(ch) + 2 }}
        />
      </div>
    </div>
  );
}

function FrameTag({ text }: { text: string }) {
  return (
    <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-[6px] bg-[var(--scrim)] px-2 py-[3px] text-[11px] font-semibold text-shift-text">
      {text}
    </span>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-3 text-center font-mono text-[11px] text-shift-quiet">
      {text}
    </div>
  );
}

// ---------------------------------------------------------------- inspector

function ResizeInspector() {
  const s = useShift();
  const a = s.aspect;
  const settings = exportSettings(s);
  const bad = (v: number | null) => v == null || v < MIN_DIMENSION || v > MAX_DIMENSION;
  const freeformInvalid = a.ratio === "freeform" && (bad(a.width) || bad(a.height));
  // An invalid custom size is explained beside the fields, not again here.
  const blocker = freeformInvalid ? null : exportBlocker(s);

  return (
    <Inspector
      title="Frame"
      footer={
        <>
          {blocker && (
            <div role="alert" className="text-[12px] leading-[1.45] text-shift-danger">
              {blocker}
            </div>
          )}
          <Button
            variant="primary"
            className="w-full"
            disabled={!s.canExport || s.saving}
            onClick={s.startExport}
            aria-keyshortcuts="Meta+Shift+E"
          >
            {exportActionLabel(s)}
          </Button>
        </>
      }
    >
      <Field label="Aspect ratio">
        <div role="group" aria-label="Aspect ratio" className="grid grid-cols-4 gap-[6px]">
          {RATIOS.map((r) => (
            <AspectOption key={r} ratio={r} selected={a.ratio === r} onSelect={() => s.setAspectRatio(r)} />
          ))}
        </div>
      </Field>

      {a.ratio !== "original" && (
        <Field label="Scaling">
          <Segmented<FrameMode>
            label="Scaling"
            options={[
              { id: "fill", label: "Fill" },
              { id: "fit", label: "Fit" },
            ]}
            value={a.frame}
            onChange={s.setFrameMode}
          />
          <div className="text-[11.5px] leading-[1.45] text-shift-soft">
            {a.frame === "fill"
              ? "Crops to fill the frame. Nothing is stretched."
              : s.padsTransparent
                ? "Keeps the whole picture. The rest is left transparent."
                : "Keeps the whole picture and pads the rest with black."}
          </div>
        </Field>
      )}

      {a.ratio === "freeform" && (
        <Field label="Output size">
          <div className="flex items-end gap-2">
            <SizeField fill label="WIDTH" value={a.width} onChange={(v) => s.setAspectSize("width", v)} invalid={a.width != null && bad(a.width)} />
            <button
              type="button"
              aria-pressed={s.aspectLocked}
              aria-label="Lock proportions"
              title={s.aspectLocked ? "Proportions locked to the source" : "Proportions unlocked"}
              onClick={s.toggleAspectLock}
              className={[
                "mb-[1px] flex h-[33px] w-8 shrink-0 items-center justify-center rounded-[8px] border transition-colors duration-[140ms]",
                s.aspectLocked
                  ? "border-shift-accent bg-[image:var(--accent-select)] text-shift-text"
                  : "border-[var(--hairline-strong)] bg-[image:var(--control-gradient)] text-shift-soft hover:text-shift-body",
              ].join(" ")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d={s.aspectLocked ? "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" : "M7 11V8a5 5 0 0 1 9.6-2M6 11h12v9H6z"} />
              </svg>
            </button>
            <SizeField fill label="HEIGHT" value={a.height} onChange={(v) => s.setAspectSize("height", v)} invalid={a.height != null && bad(a.height)} />
          </div>
          {freeformInvalid ? (
            <div role="status" className="text-[11.5px] leading-[1.45] text-shift-danger">
              Must be between {MIN_DIMENSION} and {MAX_DIMENSION}.
            </div>
          ) : (
            s.aspectUpscales && (
              <div role="status" className="text-[11.5px] leading-[1.45] text-shift-warning">
                Larger than the source — this enlarges the picture, it does not add detail.
              </div>
            )
          )}
        </Field>
      )}

      <div className="flex flex-col gap-2 border-t border-[var(--hairline)] pt-3">
        <SummaryRow label="Format" value={s.format} />
        {settings.map((x) => (
          <SummaryRow key={x.label} label={x.label} value={x.value} />
        ))}
      </div>
    </Inspector>
  );
}

/** One ratio tile: its shape drawn small, its name beneath. */
function AspectOption({ ratio, selected, onSelect }: { ratio: AspectRatio; selected: boolean; onSelect: () => void }) {
  const src = useSourceSize();
  // Purely an icon: the shape the name stands for, not the size it produces.
  const r =
    ratio === "original"
      ? src.w && src.h ? src.w / src.h : 16 / 9
      : ratio === "freeform"
        ? 4 / 3
        : (() => {
            const [w, h] = ratio.split(":").map(Number);
            return w / h;
          })();
  const M = 20;
  const w = r >= 1 ? M : M * r;
  const h = r >= 1 ? M / r : M;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={[
        "flex h-[54px] min-w-0 flex-col items-center justify-center gap-[6px] rounded-[10px] border transition-colors duration-[140ms]",
        selected
          ? "border-[var(--accent-edge)] bg-[image:var(--accent-select)] text-shift-text"
          : "border-[var(--hairline-faint)] bg-[image:var(--control-gradient)] text-shift-dim hover:border-[var(--hairline-bright)] hover:text-shift-body",
      ].join(" ")}
    >
      <span className="flex h-[20px] items-center" aria-hidden="true">
        <span
          className={`rounded-[3px] border-[1.6px] ${ratio === "freeform" ? "border-dashed" : "border-solid"} ${selected ? "border-shift-link" : "border-shift-soft"}`}
          style={{ width: Math.round(w), height: Math.round(h) }}
        />
      </span>
      <span className="truncate text-[10.5px] font-semibold">{aspectLabel(ratio)}</span>
    </button>
  );
}
