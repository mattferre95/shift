import { Field } from "@/components/Panel";
import { Segmented } from "@/components/Segmented";
import { loopNote } from "@/features/export/summary";
import { useShift } from "@/state/shift";
import { LOOP_SIZES, type LoopSize } from "@/types";

/**
 * Loop size, for a GIF or animated WEBP made from moving media. Shown only
 * when the export is actually a loop; the limits and the words are
 * `loopNote`'s, so every view says the same thing.
 */
export function LoopField() {
  const s = useShift();
  if (!s.isLoop) return null;
  const note = loopNote(s);
  return (
    <Field label="Loop size">
      <Segmented<LoopSize>
        label="Loop size"
        size="sm"
        options={LOOP_SIZES.map((l) => ({ id: l.id, label: l.label, title: l.detail }))}
        value={s.loopSize}
        onChange={s.setLoopSize}
      />
      <div className="text-[11.5px] leading-[1.45] text-shift-soft">{note.detail}</div>
      {note.warning && (
        <div
          role={note.blocking ? "alert" : undefined}
          className={`text-[11.5px] leading-[1.45] ${note.blocking ? "text-shift-danger" : "text-shift-soft"}`}
        >
          {note.warning}
        </div>
      )}
    </Field>
  );
}
