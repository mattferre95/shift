import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { Inspector, SummaryRow } from "@/components/Panel";
import { Toggle } from "@/components/Toggle";
import { PostMediaPicker } from "@/features/social/PostMediaPicker";
import { formatMediaTime, resolutionLabel } from "@/lib/format";
import { useShift } from "@/state/shift";

/**
 * Download, for a post with several items: the collection on the left, the
 * active item on the right. Items download as their original files through
 * the existing folder flow, so there is no format, trim or shape here.
 */
export function PostView() {
  return (
    <div className="shift-enter absolute inset-0 grid grid-cols-[minmax(0,1fr)_232px] gap-3 p-3 min-[900px]:grid-cols-[minmax(0,1fr)_256px] min-[900px]:gap-4 min-[900px]:p-4">
      <section aria-label="Post media" className="shift-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
        <PostMediaPicker />
      </section>
      <ItemInspector />
    </div>
  );
}

/** What the provider said about the post, kept to one line. */
export function PostHeader() {
  const { urlMedia } = useShift();
  const items = urlMedia?.mediaItems ?? [];
  const videos = items.filter((i) => i.type === "video").length;
  const images = items.filter((i) => i.type === "image").length;
  const audio = items.length - videos - images;
  const counts = [
    videos && `${videos} video${videos === 1 ? "" : "s"}`,
    images && `${images} image${images === 1 ? "" : "s"}`,
    audio && `${audio} audio`,
  ].filter(Boolean);
  // The count leads, so a long title or handle never truncates it away.
  const meta = [`${items.length} items`, counts.join(", "), urlMedia?.platform, urlMedia?.author].filter(Boolean).join(" · ");
  return <Header title={urlMedia?.title ?? "Post"} meta={meta} />;
}

function ItemInspector() {
  const s = useShift();
  const items = s.urlMedia?.mediaItems ?? [];
  const item = s.activeMedia;
  const n = s.activeMediaIndex + 1;
  const included = item ? s.selectedMediaIds.includes(item.id) : false;
  const count = s.selectedMediaCount;
  // A thumbnail that fails to load falls back to the type, as in the grid.
  const [broken, setBroken] = useState<string | null>(null);
  const src = item?.thumbnailPath && broken !== item.id ? convertFileSrc(item.thumbnailPath) : null;
  const type = item?.type === "video" ? "Video" : item?.type === "image" ? "Image" : "Audio";

  return (
    <Inspector
      title={`Item ${n} of ${items.length}`}
      aside={
        <span className={`text-[11.5px] font-medium ${included ? "text-shift-success" : "text-shift-soft"}`}>
          {included ? "Included" : "Not included"}
        </span>
      }
      footer={
        <>
          {count === 0 && (
            <div role="status" className="text-[12px] leading-[1.45] text-shift-soft">
              Select at least one item to download.
            </div>
          )}
          <Button
            variant="primary"
            className="w-full"
            disabled={!s.canExport || s.saving}
            onClick={s.startExport}
            aria-keyshortcuts="Meta+Shift+E"
          >
            {/* The ellipsis is literal: the native folder picker opens. */}
            Download {count} Selected…
          </Button>
        </>
      }
    >
      <div className="flex h-[150px] w-full shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-black shadow-[inset_0_0_0_1px_var(--hairline)] min-[900px]:h-[180px]">
        {src ? (
          <img src={src} alt="" draggable={false} onError={() => item && setBroken(item.id)} className="h-full w-full object-contain" />
        ) : (
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-shift-quiet">{(item?.type ?? "").toUpperCase()}</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SummaryRow label="Type" value={type} />
        {item?.type !== "image" && item?.duration != null && (
          <SummaryRow label="Duration" value={<span className="font-mono">{formatMediaTime(item.duration)}</span>} />
        )}
        {resolutionLabel(item?.width ?? null, item?.height ?? null) && (
          <SummaryRow label="Dimensions" value={<span className="font-mono">{resolutionLabel(item!.width, item!.height)}</span>} />
        )}
      </div>

      {item && (
        <div className="flex items-center justify-between gap-3 border-t border-[var(--hairline)] pt-3">
          <span className="text-[12.5px] text-shift-body">Include in download</span>
          <Toggle on={included} onChange={() => s.togglePostMedia(item.id)} label={`Include item ${n}`} />
        </div>
      )}

      <div className="text-[11.5px] leading-[1.45] text-shift-soft">
        Selected items are saved as posted, into a folder you choose.
      </div>
      <div className="text-[11px] leading-relaxed text-shift-faint">
        Only download media you are authorized or legally permitted to download.
      </div>
    </Inspector>
  );
}
