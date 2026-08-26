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
        <img src="/brand/shift-symbol.png" alt="" className="mb-[10px] h-auto w-9" />
        <div className="text-[29px] font-extrabold leading-none tracking-[-0.022em] text-shift-text">
          SHIFT
          <span className="align-super text-[14px] font-semibold text-shift-dim">™</span>
        </div>
        <div className="mt-[5px] text-[13px] text-shift-dim">Anything in. Anything out.</div>
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
        className={[
          "mt-[22px] flex min-h-[156px] w-[540px] flex-col items-center justify-center gap-[7px]",
          "rounded-[10px] border transition-all duration-[160ms] ease-out",
          dragging
            ? "border-[var(--emerald-edge)] bg-[var(--emerald-tint)]"
            : "border-transparent bg-shift-surface hover:bg-shift-chip",
        ].join(" ")}
      >
        <div className="text-[12px] font-semibold tracking-[0.07em] text-shift-body">
          {analyzing ? "READING…" : "DROP A FILE OR PASTE A LINK"}
        </div>
        <div className="text-[12px] text-shift-quiet">Video, audio, or supported media URL</div>
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
        <div className="mt-[20px] text-center text-[11px] text-shift-ghost">
          ⌘V to paste a link &nbsp;·&nbsp; Local files stay on your Mac.
        </div>
      )}
    </div>
  );
}
