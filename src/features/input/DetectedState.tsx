import { TrimPlayer } from "./TrimPlayer";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Chip } from "@/components/Chip";
import { Toggle } from "@/components/Toggle";
import { formatBytes, formatDuration, resolutionLabel } from "@/lib/format";
import { useShift } from "@/state/shift";
import { Preview } from "@/features/input/Preview";
import { SizeField } from "@/components/SizeField";
import {
  ASPECT_ROWS,
  aspectLabel,
  isAnimationFormat,
  isAudioFormat,
  LOOP_SIZES,
  MAX_DIMENSION,
  MIN_DIMENSION,
  type OutputFormat,
} from "@/types";

/**
 * States B and C in one layout, exactly as the design composes them: identity
 * row, rule, then the stacked action sections and Export.
 */
export function DetectedState() {
  const s = useShift();
  const isUrl = s.screen === "url";
  const media = s.urlMedia;
  const local = s.localMedia;

  return (
    <div className="shift-enter absolute inset-0 flex flex-col px-8 py-7">
      {/* Everything above Export is centred in the room it has, with a small
          upward bias — true centring reads as slightly low. Export itself stays
          pinned to the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col justify-center" style={{ paddingBottom: s.clipEnabled && !s.isImage ? (isUrl ? 100 : 72) : 18 }}>
        {/* ---- identity -------------------------------------------------- */}
      <div className="flex items-start gap-[14px]">
        {isUrl ? <Thumbnail /> : <FileBadge ext={local?.ext ?? ""} />}

        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold text-shift-title">
            {isUrl ? media?.title : local?.name}
          </div>
          <div className="mt-1 font-mono text-[13px] text-shift-muted">
            {isUrl ? (
              <>
                {formatDuration(media?.duration)} &nbsp;·&nbsp; {media?.domain}
              </>
            ) : s.isImage ? (
              [
                resolutionLabel(local?.width ?? null, local?.height ?? null),
                local?.ext,
                formatBytes(local?.sizeBytes),
              ]
                .filter(Boolean)
                .join("  ·  ")
            ) : (
              [
                resolutionLabel(local?.width ?? null, local?.height ?? null),
                formatDuration(local?.duration),
                formatBytes(local?.sizeBytes),
                local?.ext,
              ]
                .filter(Boolean)
                .join("  ·  ")
            )}
          </div>
          {isUrl && <UrlPreviewStatus />}
        </div>

        <button
          type="button"
          title="New shift"
          aria-label="New shift"
          onClick={s.reset}
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[15px] text-shift-quiet transition-colors duration-[140ms] hover:bg-shift-chip hover:text-shift-body"
        >
          ×
        </button>
      </div>

      <div className="my-[18px] h-px bg-[var(--hairline-faint)]" />

      {/* ---- actions ------------------------------------------------------ */}
      {s.clipEnabled && !s.isImage ? (
        <div className="grid min-h-0 grid-cols-[340px_minmax(0,1fr)] items-start gap-6">
          <div className="flex flex-col gap-4">
            <Section title="OUTPUT"><OutputChips /></Section>
            {s.isLoop && <LoopSection compact />}
            {s.showAspect && <><AspectRatios compact />{s.aspect.ratio !== "original" && <FrameControls />}</>}
            <Modifiers />
          </div>
          <TrimPlayer key={s.localMedia?.path ?? s.urlMedia?.url} />
        </div>
      ) : <div className="flex flex-col gap-[18px] overflow-y-auto">
        <Section title="OUTPUT">
          <OutputChips />
        </Section>

        {s.isLoop && <LoopSection />}

        {/* Shape on the left, everything that qualifies it on the right. The
            window is wide and short, so the controls a visual export needs —
            which is the deepest the interface ever gets — sit side by side
            rather than running off the bottom. Audio, which has no shape, keeps
            the plain single column. */}
        {s.showAspect ? (
          <div className="flex items-start gap-[24px]">
            <div className="w-[228px] shrink-0">
              <AspectRatios />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-[16px]">
              {s.aspect.ratio !== "original" && <FrameControls />}
              <Modifiers />
            </div>
            {/* The preview earns a column rather than a row: the window is wide
                and short, and stacking it would push Export off the bottom in
                the deepest state. It only exists once there is a reframe to
                show, so Original is untouched. */}
            {s.aspectPreview && (
              <div className="shrink-0">
                <Preview />
              </div>
            )}
          </div>
        ) : (
          <Modifiers />
        )}
      </div>}
      </div>

      {/* ---- export ------------------------------------------------------- */}
      <div
        className={s.clipEnabled && !s.isImage ? "absolute left-8 right-8 flex items-center justify-between gap-4" : "mt-[18px] flex shrink-0 items-center justify-between gap-4"}
        style={s.clipEnabled && !s.isImage ? { bottom: isUrl ? 50 : 28 } : undefined}
      >
        <div />

        <button
          type="button"
          disabled={!s.canExport || s.saving}
          onClick={s.startExport}
          className={[
            "shrink-0 rounded-lg px-[26px] py-[11px] text-[13px] font-bold tracking-[0.04em]",
            "transition-opacity duration-[140ms]",
            s.canExport && !s.saving
              ? "bg-shift-emerald text-shift-on-emerald hover:opacity-90"
              : "cursor-not-allowed bg-shift-emerald/40 text-shift-on-emerald/60",
          ].join(" ")}
        >
          {/* The ellipsis is literal: this opens the native Save panel. */}
          EXPORT…
        </button>
      </div>

      {isUrl && (
        <div className={s.clipEnabled ? "absolute bottom-5 left-8 right-8 text-[11px] leading-relaxed text-shift-ghost" : "mt-[10px] text-[11px] leading-relaxed text-shift-ghost"}>
          Only download media you are authorized or legally permitted to download.
        </div>
      )}
    </div>
  );
}

