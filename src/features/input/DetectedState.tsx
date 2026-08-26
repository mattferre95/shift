import { convertFileSrc } from "@tauri-apps/api/core";
import { Chip } from "@/components/Chip";
import { TimeField } from "@/components/TimeField";
import { Toggle } from "@/components/Toggle";
import { formatBytes, formatDuration, parseTimestamp, resolutionLabel } from "@/lib/format";
import { useShift } from "@/state/shift";

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
      {/* ---- identity ---------------------------------------------------- */}
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
          <div className="flex flex-wrap gap-2">
            {s.outputs.map((f) => (
              <Chip key={f} label={f} selected={s.format === f} onClick={() => s.setFormat(f)} />
            ))}
          </div>
        </Section>

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

      <div className="flex-1" />

      {/* ---- export ------------------------------------------------------- */}
      <div className="mt-[18px] flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={s.chooseOutputDir}
          title={s.outputDir}
          className="min-w-0 truncate text-left text-[12px] text-shift-faint transition-colors duration-[140ms] hover:text-shift-muted"
        >
          Save to {s.outputDir.split("/").pop() || s.outputDir}
        </button>

        <button
          type="button"
          disabled={!s.canExport}
          onClick={s.startExport}
          className={[
            "shrink-0 rounded-lg px-[26px] py-[11px] text-[13px] font-bold tracking-[0.04em]",
            "transition-opacity duration-[140ms]",
            s.canExport
              ? "bg-shift-emerald text-shift-on-emerald hover:opacity-90"
              : "cursor-not-allowed bg-shift-emerald/40 text-shift-on-emerald/60",
          ].join(" ")}
        >
          EXPORT
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
