import { useShift } from "@/state/shift";
import { isAnimationFormat, isAudioFormat, type OutputFormat } from "@/types";

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
  // One pill: the speaker, the word, and the switch. The button keeps its
  // ON / OFF name so the state reads the same to assistive technology.
  return (
    <div className="flex h-[34px] shrink-0 items-center gap-[10px] rounded-[9px] border border-[var(--hairline)] bg-shift-input pl-3 pr-[6px] text-[13px] font-medium">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={hasAudio && soundEnabled ? "text-shift-text" : "text-shift-soft"}>
        <path d={hasAudio && soundEnabled ? "M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7" : "M4 9v6h4l5 4V5L8 9H4zM17 9l4 6M21 9l-4 6"} />
      </svg>
      {hasAudio ? (
        <>
          <span className={soundEnabled ? "text-shift-text" : "text-shift-dim"}>{soundEnabled ? "Sound" : "Muted"}</span>
          <button
            type="button"
            aria-pressed={soundEnabled}
            onClick={toggleSound}
            title={soundEnabled ? "Remove sound from preview and export" : "Keep source sound"}
            className={[
              "relative h-[22px] w-9 shrink-0 rounded-[11px] transition-[background] duration-[140ms] ease-out",
              soundEnabled ? "bg-[image:var(--accent-gradient)]" : "bg-shift-switch-off",
            ].join(" ")}
          >
            <span className="sr-only">{soundEnabled ? "ON" : "OFF"}</span>
            <span
              aria-hidden="true"
              className={[
                "absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-[left] duration-[140ms] ease-out",
                soundEnabled ? "left-[16px]" : "left-[2px]",
              ].join(" ")}
            />
          </button>
        </>
      ) : (
        <span className="pr-[6px] text-shift-soft">No audio</span>
      )}
    </div>
  );
}
