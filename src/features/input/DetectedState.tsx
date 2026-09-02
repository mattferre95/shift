import { convertFileSrc } from "@tauri-apps/api/core";
import { Chip } from "@/components/Chip";
import { TimeField } from "@/components/TimeField";
import { Toggle } from "@/components/Toggle";
import { formatBytes, formatDuration, parseTimestamp, resolutionLabel } from "@/lib/format";
import { useShift } from "@/state/shift";
import { isAnimationFormat, isAudioFormat, LOOP_SIZES, type OutputFormat } from "@/types";

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
      <div className="flex min-h-0 flex-1 flex-col justify-center pb-[26px]">
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

      <div className="my-[22px] h-px bg-[var(--hairline-faint)]" />

      {/* ---- actions ------------------------------------------------------ */}
      <div className="flex flex-col gap-[22px] overflow-y-auto">
        <Section title="OUTPUT">
          <OutputChips />
        </Section>

        {s.isLoop && <LoopSection />}

        {s.showQuality && (
          <Section title="QUALITY">
            <div className="flex flex-wrap gap-2">
              {media?.qualities.map((q) => (
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

        {isUrl ? (
          <div>
            <div className="mb-[10px] flex items-center justify-between">
              <div className="text-[11px] tracking-[0.08em] text-shift-label">CLIP</div>
              <Toggle on={s.clipEnabled} onChange={s.toggleClip} label="Clip this media" />
            </div>
            {s.clipEnabled && <ClipControls showRange />}
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
            {s.localMedia?.hasAlpha && (
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
            {s.clipEnabled && (
              <div className="mt-[14px]">
                <ClipControls />
              </div>
            )}
          </Section>
        )}
      </div>

      </div>

      {/* ---- export ------------------------------------------------------- */}
      <div className="mt-[18px] flex items-center justify-between gap-4">
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
        <div className="mt-[10px] text-[11px] leading-relaxed text-shift-ghost">
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

  if (!s.sourceMoves) {
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
 * The controls that only make sense once an output is a moving one.
 *
 * Deliberately a size, not a frame rate and a width: the two move together,
 * and the rates behind them are chosen so GIF's centisecond frame delays come
 * out uniform. Exposing them separately would let someone pick 15 fps, which
 * GIF cannot actually store.
 */
function LoopSection() {
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
      <div className="flex flex-wrap gap-2">
        {LOOP_SIZES.map((l) => (
          <Chip
            key={l.id}
            label={l.label}
            selected={s.loopSize === l.id}
            onClick={() => s.setLoopSize(l.id)}
          />
        ))}
      </div>
      <div className="mt-[10px] text-[11px] text-shift-ghost">
        {detail} · silent · loops forever. Never upscaled past the source.
      </div>
      {s.loopTooLong ? (
        <div className="mt-[6px] text-[11px] text-shift-danger">
          {name} is limited to {s.loopMaxSeconds} seconds — {reason}. Trim to fit.
        </div>
      ) : (
        s.loopNeedsTrim && (
          <div className="mt-[6px] text-[11px] text-shift-ghost">
            Trimmed to fit {name}'s {s.loopMaxSeconds}s limit — {reason}. Adjust the range below.
          </div>
        )
      )}
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

function FileBadge({ ext }: { ext: string }) {
  return (
    <div className="flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-[9px] bg-shift-track">
      <span className="font-mono text-[12px] font-semibold text-shift-dim">
        {ext}
      </span>
    </div>
  );
}

function ClipControls({ showRange }: { showRange?: boolean }) {
  const s = useShift();
  const inSec = parseTimestamp(s.clipIn);
  const outSec = parseTimestamp(s.clipOut);
  const total = s.duration ?? 0;

  let range: { left: number; width: number } | null = null;
  if (showRange && total > 0 && inSec != null && outSec != null && outSec > inSec) {
    const left = Math.max(0, Math.min(100, (inSec / total) * 100));
    range = { left, width: Math.max(0.5, Math.min(100 - left, ((outSec - inSec) / total) * 100)) };
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-[14px]">
        <TimeField label="IN" value={s.clipIn} onChange={s.setClipIn} invalid={!!s.clipError} />
        <div className="mt-[14px] text-shift-ghost">–</div>
        <TimeField label="OUT" value={s.clipOut} onChange={s.setClipOut} invalid={!!s.clipError} />
        <div className="mt-[19px] font-mono text-[12px] text-shift-faint">
          {s.clipError ? (
            <span className="text-shift-danger">{s.clipError}</span>
          ) : (
            s.clipLabel && `${s.clipLabel} selected`
          )}
        </div>
      </div>

      {showRange && (
        <div className="relative h-1 overflow-hidden rounded-sm bg-shift-track">
          {range && (
            <div
              className="absolute inset-y-0 rounded-sm bg-shift-emerald transition-[left,width] duration-[140ms]"
              style={{ left: `${range.left}%`, width: `${range.width}%` }}
            />
          )}
        </div>
      )}
    </div>
  );
}