/**
 * The output chips, grouped by what the user is actually trying to do.
 *
 * A video can legitimately become nine different things, which is a lot of
 * identical pills to scan when nothing marks where "keep it moving" ends and
 * "just take the audio" begins. The chips are the same and the row is still
 * one row — only the spacing carries the grouping, so it reads as three short
 * runs rather than a wall. Everything on offer is still on offer: this is not a
 * dropdown, and nothing is hidden behind a disclosure.
 *
 * A photo's four outputs and an audio file's five need no such help, so they
 * stay a single flat run.
 */
function OutputChips() {
  const s = useShift();
  const chip = (f: OutputFormat) => (
    <Chip key={f} label={f} selected={s.format === f} onClick={() => s.setFormat(f)} />
  );

  if (!s.sourceMoves || s.clipEnabled) {
    return <div className="flex flex-wrap gap-2">{s.outputs.map(chip)}</div>;
  }

  // Only a moving source has all three kinds, so only it needs the grouping.
  const groups: OutputFormat[][] = [
    s.outputs.filter((f) => !isAudioFormat(f) && !isAnimationFormat(f)),
    s.outputs.filter((f) => isAnimationFormat(f)),
    s.outputs.filter((f) => isAudioFormat(f)),
  ].filter((g) => g.length > 0);

  return (
    <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2">
      {groups.map((group) => (
        <div key={group.join()} className="flex flex-wrap gap-2">
          {group.map(chip)}
        </div>
      ))}
    </div>
  );
}

/**
 * Shape, for anything you can look at.
 *
 * Ratios are the primitive on purpose — no "TikTok" or "Reels" buttons, which
 * would date the moment a platform changed its mind. Original leads and is the
 * default, so the common case is one glance and no decision.
 *
 * There is no Stretch. A ratio change here is only ever a crop or a pad, which
 * is why the second control is Fill/Fit rather than a list of scaling modes.
 */
/**
 * Everything that qualifies the export but is not its shape: source quality,
 * the clip range, audio extraction, image compression.
 *
 * Grouped into one component so the layout can place it in a column beside the
 * aspect controls, or on its own for a source that has no shape at all.
 */
function Modifiers() {
  const s = useShift();
  const isUrl = s.screen === "url";
  const local = s.localMedia;

  return (
    <div className="flex flex-col gap-[16px]">
      {s.showQuality && (
        <Section title="QUALITY">
          <div className="flex flex-wrap gap-2">
            {s.urlMedia?.qualities.map((q) => (
              <Chip
                key={q.id}
                label={q.label}
                selected={s.quality === q.id}
                onClick={() => s.setQuality(q.id)}
              />
            ))}
          </div>
        </Section>
      )}

      <SoundControl />

      {isUrl ? (
        <div>
          <div className="mb-[10px] flex items-center justify-between">
            <div className="text-[11px] tracking-[0.08em] text-shift-label">CLIP</div>
            <Toggle on={s.clipEnabled} onChange={s.toggleClip} label="Clip this media" />
          </div>

        </div>
      ) : s.isImage ? (
        <Section title="COMPRESSION">
          <div className="flex flex-wrap gap-2">
            {s.compressionChoices.map((c) => (
              <Chip
                key={c.id}
                label={c.label}
                selected={s.compression === c.id}
                onClick={() => s.setCompression(c.id)}
              />
            ))}
          </div>
          {s.format === "PNG" && (
            <div className="mt-[10px] text-[11px] text-shift-ghost">
              PNG is lossless — Optimize only recompresses, it never changes the image.
            </div>
          )}
          {local?.hasAlpha && (
            <div className="mt-[10px] text-[11px] text-shift-ghost">
              This image has transparency, so AVIF isn't offered — it can't carry it.
            </div>
          )}
        </Section>
      ) : (
        <Section title="TRANSFORM">
          <div className="flex flex-wrap gap-2">
            <Chip label="Trim" selected={s.clipEnabled} onClick={s.toggleClip} />
            {local?.hasVideo && (
              <Chip
                label="Extract audio"
                selected={s.extractAudio}
                onClick={() => s.setFormat(s.extractAudio ? "MP4" : "MP3")}
              />
            )}
          </div>

        </Section>
      )}
    </div>
  );
}

