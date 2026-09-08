import { useShift } from "@/state/shift";

/** The largest the viewport may be, so the window never has to scroll. */
const MAX_W = 300;
const MAX_H = 190;

/**
 * A visual preview of the frame an export will produce.
 *
 * Every number here comes from `aspect_preview`, which is `media::aspect`
 * answering with the same `ContentBox` it hands the encoder. Nothing on this
 * screen is computed from the ratio label: the viewport takes the real output
 * dimensions, and the picture inside it is positioned by the real content box.
 * `object-fit: cover` is deliberately not used to imply a crop — the crop is
 * the offset and the overflow, exactly as FFmpeg is told.
 *
 * One shape covers both modes. Fit gives positive offsets and the gap reads as
 * padding; Fill gives negative offsets and the overflow is clipped. When a
 * draggable crop arrives, it changes the offset and nothing else here moves.
 */
export function Preview() {
  const s = useShift();
  const p = s.aspectPreview;
  if (!p) return null;

  const { canvasWidth: cw, canvasHeight: ch, frameWidth, frameHeight, offsetX, offsetY } = p.content;

  // Fit the viewport to the output's own proportions inside the space allowed.
  const scale = Math.min(MAX_W / cw, MAX_H / ch);
  const viewport = { width: Math.round(cw * scale), height: Math.round(ch * scale) };

  // Percentages of the canvas, so the final resize — which scales canvas and
  // content together — cannot change what is drawn.
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return (
    <div className="min-w-0">
      <div className="mb-[10px] flex items-baseline justify-between gap-2">
        <span className="text-[11px] tracking-[0.08em] text-shift-label">PREVIEW</span>
        <span className="font-mono text-[11px] text-shift-ghost">
          {p.width} × {p.height}
        </span>
      </div>

      <div
        className={[
          "relative overflow-hidden rounded-[6px]",
          "border border-[var(--hairline-strong)] bg-shift-track",
          // The checkerboard shows only where the export really will be
          // transparent. It is a reading aid in the interface and is never
          // written into a file.
          s.padsTransparent && p.mode === "fit" ? "shift-alpha" : "",
        ].join(" ")}
        style={viewport}
        aria-label={`Preview, ${p.width} by ${p.height}`}
      >
        {/* Black bars are drawn rather than implied, so Fit looks like what it
            produces. Under a transparent pad this layer is absent and the
            checkerboard shows through instead. */}
        {p.mode === "fit" && !s.padsTransparent && (
          <div className="absolute inset-0 bg-black" />
        )}

        {s.previewImage ? (
          <img
            src={s.previewImage}
            alt=""
            draggable={false}
            className="absolute select-none"
            style={{
              left: pct(offsetX, cw),
              top: pct(offsetY, ch),
              width: pct(frameWidth, cw),
              height: pct(frameHeight, ch),
              // Tailwind's preflight applies `max-width: 100%` to every image.
              // A Fill overflows its frame by design — often 300% wide — and
              // that cap silently clamps it back to the container, after which
              // the negative offset carries the whole picture off-screen. The
              // preview looked empty rather than wrong, which is worse.
              maxWidth: "none",
              maxHeight: "none",
              // The source's own aspect already equals the frame box's, so this
              // only guards a stand-in poster whose shape may differ.
              objectFit: s.previewIsApproximate ? "cover" : "fill",
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-3 text-center">
            <span className="text-[10px] leading-relaxed text-shift-quiet">
              {s.previewError ?? `${p.width} × ${p.height}`}
            </span>
          </div>
        )}
      </div>

      {s.previewIsApproximate && (
        <div className="mt-[8px] text-[10px] leading-relaxed text-shift-ghost">
          Framing is exact; the picture is the site's poster until the media is
          fetched.
        </div>
      )}
    </div>
  );
}
