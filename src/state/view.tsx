/**
 * Which mode the window is showing.
 *
 * Purely presentational. The modes are views over the one source and the one
 * export held in `shift.tsx`; nothing here is read by the export, and nothing
 * here is copied from it. Which modes are available is derived from the same
 * flags the export already uses, so the sidebar can never offer something the
 * export would ignore.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useShift } from "./shift";

export type View = "download" | "convert" | "edit" | "resize" | "compress";

export const VIEWS: { id: View; label: string }[] = [
  { id: "download", label: "Download" },
  { id: "convert", label: "Convert" },
  { id: "edit", label: "Edit" },
  { id: "resize", label: "Resize" },
  { id: "compress", label: "Compress" },
];

interface ViewApi {
  view: View;
  available: Record<View, boolean>;
  setView: (v: View) => void;
}

const Ctx = createContext<ViewApi | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
  const s = useShift();
  const [chosen, setChosen] = useState<View>("download");

  // A source is open and editable only while it is loaded. While a job
  // runs, or once it has finished, there is nothing for a mode to act on.
  const loaded = s.screen === "url" || s.screen === "local";
  // A post with several items is downloaded as its native files, so nothing a
  // mode could set would reach them. Only Download applies until it has one.
  const single = !s.urlMedia || s.urlMedia.mediaItems.length === 1;
  const editable = loaded && single;
  const available = useMemo<Record<View, boolean>>(
    () => ({
      download: true,
      convert: editable && s.outputs.length > 0,
      // Trim exists for anything that plays: video, audio and moving GIFs.
      edit: editable && !s.isImage,
      // Shape only means something for an output you can look at.
      resize: editable && s.showAspect,
      // Compression is the image pipeline's alone in v1.1.
      compress: editable && s.isImage && s.compressionChoices.length > 1,
    }),
    [editable, s.outputs.length, s.isImage, s.showAspect, s.compressionChoices.length],
  );

  // A mode that stops applying — a new source, or an audio output picked in
  // Convert — falls back to Download rather than showing controls for nothing.
  const view: View = available[chosen] ? chosen : "download";

  const setView = useCallback(
    (v: View) => {
      if (available[v]) setChosen(v);
    },
    [available],
  );

  // ⌘1–⌘5, in sidebar order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const index = Number(e.key) - 1;
      const target = VIEWS[index];
      if (!target) return;
      e.preventDefault();
      setView(target.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  return <Ctx.Provider value={{ view, available, setView }}>{children}</Ctx.Provider>;
}

export function useView(): ViewApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useView must be used inside ViewProvider");
  return ctx;
}
