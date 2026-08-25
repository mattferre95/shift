# SHIFT — Design Spec

Implementation rules extracted from the approved Claude Design project
(`SHIFT.dc.html`). The design is the visual source of truth; this file records
how it maps onto the real app and where the app necessarily differs.

## Window

920 × 680, centred. The design draws a mock window card on a page background —
in the real app **the window *is* the card**. `titleBarStyle: "Overlay"` +
`hiddenTitle` gives real macOS traffic lights over our own 40px strip, which
carries the centred symbol + `SHIFT` wordmark. Verified at 920 × 681.

## Tokens

All colours are transcribed verbatim into `@theme` in `src/app/index.css`.
Do not introduce values that are not in the design.

| Role | Value |
| --- | --- |
| Window | `oklch(0.16 0.004 195)` |
| Surface (dropzone) | `oklch(0.19 0.005 195)` |
| Chip | `oklch(0.20 0.005 195)` |
| Track / thumbnail | `oklch(0.22 0.006 195)` |
| Input | `oklch(0.13 0.003 195)` |
| Text | `0.96` → `0.94` → `0.90` → `0.62` → `0.55` → `0.50` → `0.45` → `0.42` |
| Emerald | `oklch(0.72 0.15 155)` |
| On emerald | `oklch(0.16 0.02 195)` |
| Danger | `oklch(0.75 0.13 35)` |
| Hairlines | `oklch(1 0 0 / 0.06 · 0.07 · 0.10 · 0.14)` |

Emerald is restrained: selection, focus, progress, drag-over, completion, and
the single Export button. Nothing else.

## Type

Manrope (400–800) and IBM Plex Mono (400–600), **bundled locally** in
`public/fonts` — the app must render identically offline, and its CSP forbids
remote font hosts.

Mono is for anything machine-shaped: durations, dimensions, file sizes, IN/OUT
values, filenames, technical logs. Manrope for everything else.

## Motion

120–220ms, opacity and small translation only. `shift-fade-in` (180ms) on
screen entry, `shift-pulse` on the active stage dot, `shift-sweep` for
indeterminate progress. `prefers-reduced-motion` collapses all of it. No
decorative loops.

## The six states

| State | Component |
| --- | --- |
| A Empty | `features/input/EmptyState.tsx` |
| B URL / C Local | `features/input/DetectedState.tsx` |
| D Processing | `features/jobs/ProcessingState.tsx` |
| E Complete | `features/export/CompleteState.tsx` |
| F Error | `features/export/ErrorState.tsx` |

Hierarchy is fixed and must stay: *what did I give SHIFT → what do I want out →
do I want to modify it → Export.*

## Deliberate differences from the design

Each of these is a PRD requirement the design prototype did not cover, or a
place where the prototype's behaviour was not implementable honestly.

1. **Output-folder control** (bottom left of the detected state). EXP-01 requires
   a clear way to choose the destination. Rendered as quiet text, not a button,
   so it does not compete with Export.
2. **Authorization note** under the URL state. URL-07 requires it.
3. **QUALITY appears only for URL video.** The prototype shows it whenever MP4 is
   selected, including for local files — but a local file has exactly one
   rendition, so those chips would mean *downscale*, and resize is explicitly
   post-V1. It is shown only when the provider reports more than one real
   rendition.
4. **"Extract audio" is derived, not separate state.** In the prototype the chip
   and the OUTPUT row could disagree (picking MP3 in OUTPUT left the chip
   unlit). The chip now reflects `isAudioFormat(format)`, so the two controls
   can never contradict each other. It is hidden for audio-only sources.
5. **Stage dots are the job's real stages**, so the count varies (4 for a URL
   download, 3 for a local convert) instead of the prototype's fixed 5. The
   design renders the dots from a list, so a variable count is native to it.
6. **Clip length readout** next to IN/OUT, and validation errors inline. The
   prototype had no validation.
7. **Missing-sidecar / unreachable-backend notice** replaces the privacy line in
   the empty state when the native layer is broken. A broken install must not
   look like a working one.
8. **Traffic lights are real**, not the design's three drawn circles.

## Rules

Avoid: generic shadcn surfaces, extra boxes, default HTML upload zones, oversized
buttons, large border radii, web-dashboard spacing, gratuitous gradients, random
icons, sidebars, or more green.