export function SoundControl() {
  const s = useShift();
  return <SoundControlView
    sourceMoves={s.sourceMoves}
    isImage={s.isImage}
    format={s.format}
    hasAudio={s.localMedia?.hasAudio ?? s.playback.info?.hasAudio ?? null}
    soundEnabled={s.soundEnabled}
    toggleSound={s.toggleSound}
  />;
}

export function SoundControlView({
  sourceMoves,
  isImage,
  format,
  hasAudio,
  soundEnabled,
  toggleSound,
}: {
  sourceMoves: boolean;
  isImage: boolean;
  format: OutputFormat;
  hasAudio: boolean | null;
  soundEnabled: boolean;
  toggleSound: () => void;
}) {
  const applies = sourceMoves && !isImage && !isAudioFormat(format) && !isAnimationFormat(format);
  if (!applies || hasAudio == null) return null;
  return (
    <Section title="SOUND">
      {hasAudio ? (
        <Chip
          label={soundEnabled ? "ON" : "OFF"}
          selected={soundEnabled}
          onClick={toggleSound}
          title={soundEnabled ? "Remove sound from preview and export" : "Keep source sound"}
        />
      ) : (
        <span className="text-[11px] text-shift-ghost">No audio</span>
      )}
    </Section>
  );
}

/**
 * The ratios themselves.
 *
 * Ratios are the primitive on purpose — no "TikTok" or "Reels" buttons, which
 * would date the moment a platform changed its mind. Original leads and is the
 * default, so the common case is one glance and no decision.
 */
function AspectRatios({ compact = false }: { compact?: boolean }) {
  const s = useShift();
  const size = s.aspectPreview;
  return (
    <div>
      {/* The result, where the section is already looking. Informational only —
          a line of type, not a control and not a card. It is simply absent for
          Original, and for a URL whose size nobody knows yet. */}
      <div className="mb-[10px] flex items-baseline justify-between gap-2">
        <span className="text-[11px] tracking-[0.08em] text-shift-label">ASPECT</span>
        {/* The preview's own header shows these when it is on screen; this is
            the fallback for a source whose size is known without one. */}
        {size && !s.previewImage && (
          <span className="font-mono text-[11px] text-shift-ghost">
            {size.width} × {size.height}
          </span>
        )}
      </div>
      <div className={compact ? "grid grid-cols-4 gap-[6px]" : "grid grid-cols-2 gap-[6px]"}>
        {ASPECT_ROWS.map((row) =>
          row.map((r) => (
            <div key={r} className={!compact && row.length === 1 ? "col-span-2" : undefined}>
              <div className="[&>button]:w-full">
                <Chip
                  label={aspectLabel(r)}
                  selected={s.aspect.ratio === r}
                  onClick={() => s.setAspectRatio(r)}
                />
              </div>
            </div>
          )),
        )}
      </div>
    </div>
  );
}

/**
 * How the picture meets a frame it does not already fit.
 *
 * There is deliberately no Stretch: a ratio change here is only ever a crop or
 * a pad, so the choice is which of those two, not how to distort.
 */
