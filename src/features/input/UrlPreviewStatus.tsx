import { Spinner } from "@/components/Spinner";
import { useShift } from "@/state/shift";

const LABELS = {
  resolving: "Resolving link",
  downloading: "Downloading preview",
  preparing: "Preparing player",
  ready: "Ready",
} as const;

/**
 * The link's preview, as the playback session reports it: its real stage,
 * with the session's own Cancel and Retry. Images have nothing to prepare.
 */
export function UrlPreviewStatus() {
  const { playback, activeMedia } = useShift();
  const action = "font-medium text-shift-link hover:text-shift-link-hi";
  if (activeMedia?.type === "image") {
    return <div className="mt-2 text-[11.5px] text-shift-soft" role="status">Ready</div>;
  }
  if (playback.error) {
    return (
      <div className="mt-2 flex items-center gap-2 text-[11.5px] text-shift-soft" role="status">
        <span>{playback.error}</span>
        <button type="button" onClick={playback.retry} className={action}>Retry</button>
      </div>
    );
  }
  if (!playback.status) return null;
  const working = playback.status !== "ready";
  return (
    <div className="mt-2 flex items-center gap-2 text-[11.5px] text-shift-soft" role="status" aria-live="polite">
      {working && <Spinner size={12} />}
      <span>{LABELS[playback.status]}</span>
      {working && <button type="button" onClick={playback.cancel} className={`ml-1 ${action}`}>Cancel</button>}
    </div>
  );
}
