import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Field } from "@/components/Panel";
import { exportBlocker, exportModifiers } from "@/features/export/summary";
import { OutputChips } from "@/features/export/OutputChips";
import { SoundControl } from "@/features/edit/SoundControl";
import { UrlPreviewStatus } from "@/features/input/UrlPreviewStatus";
import { HomeFrame, LinkIcon, Resolving } from "@/features/input/Home";
import { formatDuration } from "@/lib/format";
import { sourceMeta } from "@/features/input/sourceMeta";
import { PostView } from "@/features/social/PostView";
import { useShift } from "@/state/shift";
import { useView, type View } from "@/state/view";

/**
 * Download with a source open: what SHIFT found, what it will produce, and the
 * one action that produces it. Everything shown is something the provider or
 * the probe actually reported; anything unknown is left out, not guessed.
 */
export function SourceResult() {
  const s = useShift();
  if (s.analyzing) {
    return (
      <HomeFrame width={680}>
        <Resolving />
      </HomeFrame>
    );
  }

  const isUrl = s.screen === "url";
  const multi = isUrl && (s.urlMedia?.mediaItems.length ?? 0) > 1;
  // A post with several items has its own view: the collection and the item.
  if (multi) return <PostView />;
  // Sound has its own control on this screen, so it is not repeated below.
  const modifiers = exportModifiers(s).filter((m) => m !== "Sound off");
  const blocker = exportBlocker(s);

  return (
    <HomeFrame width={680}>
      <div className="flex flex-col gap-4">
        {isUrl && <SourceLink />}

        <div className="shift-panel relative grid grid-cols-[minmax(150px,240px)_minmax(0,1fr)] gap-5 p-4">
          <Thumb />
          <Details />
          <button
            type="button"
            title="New Shift"
            aria-label="New Shift"
            onClick={s.reset}
            className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-[8px] text-[16px] leading-none text-shift-quiet transition-colors duration-[140ms] hover:bg-shift-chip-hi hover:text-shift-text"
          >
            ×
          </button>
        </div>

        {modifiers.length > 0 && (
          <div className="px-1 text-[12px] text-shift-soft">
            <span className="text-shift-quiet">Also applied · </span>
            {modifiers.join(" · ")}
          </div>
        )}

        <Actions />

        {blocker && (
          <div role="alert" className="px-1 text-right text-[12px] text-shift-danger">
            {blocker}
          </div>
        )}

        {isUrl && (
          <div className="px-1 text-[11.5px] leading-relaxed text-shift-faint">
            Only download media you are authorized or legally permitted to download.
          </div>
        )}
      </div>
    </HomeFrame>
  );
}

/** The link that was resolved, and what was found behind it. */
function SourceLink() {
  const { urlMedia } = useShift();
  const items = urlMedia?.mediaItems ?? [];
  const count = (type: string) => items.filter((i) => i.type === type).length;
  const parts = (
    [
      ["video", "video", "videos"],
      ["image", "image", "images"],
      ["audio", "audio track", "audio tracks"],
    ] as const
  )
    .map(([type, one, many]) => {
      const n = count(type);
      return n ? `${n} ${n === 1 ? one : many}` : null;
    })
    .filter(Boolean);

  return (
    <div className="flex h-[46px] items-center gap-3 rounded-[12px] border border-[var(--hairline-bright)] bg-shift-input px-4 shadow-[var(--top-edge)]">
      <LinkIcon />
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-shift-body" title={urlMedia?.url}>
        {urlMedia?.url}
      </span>
      {parts.length > 0 && (
        <span className="flex shrink-0 items-center gap-[6px] text-[12px] text-shift-success">
          <span aria-hidden="true" className="h-[6px] w-[6px] rounded-full bg-shift-success" />
          {parts.join(", ")} found
        </span>
      )}
    </div>
  );
}

function Thumb() {
  const s = useShift();
  const kind = s.activeMedia?.type ?? s.localMedia?.kind;
  const duration = s.activeMedia?.duration ?? s.localMedia?.duration ?? null;
  const image = s.previewImage;

  return (
    <div className="relative flex aspect-video items-center justify-center self-start overflow-hidden rounded-[10px] bg-black shadow-[inset_0_0_0_1px_var(--hairline)]">
      {image ? (
        <img src={image} alt="" draggable={false} className="h-full w-full object-contain" />
      ) : (
        <span className="font-mono text-[11px] tracking-[0.06em] text-shift-quiet">
          {kind === "audio" ? "AUDIO" : s.previewError ? "NO PREVIEW" : (kind ?? "").toUpperCase()}
        </span>
      )}
      {kind !== "image" && duration != null && (
        <span className="absolute bottom-2 right-2 rounded-[6px] bg-[var(--scrim)] px-2 py-[3px] font-mono text-[11px] font-semibold text-shift-text">
          {formatDuration(duration)}
        </span>
      )}
    </div>
  );
}

function Details() {
  const s = useShift();
  const isUrl = s.screen === "url";
  const local = s.localMedia;
  const meta = sourceMeta(s);

  return (
    <div className="flex min-w-0 flex-col gap-[6px] pr-8">
      {isUrl && s.urlMedia && (
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-shift-dim">
          <span className="rounded-[6px] bg-shift-chip-hi px-[6px] py-[2px] text-[10.5px] font-semibold text-shift-text">
            {s.urlMedia.platform}
          </span>
          {s.urlMedia.author && <span className="truncate">{s.urlMedia.author}</span>}
        </div>
      )}
      <div className="line-clamp-2 text-[17px] font-semibold leading-snug text-shift-text" title={isUrl ? s.urlMedia?.title : local?.name}>
        {isUrl ? s.urlMedia?.title : local?.name}
      </div>
      <div className="font-mono text-[12px] text-shift-soft">{meta.join(" · ")}</div>
      {isUrl && <UrlPreviewStatus />}

      <div className="mt-3 flex flex-col gap-3">
        <Field label="Format">
          <OutputChips />
        </Field>
        {s.showQuality && (
          <Field label="Quality">
            <div className="flex flex-wrap gap-2">
              {s.activeMedia?.qualities.map((q) => (
                <Chip key={q.id} label={q.label} selected={s.quality === q.id} onClick={() => s.setQuality(q.id)} />
              ))}
            </div>
          </Field>
        )}
      </div>
    </div>
  );
}

/** Shortcuts into the modes that apply, then the one primary action. */
function Actions() {
  const s = useShift();
  const { available, setView } = useView();
  const isUrl = s.screen === "url";
  const shortcuts: { id: View; label: string }[] = [
    { id: "edit", label: "Edit" },
    { id: "resize", label: "Resize" },
    { id: "compress", label: "Compress" },
  ];

  return (
    <div className="flex flex-wrap items-center justify-end gap-[10px]">
      {/* The same control and state as Edit's header, so either place can change it. */}
      <div className="mr-auto">
        <SoundControl />
      </div>
      {shortcuts
        .filter((m) => available[m.id])
        .map((m) => (
          <Button key={m.id} onClick={() => setView(m.id)}>
            {m.label}
          </Button>
        ))}
      <Button
        variant="primary"
        disabled={!s.canExport || s.saving}
        onClick={s.startExport}
        aria-keyshortcuts="Meta+Shift+E"
        className="!px-[26px]"
      >
        {/* The ellipsis is literal: this opens the native Save panel or folder picker. */}
        {isUrl ? "Download…" : "Export…"}
      </Button>
    </div>
  );
}
