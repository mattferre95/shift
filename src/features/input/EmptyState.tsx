import { useShift } from "@/state/shift";

/**
 * State A. One dominant action, brand, tagline, and the privacy cue.
 */
export function EmptyState() {
  const { dragging, setDragging, openFilePicker, acceptPaths, submitUrl, analyzing, health, healthError } =
    useShift();

  const missing = health
    ? [
        !health.ffmpeg && "FFmpeg",
        !health.ffprobe && "ffprobe",
        !health.ytdlp && "yt-dlp",
      ].filter(Boolean)
    : [];

  return (
    <div className="shift-enter absolute inset-0 flex flex-col items-center justify-center px-8 pb-12 pt-8">
      <div className="flex flex-col items-center text-center">
        <img
          src="/brand/shift-symbol.png"
          alt=""
          data-dragging={dragging}
          className="shift-symbol mb-[9px] h-auto w-8"
        />
        <div className="text-[27px] font-extrabold leading-none tracking-[-0.022em] text-shift-text">
          SHIFT
          <span className="align-super text-[13px] font-semibold text-shift-dim">™</span>
        </div>
        <div className="mt-[4px] text-[12px] text-shift-muted">Anything in. Anything out.</div>
      </div>

      <button
        type="button"
        onClick={openFilePicker}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          // Tauri handles real file drops; this covers a dragged link.
          const uri =
            e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
          if (uri && /^https?:\/\//i.test(uri.trim())) submitUrl(uri.trim());
          else acceptPaths([]);
        }}
        style={{ boxShadow: dragging ? undefined : "var(--top-edge)" }}
        className={[
          "mt-[26px] flex min-h-[144px] w-[512px] flex-col items-center justify-center gap-[6px]",
          "rounded-[10px] border transition-all duration-[160ms] ease-out",
          dragging
            ? "border-[oklch(0.72_0.15_155_/_0.55)] bg-[var(--emerald-tint)]"
            : "border-[var(--hairline-faint)] bg-shift-surface hover:border-[var(--hairline)] hover:bg-shift-chip",
        ].join(" ")}
      >
        <div className="text-[14px] font-medium tracking-[-0.005em] text-shift-title">
          {analyzing ? "Reading…" : "Drop a file or paste a link"}
        </div>
        <div className="text-[12px] text-shift-quiet">
          Video, audio, image, or supported media URL
        </div>
      </button>

      {healthError ? (
        <div className="mt-[20px] text-center text-[11px] text-shift-danger">
          SHIFT can't reach its media engine. {healthError}
        </div>
      ) : missing.length > 0 ? (
        <div className="mt-[20px] text-center text-[11px] text-shift-danger">
          Missing {missing.join(", ")}. Run scripts/fetch-sidecars.sh.
        </div>
      ) : (
        <div className="mt-[18px] text-center text-[11px] text-[oklch(0.27_0.005_165)] transition-colors duration-[160ms] hover:text-shift-faint">
          ⌘V to paste a link &nbsp;·&nbsp; Local files stay on your Mac.
        </div>
      )}
    </div>
  );
}
