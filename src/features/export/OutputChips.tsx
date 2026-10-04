import { Chip } from "@/components/Chip";
import { useShift } from "@/state/shift";
import { isAnimationFormat, isAudioFormat, type OutputFormat } from "@/types";

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
export function OutputChips() {
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
