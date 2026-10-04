import { useState } from "react";
import { Button } from "@/components/Button";
import { HomeFrame } from "@/features/input/Home";
import { useShift } from "@/state/shift";

/**
 * State F. The human sentence first, then what to do about it. The raw output
 * from the native layer stays folded away behind Technical details (JOB-05).
 */
export function ErrorState({ during = "input" }: { during?: "input" | "export" }) {
  const { error, retry, reset, openFilePicker, lastInput, urlMedia } = useShift();
  const [open, setOpen] = useState(false);
  const code = error?.code ?? "";
  const icon = code === "private_post" ? LOCK : code === "missing_binary" ? PLUG : ALERT;
  const isFile = lastInput?.kind === "file";
  // What failed, in a few words. `retry` repeats the last input, not an
  // export, so after a failed export it is offered as reopening the source.
  const eyebrow =
    during === "export"
      ? (urlMedia?.mediaItems.length ?? 0) > 1
        ? "Download failed"
        : "Export failed"
      : isFile
        ? "Couldn't open this file"
        : lastInput
          ? "Couldn't open this link"
          : null;
  const retryLabel = during === "export" ? (isFile ? "Reopen File" : "Reopen Link") : "Try Again";

  return (
    <HomeFrame width={460}>
      <div role="alert" className="shift-panel flex flex-col items-center gap-3 px-8 py-8 text-center">
        <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-[14px] border border-[var(--danger-edge)] bg-[var(--danger-tint)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="stroke-shift-danger" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={icon} />
          </svg>
        </div>

        {eyebrow && <div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-shift-danger">{eyebrow}</div>}
        <h2 className="m-0 text-[18px] font-semibold leading-snug text-shift-text">
          {error?.message ?? "Something went wrong."}
        </h2>

        {lastInput && (
          <div className="max-w-full truncate font-mono text-[12px] text-shift-soft" title={lastInput.value}>
            {lastInput.kind === "file" ? lastInput.value.split("/").pop() : lastInput.value}
          </div>
        )}

        {error?.hint && (
          <p className="m-0 max-w-[380px] text-[13.5px] leading-[1.5] text-shift-dim">{error.hint}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-center gap-[10px]">
          <Button
            onClick={() => {
              reset();
              if (lastInput?.kind === "file") openFilePicker();
            }}
          >
            {lastInput?.kind === "url"
              ? "Paste Another Link"
              : lastInput?.kind === "file"
                ? "Choose Another File…"
                : "Start Over"}
          </Button>
          {lastInput && (
            <Button variant="primary" onClick={retry}>
              {retryLabel}
            </Button>
          )}
        </div>

        {error?.technical && (
          <Button variant="text" className="mt-2 text-[12.5px]" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide technical details" : "Technical details"}
          </Button>
        )}

        {open && error?.technical && (
          <pre className="m-0 max-h-[180px] w-full overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-[var(--hairline)] bg-shift-input px-4 py-3 text-left font-mono text-[11px] leading-[1.7] text-shift-quiet select-text">
            {`error: ${error.code}\n${error.technical}`}
          </pre>
        )}
      </div>
    </HomeFrame>
  );
}

const ALERT = "M12 8v5M12 16.5v.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z";
const LOCK = "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z";
const PLUG = "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5";
