import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { CompressView } from "@/features/compress/CompressView";
import { ConvertView } from "@/features/convert/ConvertView";
import { EditHeader, EditView } from "@/features/edit/EditView";
import { Home } from "@/features/input/Home";
import { ResizeView } from "@/features/resize/ResizeView";
import { PostHeader } from "@/features/social/PostView";
import { SourceResult } from "@/features/input/SourceResult";
import { CompleteState } from "@/features/export/CompleteState";
import { ErrorState } from "@/features/export/ErrorState";
import { ProcessingState } from "@/features/jobs/ProcessingState";
import { ShiftProvider, useShift } from "@/state/shift";
import { VIEWS, ViewProvider, useView, type View } from "@/state/view";

export default function App() {
  return (
    <ShiftProvider>
      <ViewProvider>
        <Window />
      </ViewProvider>
    </ShiftProvider>
  );
}

function Window() {
  useDesktopBehaviour();
  const { screen, dragging, urlMedia, localMedia, analyzing } = useShift();
  const { view } = useView();

  // Whether a failure came from reading the input or from the export after it.
  // Read from the render before the error: analysis is the only path that has
  // `analyzing` set when it fails.
  const failedDuring = useRef<"input" | "export">("input");
  if (screen !== "error") {
    failedDuring.current = analyzing || screen === "empty" ? "input" : "export";
  }

  const loaded = screen === "url" || screen === "local";
  const post = (urlMedia?.mediaItems.length ?? 0) > 1;
  const jobScreen = screen === "processing" || screen === "complete" || screen === "error";
  // The source a job came from keeps its name in the header; an input that
  // failed to open never became one.
  const jobSource = jobScreen && (!!localMedia || !!urlMedia) && !(screen === "error" && failedDuring.current === "input");

  const header = jobSource
    ? post ? <PostHeader /> : <EditHeader sound={false} />
    : loaded && view === "download" && post && !analyzing
      ? <PostHeader />
      : loaded && view !== "download"
        ? <EditHeader sound={view === "edit"} />
        : <Header title={VIEWS.find((v) => v.id === view)?.label ?? ""} />;

  // Modes and the post view use the full workspace; Download and the job
  // screens are a centred column, so a wider window adds margin, not width.
  const fullWidth = loaded && (view !== "download" || (post && !analyzing));

  return (
    <div className="flex h-full bg-shift-window">
      <Sidebar />
      <div className="shift-workspace flex min-w-0 flex-1 flex-col">
        {header}
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <div className={fullWidth ? "relative h-full w-full" : "relative mx-auto h-full w-full max-w-[920px]"}>
            {screen === "empty" && <Home />}
            {loaded && <ModeView view={view} />}
            {screen === "processing" && <ProcessingState />}
            {screen === "complete" && <CompleteState />}
            {screen === "error" && <ErrorState during={failedDuring.current} />}
          </div>

          {/* A file dragged anywhere over the window, not just the drop target. */}
          {dragging && screen !== "processing" && (
            <div className="pointer-events-none absolute inset-0 border-2 border-[var(--accent-edge)] bg-[var(--accent-wash)]" />
          )}
        </main>
      </div>
    </div>
  );
}

/** One view over the open source; every one of them shares the same export. */
function ModeView({ view }: { view: View }) {
  switch (view) {
    case "download":
      return <SourceResult />;
    case "convert":
      return <ConvertView />;
    case "edit":
      return <EditView />;
    case "resize":
      return <ResizeView />;
    case "compress":
      return <CompressView />;
  }
}

/**
 * Desktop conventions: ⌘V paste a link, ⌘O choose a file, ⌘⇧E export,
 * Esc cancel or dismiss. Text-editing shortcuts are never intercepted.
 */
function useDesktopBehaviour() {
  const s = useShift();

  // Native file drops carry real paths; the webview's own drop event does not.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") s.setDragging(true);
        else if (event.payload.type === "leave") s.setDragging(false);
        else if (event.payload.type === "drop") {
          s.setDragging(false);
          if (s.screen !== "processing") s.acceptPaths(event.payload.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.screen]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal a paste aimed at the IN/OUT fields.
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (s.screen === "processing") return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (/^https?:\/\//i.test(text.trim())) {
        e.preventDefault();
        s.submitUrl(text.trim());
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (s.screen !== "processing") s.openFilePicker();
        return;
      }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        s.startExport();
        return;
      }
      if (e.key === "Escape") {
        if (editing) {
          (target as HTMLInputElement).blur();
          return;
        }
        if (s.screen === "processing") s.cancel();
        else if (s.screen !== "empty") s.reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);
}
