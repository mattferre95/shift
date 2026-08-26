import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { TitleBar } from "@/components/TitleBar";
import { DetectedState } from "@/features/input/DetectedState";
import { EmptyState } from "@/features/input/EmptyState";
import { CompleteState } from "@/features/export/CompleteState";
import { ErrorState } from "@/features/export/ErrorState";
import { ProcessingState } from "@/features/jobs/ProcessingState";
import { ShiftProvider, useShift } from "@/state/shift";

export default function App() {
  return (
    <ShiftProvider>
      <Window />
    </ShiftProvider>
  );
}

function Window() {
  useDesktopBehaviour();
  const { screen, dragging } = useShift();

  return (
    <div className="flex h-full flex-col bg-shift-window">
      <TitleBar />
      <main className="relative flex-1 overflow-hidden">
        {/* The utility stays compact: enlarging the window adds margin around
            the content rather than stretching every row across it. */}
        <div className="relative mx-auto h-full w-full max-w-[920px]">
          {screen === "empty" && <EmptyState />}
          {(screen === "url" || screen === "local") && <DetectedState />}
          {screen === "processing" && <ProcessingState />}
          {screen === "complete" && <CompleteState />}
          {screen === "error" && <ErrorState />}
        </div>

        {/* A file dragged anywhere over the window, not just the drop target. */}
        {dragging && screen !== "processing" && (
          <div className="pointer-events-none absolute inset-0 border-2 border-[oklch(0.72_0.15_155_/_0.45)] bg-[oklch(0.72_0.15_155_/_0.05)]" />
        )}
      </main>
    </div>
  );
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