function FrameControls() {
  const s = useShift();
  const a = s.aspect;
  const bad = (v: number | null) => v != null && (v < MIN_DIMENSION || v > MAX_DIMENSION);

  return (
    <div>
      <div className="mb-[10px] text-[11px] tracking-[0.08em] text-shift-label">FRAME</div>
      <div className="flex flex-wrap gap-2">
        <Chip label="Fill" selected={a.frame === "fill"} onClick={() => s.setFrameMode("fill")} />
        <Chip label="Fit" selected={a.frame === "fit"} onClick={() => s.setFrameMode("fit")} />
      </div>
      <div className="mt-[8px] text-[11px] leading-relaxed text-shift-ghost">
        {a.frame === "fill"
          ? "Crops to fill the frame. Nothing is stretched."
          : s.padsTransparent
            ? "Keeps the whole picture. The rest is left transparent."
            : "Keeps the whole picture and pads the rest with black."}
      </div>

      {a.ratio === "freeform" && (
        <div className="mt-[12px]">
          <div className="flex items-end gap-[12px]">
            <SizeField
              label="WIDTH"
              value={a.width}
              onChange={(v) => s.setAspectSize("width", v)}
              invalid={bad(a.width)}
            />
            <div className="mb-[9px] text-shift-ghost">×</div>
            <SizeField
              label="HEIGHT"
              value={a.height}
              onChange={(v) => s.setAspectSize("height", v)}
              invalid={bad(a.height)}
            />
            <div className="mb-[2px]">
              <Chip
                label="Lock"
                title="Keep the source's proportions while typing"
                selected={s.aspectLocked}
                onClick={s.toggleAspectLock}
              />
            </div>
          </div>
          {bad(a.width) || bad(a.height) ? (
            <div className="mt-[8px] text-[11px] text-shift-danger">
              Must be between {MIN_DIMENSION} and {MAX_DIMENSION}.
            </div>
          ) : (
            s.aspectUpscales && (
              <div className="mt-[8px] text-[11px] leading-relaxed text-[oklch(0.78_0.11_75)]">
                Larger than the source — this enlarges the picture, it does not add detail.
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The controls that only make sense once an output is a moving one.
 *
 * Deliberately a size, not a frame rate and a width: the two move together,
 * and the rates behind them are chosen so GIF's centisecond frame delays come
 * out uniform. Exposing them separately would let someone pick 15 fps, which
 * GIF cannot actually store.
 */
function LoopSection({ compact = false }: { compact?: boolean }) {
  const s = useShift();
  const detail = LOOP_SIZES.find((l) => l.id === s.loopSize)?.detail;
  const name = s.format === "GIF" ? "GIF" : "Animated WEBP";
  // Why, not just what — the limit is a file-size consequence, not a rule.
  const reason =
    s.format === "GIF"
      ? "every frame is a whole image, so length becomes file size"
      : "long loops get large";

  return (
    <Section title="LOOP">
      {/* Same two-column shape as ASPECT: choices left, the words that explain
          them to the right. Vertical room is the scarce dimension here. */}
      <div className={compact ? "flex flex-col gap-2" : "flex items-start gap-[28px]"}>
        <div className="flex w-[228px] shrink-0 flex-wrap gap-[6px]">
          {LOOP_SIZES.map((l) => (
            <Chip
              key={l.id}
              label={l.label}
              selected={s.loopSize === l.id}
              onClick={() => s.setLoopSize(l.id)}
            />
          ))}
        </div>
        <div className="min-w-0 flex-1 pt-[3px] text-[11px] leading-relaxed">
          <div className="text-shift-ghost">
            {detail} · silent · loops forever. Never upscaled past the source.
          </div>
          {s.loopTooLong ? (
            <div className="mt-[4px] text-shift-danger">
              {name} is limited to {s.loopMaxSeconds} seconds — {reason}. Trim to fit.
            </div>
          ) : (
            s.loopNeedsTrim && (
              <div className="mt-[4px] text-shift-ghost">
                Trimmed to fit {name}'s {s.loopMaxSeconds}s limit — {reason}.
              </div>
            )
          )}
        </div>
      </div>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-[10px] text-[11px] tracking-[0.08em] text-shift-label">{title}</div>
      {children}
    </div>
  );
}

function Thumbnail() {
  const { urlMedia } = useShift();
  const src = urlMedia?.thumbnailPath ? convertFileSrc(urlMedia.thumbnailPath) : null;
  return (
    <div className="flex h-[58px] w-[100px] shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-shift-track [background-image:repeating-linear-gradient(135deg,oklch(1_0_0_/_0.03)_0px,oklch(1_0_0_/_0.03)_6px,transparent_6px,transparent_12px)]">
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="font-mono text-[9px] tracking-[0.05em] text-shift-label">THUMBNAIL</span>
      )}
    </div>
  );
}

function UrlPreviewStatus() {
  const { playback } = useShift();
  const labels = {
    resolving: "Resolving link",
    downloading: "Downloading preview",
    preparing: "Preparing player",
    ready: "Ready",
  } as const;
  if (playback.error) {
    return (
      <div className="mt-2 flex items-center gap-2 text-[11px] text-shift-muted" role="status">
        <span>{playback.error}</span>
        <button type="button" onClick={playback.retry} className="underline decoration-shift-quiet underline-offset-2 hover:text-shift-body">Retry</button>
      </div>
    );
  }
  if (!playback.status) return null;
  const working = playback.status !== "ready";
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] text-shift-muted" role="status" aria-live="polite">
      {working && <span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border border-shift-quiet border-t-shift-emerald" />}
      <span>{labels[playback.status]}</span>
      {working && <button type="button" onClick={playback.cancel} className="ml-1 underline decoration-shift-quiet underline-offset-2 hover:text-shift-body">Cancel</button>}
    </div>
  );
}

function FileBadge({ ext }: { ext: string }) {
  return (
    <div className="flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-[9px] bg-shift-track">
      <span className="font-mono text-[12px] font-semibold text-shift-dim">
        {ext}
      </span>
    </div>
  );
}
