import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatMediaTime } from "@/lib/format";
import { useShift } from "@/state/shift";
import type { PostMedia } from "@/types";

/**
 * The items of a multi-item post, in the provider's order.
 *
 * Two separate ideas, as they always were: the tile itself makes an item the
 * active one (`selectPostMedia`), and its checkbox decides whether it is
 * downloaded (`togglePostMedia`). Inspecting never changes the selection.
 */
export function PostMediaPicker() {
  const s = useShift();
  const items = s.urlMedia?.mediaItems ?? [];
  const selected = s.selectedMediaIds.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-4">
        <span className="text-[12.5px] text-shift-dim" role="status" aria-live="polite">
          <span className="font-semibold text-shift-text">{selected}</span> of {items.length} selected
        </span>
        <div className="flex items-center gap-4 text-[12.5px]">
          <button type="button" onClick={s.selectAllPostMedia} className="font-medium text-shift-link hover:text-shift-link-hi">
            Select all
          </button>
          <button type="button" onClick={s.clearPostMedia} className="font-medium text-shift-dim hover:text-shift-text">
            Clear
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-[10px] p-0">
          {items.map((item, index) => (
            <PostMediaTile
              key={item.id}
              item={item}
              index={index}
              count={items.length}
              active={index === s.activeMediaIndex}
              selected={s.selectedMediaIds.includes(item.id)}
              onActivate={() => s.selectPostMedia(index)}
              onToggle={() => s.togglePostMedia(item.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function PostMediaTile({
  item,
  index,
  count,
  active,
  selected,
  onActivate,
  onToggle,
}: {
  item: PostMedia;
  index: number;
  count: number;
  active: boolean;
  selected: boolean;
  onActivate: () => void;
  onToggle: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const src = item.thumbnailPath && !broken ? convertFileSrc(item.thumbnailPath) : null;
  const n = index + 1;

  return (
    <li className="relative">
      <button
        type="button"
        aria-label={`${item.type} ${n}`}
        aria-current={active ? "true" : undefined}
        onClick={onActivate}
        className={[
          "relative block aspect-[4/5] w-full overflow-hidden rounded-[10px] bg-shift-track",
          "transition-[box-shadow,opacity] duration-[140ms]",
          active
            ? "shadow-[0_0_0_2px_var(--color-shift-link)]"
            : "shadow-[0_0_0_1px_var(--hairline)] hover:shadow-[0_0_0_1px_var(--hairline-bright)]",
          selected ? "" : "opacity-55",
        ].join(" ")}
      >
        {src ? (
          <img src={src} alt="" draggable={false} onError={() => setBroken(true)} className="h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center font-mono text-[10.5px] tracking-[0.06em] text-shift-quiet">
            {item.type.toUpperCase()}
          </span>
        )}
        <span className="absolute right-[6px] top-[6px] rounded-[5px] bg-[var(--scrim)] px-[5px] py-[1px] font-mono text-[10px] text-shift-dim">
          {n}/{count}
        </span>
        <span className="absolute bottom-[6px] left-[6px] flex items-center gap-1 rounded-[5px] bg-[var(--scrim)] px-[6px] py-[2px] text-[10px] font-semibold tracking-[0.04em] text-shift-text">
          {item.type === "video" ? (
            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
          ) : (
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 5h16v14H4z" /></svg>
          )}
          {item.type.toUpperCase()}
          {item.type === "video" && item.duration != null && <span className="font-mono font-normal">· {formatMediaTime(item.duration)}</span>}
        </span>
      </button>
      {/* A sibling of the tile, not inside it: two separate controls. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Include ${item.type} ${n}`}
        onClick={onToggle}
        className={[
          "absolute left-[6px] top-[6px] flex h-[20px] w-[20px] items-center justify-center rounded-[6px] border transition-colors duration-[140ms]",
          selected ? "border-shift-accent bg-shift-accent" : "border-white/70 bg-[var(--scrim)] hover:border-white",
        ].join(" ")}
      >
        {selected && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-white" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12l5 5 9-10" />
          </svg>
        )}
      </button>
    </li>
  );
}
