import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "@/lib/ipc";
import type { ExportRequest, UrlMedia } from "@/types";

export interface PlaybackInfo {
  path: string;
  duration: number | null;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
  proxy: boolean;
}

export type PlaybackStatus = "resolving" | "downloading" | "preparing" | "ready";
export type PlaybackTimings = Partial<Record<ipc.PlaybackStage | "playerReady", number>>;

interface PlaybackState {
  key: string;
  info: PlaybackInfo | null;
  busy: boolean;
  error: string | null;
  status: PlaybackStatus | null;
  timings: PlaybackTimings;
}

const displayStatus = (stage: ipc.PlaybackStage): PlaybackStatus => {
  if (stage === "resolvingLink") return "resolving";
  if (stage === "sourceSelected" || stage === "downloadingPreview") return "downloading";
  return "preparing";
};

export function usePlayback(
  input: ExportRequest["input"] | null,
  enabled: boolean,
  knownMedia: UrlMedia | null = null,
) {
  // Preview quality is independent from export quality. A URL gets one
  // lightweight player asset and output/quality chip changes reuse it.
  const key = input?.kind === "url"
    ? JSON.stringify({ kind: input.kind, url: input.url })
    : JSON.stringify(input);
  const requested = useRef<string | null>(null);
  const previousKey = useRef(key);
  if (previousKey.current !== key) { requested.current = null; previousKey.current = key; }
  if (enabled && input) requested.current = key;
  const active = requested.current === key;
  const session = useRef<string | null>(null);
  const generation = useRef(0);
  const startedAt = useRef(0);
  const [revision, retry] = useState(0);
  const [state, set] = useState<PlaybackState>({
    key,
    info: null,
    busy: false,
    error: null,
    status: null,
    timings: {},
  });

  useEffect(() => {
    const current = ++generation.current;
    let id: string | null = null;
    let unlisten: (() => void) | null = null;
    set({ key, info: null, busy: active, error: null, status: active ? "resolving" : null, timings: {} });
    if (active && input) {
      startedAt.current = performance.now();
      const start = async () => {
        unlisten = await ipc.onPlaybackEvent((event) => {
          if (event.playbackId !== id || current !== generation.current) return;
          set((s) => ({
            ...s,
            status: displayStatus(event.stage),
            timings: { ...s.timings, [event.stage]: event.elapsedMs },
          }));
        });
        const created = await ipc.createPlayback(input, knownMedia);
        id = created;
        if (current !== generation.current) { await ipc.releasePlayback(created); return; }
        session.current = created;
        const info = await ipc.preparePlayback(created, false);
        if (current === generation.current) {
          set((s) => ({ ...s, key, info, busy: false, error: null, status: "preparing" }));
        }
      };
      void start().catch((e) => {
        if (id) void ipc.releasePlayback(id);
        if (current === generation.current) {
          session.current = null;
          set({ key, info: null, busy: false, error: ipc.toShiftError(e).message, status: null, timings: {} });
        }
      });
    }
    return () => {
      ++generation.current;
      session.current = null;
      unlisten?.();
      if (id) void ipc.releasePlayback(id);
    };
    // Input and knownMedia are represented by the stable URL/local source key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, revision]);

  const cancel = useCallback(() => {
    ++generation.current;
    if (session.current) void ipc.releasePlayback(session.current);
    session.current = null;
    set({ key, info: null, busy: false, error: "Preview cancelled. Export is still available.", status: null, timings: {} });
  }, [key]);

  const fallback = useCallback(async () => {
    const id = session.current;
    if (!id || state.busy) return;
    if (state.info?.proxy) {
      set((s) => ({ ...s, error: "Playback couldn't start. Export is still available.", status: null }));
      return;
    }
    const current = generation.current;
    set((s) => ({ ...s, info: null, busy: true, error: null, status: "preparing" }));
    try {
      const info = await ipc.preparePlayback(id, true);
      if (current === generation.current) {
        set((s) => ({ ...s, key, info, busy: false, error: null, status: "preparing" }));
      }
    } catch (e) {
      if (current === generation.current) {
        set((s) => ({ ...s, key, info: null, busy: false, error: ipc.toShiftError(e).message, status: null }));
      }
    }
  }, [key, state.busy, state.info]);

  const markReady = useCallback(() => {
    const elapsed = Math.max(0, Math.round(performance.now() - startedAt.current));
    set((s) => ({ ...s, status: "ready", timings: { ...s.timings, playerReady: elapsed } }));
  }, []);

  const current = state.key === key
    ? state
    : { info: null, busy: active, error: null, status: active ? "resolving" as const : null, timings: {} };
  return { ...current, cancel, fallback, markReady, retry: () => retry((n) => n + 1) };
}
