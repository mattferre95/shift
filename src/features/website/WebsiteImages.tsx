import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Notice } from "@/components/Notice";
import { Spinner } from "@/components/Spinner";
import { HomeFrame } from "@/features/input/Home";
import * as ipc from "@/lib/ipc";
import { useShift } from "@/state/shift";

export function WebsiteImages() {
  const { website, scrapeWebsite, outputDir } = useShift();
  if (!website) return null;

  const { page, error, url } = website;
  if (page) return <ImageGallery key={page.url} page={page} outputDir={outputDir} />;

  return (
    <HomeFrame>
      <p className="m-0 truncate font-mono text-[13px] text-shift-dim" title={url}>{url}</p>
      {error ? (
        <>
          <Notice tone="danger">{error.message}{error.hint && <div>{error.hint}</div>}</Notice>
          <Button className="self-start" onClick={() => scrapeWebsite(url)}>Try Again</Button>
        </>
      ) : (
        <div className="flex items-center gap-3 text-[14px] text-shift-text" role="status">
          <Spinner /> Finding images…
        </div>
      )}
    </HomeFrame>
  );
}

function ImageGallery({ page, outputDir }: { page: ipc.WebsitePage; outputDir: string }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<ipc.WebsiteDownloadProgress | null>(null);
  const [result, setResult] = useState<ipc.WebsiteDownloadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(false);
  const job = useRef<string | null>(null);
  const groups = useMemo(() => {
    const groups = new Map<string | null, ipc.WebsiteImage[]>();
    for (const image of page.images) {
      const items = groups.get(image.group);
      if (items) items.push(image);
      else groups.set(image.group, [image]);
    }
    return [...groups];
  }, [page]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (job.current) void ipc.cancelJob(job.current).catch(() => {});
    };
  }, []);

  async function download() {
    if (busy || selected.size === 0) return;
    const images = page.images.filter((image) => selected.has(image.url));
    setBusy(true);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const parent = await open({ directory: true, multiple: false, defaultPath: outputDir || undefined });
      if (typeof parent !== "string" || !parent || !live.current) return;

      const id = crypto.randomUUID();
      job.current = id;
      setResult(null);
      setProgress({ current: 1, total: images.length });
      const result = await ipc.downloadWebsiteImages(page, images, parent, id, (value) => {
        if (live.current) setProgress(value);
      });
      if (live.current) setResult(result);
    } catch (error) {
      if (live.current) setError(ipc.toShiftError(error).message);
    } finally {
      job.current = null;
      if (live.current) {
        setBusy(false);
        setStopping(false);
        setProgress(null);
      }
    }
  }

  function cancel() {
    if (!job.current) return;
    setStopping(true);
    void ipc.cancelJob(job.current).catch((error) => {
      if (live.current) {
        setStopping(false);
        setError(ipc.toShiftError(error).message);
      }
    });
  }

  function toggle(url: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  const total = page.images.length;
  const savedFolder = result?.folder;
  return (
    <section className="shift-enter flex h-full min-h-0 flex-col" aria-label="Website images">
      <div className="shrink-0 border-b border-[var(--hairline-faint)] px-6 py-4">
        <h2 className="m-0 truncate text-[18px] font-semibold text-shift-text" title={page.title}>{page.title}</h2>
        <p className="mb-0 mt-1 truncate font-mono text-[12px] text-shift-soft" title={page.url}>{page.url}</p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-6 py-3">
        <span className="text-[13px] text-shift-dim" role="status">{selected.size} of {total} selected</span>
        <div className="flex gap-3">
          <Button size="sm" disabled={busy || selected.size === total} onClick={() => setSelected(new Set(page.images.map((image) => image.url)))}>Select All</Button>
          <Button size="sm" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
        {page.truncated && <Notice tone="warning">Showing the first {total} images found on this page.</Notice>}
        {groups.map(([group, images]) => (
          <section key={group ?? ""} className="mb-4" aria-label={group ? images[0].label : "Page images"}>
            {(group || groups.length > 1) && (
              <h3 className="mb-2 mt-1 text-[13px] font-semibold text-shift-text">
                {group ? images[0].label : "Page images"}
              </h3>
            )}
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3 p-0">
              {images.map((image) => (
                <ImageTile
                  key={image.url}
                  image={image}
                  pageUrl={page.url}
                  checked={selected.has(image.url)}
                  disabled={busy}
                  onToggle={() => toggle(image.url)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t border-[var(--hairline)] px-6 py-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {result && (
          <Notice
            tone={result.failed.length ? "warning" : "info"}
            action={savedFolder ? <Button size="sm" onClick={() => {
              void ipc.openOutputFolder(savedFolder).catch((error) => setError(ipc.toShiftError(error).message));
            }}>Show in Finder</Button> : undefined}
          >
            {result.cancelled && "Download stopped. "}{result.saved} {result.saved === 1 ? "image" : "images"} saved
            {savedFolder && <> in <span className="font-mono">{savedFolder.split("/").pop()}</span></>}.
            {result.failed.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer">{result.failed.length} failed</summary>
                <ul className="my-1 max-h-24 overflow-y-auto pl-5">
                  {result.failed.map((item, i) => <li key={i}>{item.name} · {item.reason}</li>)}
                </ul>
              </details>
            )}
          </Notice>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[12px] text-shift-soft" role="status">
            {progress ? `Downloading image ${progress.current} of ${progress.total}…` : <>Folder <span className="font-mono">{page.folder}</span></>}
          </span>
          {progress ? (
            <Button onClick={cancel} disabled={stopping}>{stopping ? "Stopping…" : "Stop Download"}</Button>
          ) : (
            <Button variant="primary" onClick={() => void download()} disabled={busy || selected.size === 0}>
              {selected.size === 0 ? "Download Images" : `Download ${selected.size} ${selected.size === 1 ? "Image" : "Images"}…`}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function ImageTile({ image, pageUrl, checked, disabled, onToggle }: {
  image: ipc.WebsiteImage;
  pageUrl: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const tile = useRef<HTMLLIElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      void ipc.websiteImagePreview(pageUrl, image.previewUrl)
        .catch((error) => image.previewUrl === image.url ? Promise.reject(error) : ipc.websiteImagePreview(pageUrl, image.url))
        .then((data) => { if (live) setSrc(data); })
        .catch(() => { if (live) setUnavailable(true); });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer?.disconnect();
      load();
    }, { rootMargin: "160px" });
    if (observer && tile.current) observer.observe(tile.current);
    else load();
    return () => { live = false; observer?.disconnect(); };
  }, [pageUrl, image.previewUrl, image.url]);

  return (
    <li ref={tile}>
      <label className={`relative block overflow-hidden rounded-[10px] border bg-shift-panel focus-within:outline focus-within:outline-shift-link ${checked ? "border-shift-link" : "border-[var(--hairline)]"} ${disabled ? "" : "cursor-pointer hover:border-shift-link"}`}>
        <div className="flex aspect-square items-center justify-center overflow-hidden bg-shift-track">
          {src && !unavailable ? (
            <img src={src} alt="" className="h-full w-full object-contain" draggable={false} onError={() => setUnavailable(true)} />
          ) : (
            <span className="px-2 text-center text-[11px] text-shift-quiet">{unavailable ? "Preview unavailable" : "Image"}</span>
          )}
        </div>
        <input
          type="checkbox"
          aria-label={`Include ${image.stem}`}
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="absolute left-2 top-2 h-4 w-4 accent-shift-accent"
        />
        <span className="block truncate px-2 py-2 font-mono text-[11px] text-shift-dim" title={image.label}>{image.stem}</span>
      </label>
    </li>
  );
}
