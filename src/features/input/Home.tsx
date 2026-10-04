import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Notice } from "@/components/Notice";
import { Spinner } from "@/components/Spinner";
import { useShift } from "@/state/shift";

const URL_PATTERN = /^https?:\/\//i;

/**
 * Home: one field for links, one zone for files.
 *
 * Every action here is an existing one — `submitUrl`, `openFilePicker` and the
 * window-wide drop handler in `App` — so this screen only arranges them.
 */
export function Home() {
  const s = useShift();
  return (
    <HomeFrame>
      {s.analyzing ? <Resolving /> : <Entry />}
    </HomeFrame>
  );
}

/** A scrolling column that centres while it fits and scrolls once it doesn't. */
export function HomeFrame({ children, width = 600 }: { children: React.ReactNode; width?: number }) {
  return (
    <div className="shift-enter absolute inset-0 overflow-y-auto">
      <div
        className="mx-auto flex min-h-full w-full flex-col justify-center gap-5 px-6 py-7"
        style={{ maxWidth: width + 48 }}
      >
        {children}
      </div>
    </div>
  );
}

function Entry() {
  const s = useShift();
  const missing = s.health
    ? [!s.health.ffmpeg && "FFmpeg", !s.health.ffprobe && "ffprobe", !s.health.ytdlp && "yt-dlp"].filter(Boolean)
    : [];

  return (
    <>
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="m-0 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-shift-text">
          Anything in. Anything out.
        </h2>
        <p className="m-0 text-[14px] text-shift-dim">Drop a file or paste a public media link.</p>
      </div>

      <UrlField />

      <div className="flex items-center gap-[14px] text-[12px] text-shift-faint" aria-hidden="true">
        <div className="h-px flex-1 bg-[var(--hairline)]" />
        or
        <div className="h-px flex-1 bg-[var(--hairline)]" />
      </div>

      <DropZone />

      {s.healthError ? (
        <Notice tone="danger">SHIFT can't reach its media engine. {s.healthError}</Notice>
      ) : missing.length > 0 ? (
        <Notice tone="danger">Missing {missing.join(", ")}. Run scripts/fetch-sidecars.sh.</Notice>
      ) : (
        <PlatformRow />
      )}
    </>
  );
}

/**
 * The link field. Submits through `submitUrl`, the same path as ⌘V anywhere in
 * the window. It is not focused on arrival, so that window-wide ⌘V keeps
 * fetching straight away instead of pasting into the field.
 */
function UrlField() {
  const s = useShift();
  const [value, setValue] = useState("");
  const valid = URL_PATTERN.test(value.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) s.submitUrl(value.trim());
  };

  return (
    <form onSubmit={submit} className="flex gap-[10px]" aria-label="Fetch a link">
      <label className="group flex h-[50px] min-w-0 flex-1 items-center gap-3 rounded-[12px] border border-[var(--hairline-bright)] bg-shift-input pl-4 pr-2 shadow-[var(--top-edge)] transition-[border-color,box-shadow] duration-[140ms] focus-within:border-[var(--accent-edge)] focus-within:shadow-[0_0_0_4px_var(--accent-tint)]">
        <LinkIcon />
        <span className="sr-only">Media link</span>
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste a link from X, Instagram, TikTok or another public page"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className="min-w-0 flex-1 bg-transparent text-[14px] text-shift-text outline-none placeholder:text-shift-quiet"
        />
        {!value && (
          <kbd className="shrink-0 rounded-[6px] border border-[var(--hairline-bright)] px-[7px] py-[3px] font-mono text-[11.5px] text-shift-dim">
            ⌘V
          </kbd>
        )}
      </label>
      <Button type="submit" variant="primary" disabled={!valid} className="!h-[50px] !rounded-[12px] !px-6">
        Fetch
      </Button>
    </form>
  );
}

function DropZone() {
  const { dragging, setDragging, openFilePicker, submitUrl, acceptPaths } = useShift();
  return (
    <div
      onClick={openFilePicker}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        // Tauri delivers real file drops to `App`; this covers a dragged link.
        const uri = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
        if (uri && URL_PATTERN.test(uri.trim())) submitUrl(uri.trim());
        else acceptPaths([]);
      }}
      className={[
        "flex min-h-[164px] cursor-pointer flex-col items-center justify-center gap-[14px] rounded-[16px] border-[1.5px] border-dashed px-6 py-6",
        "transition-[border-color,background-color] duration-[180ms] ease-out",
        dragging
          ? "border-[var(--accent-edge)] bg-[var(--accent-tint)]"
          : "border-[var(--link-dash)] bg-[var(--zone-fill)] hover:border-[var(--link-dash-hi)]",
      ].join(" ")}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-[var(--accent-veil)] shadow-[var(--top-edge)]">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="stroke-shift-link" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
        </svg>
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="text-[15px] font-semibold text-shift-text">Drop a file here</div>
        <div className="text-[13px] text-shift-soft">Video, audio, images and GIFs</div>
      </div>
      <Button
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          openFilePicker();
        }}
        aria-keyshortcuts="Meta+O"
      >
        Choose File…
        <span aria-hidden="true" className="font-mono text-[11px] text-shift-soft">⌘O</span>
      </Button>
    </div>
  );
}

/** Where links can come from. Informational only: none of these is a control. */
function PlatformRow() {
  return (
    <div className="flex flex-col items-center gap-[10px]">
      <div className="flex flex-wrap items-center justify-center gap-[6px]" aria-label="Supported link sources">
        {["X", "Instagram", "TikTok", "Other public links"].map((p) => (
          <span
            key={p}
            className="rounded-full border border-[var(--hairline)] px-[10px] py-[3px] text-[11.5px] text-shift-soft"
          >
            {p}
          </span>
        ))}
      </div>
      <div className="text-[11.5px] text-shift-faint">Local files stay on your Mac.</div>
    </div>
  );
}

/**
 * Analysis in flight. There is one honest stage here — the native layer reports
 * nothing finer while it reads a link or a file — and no way to stop it, so
 * there is no step list and no Cancel.
 */
export function Resolving() {
  const { lastInput } = useShift();
  const isUrl = lastInput?.kind !== "file";
  const name = lastInput?.kind === "file" ? lastInput.value.split("/").pop() : lastInput?.value;

  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="flex h-[50px] items-center gap-3 rounded-[12px] border border-[var(--accent-edge)] bg-shift-input px-4 shadow-[var(--top-edge)]">
        {isUrl ? <LinkIcon /> : <FileIcon />}
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-shift-body">{name}</span>
        <Spinner />
      </div>
      <div role="status" aria-live="polite" className="px-1 text-[13px] text-shift-dim">
        {isUrl ? "Resolving link…" : "Reading file…"}
      </div>
      <div className="shift-panel grid grid-cols-[minmax(150px,240px)_1fr] gap-5 p-4" aria-hidden="true">
        <div className="shift-skeleton aspect-video rounded-[10px]" />
        <div className="flex flex-col gap-3 pt-1">
          <div className="shift-skeleton h-3 w-2/5 rounded-[6px]" />
          <div className="shift-skeleton h-[18px] w-4/5 rounded-[6px]" />
          <div className="shift-skeleton h-3 w-3/5 rounded-[6px]" />
        </div>
      </div>
    </div>
  );
}

export function LinkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 stroke-shift-link" strokeWidth="1.8" strokeLinecap="round">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 stroke-shift-link" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
    </svg>
  );
}
