# SHIFT — Design Spec (v1.1)

**SHIFT™ — Anything in. Anything out.**

This file describes the interface as it is implemented. The approved Claude
Design project (`SHIFT v3.dc.html`) is the visual reference; where the
prototype showed something SHIFT does not do, the app follows the product, not
the picture (see *Deliberate differences* at the end).

Tokens live in `src/app/index.css` and nowhere else. Do not introduce a value
that is not listed here.

## Direction

A local-first macOS utility. Dark midnight surfaces, one electric-blue accent,
system type, and the media itself as the largest thing on screen. Controlled
rather than decorative: one soft pool of light at the top of the workspace, no
backdrop blur, no gradient text, small glows only on the primary button. It
should never read as a SaaS dashboard.

## Window

980 × 680 by default, 780 × 560 minimum (enforced in `tauri.conf.json`).
`titleBarStyle: "Overlay"` gives real traffic lights over the sidebar; the
native window background is `#06070B` so nothing flashes before first paint.

Every screen works at the minimum size: nothing overflows horizontally, the
primary action is always on screen, and inspector bodies scroll above a pinned
action rather than pushing it off the bottom.

## Tokens

### Surfaces

| Role | Value |
| --- | --- |
| Base (window) | `#06070B` |
| Sidebar | `#050608` |
| Recessed field | `#090A0D` |
| Surface (panels) | `#0F121A → #080A0E` |
| Control | `#141822 → #0E1118` |
| Track / thumbnail ground | `#141822` |

### Text

| Role | Value |
| --- | --- |
| Primary | `#EEF1F6` |
| Body | `#C9CFD9` |
| Secondary | `#9AA3B2` |
| Field label | `#8A93A3` |
| Tertiary | `#7D8696` · `#6B7383` · `#525A68` |

### Accent and status

| Role | Value |
| --- | --- |
| Accent | `#2F6BFF` |
| Primary button | gradient `#5A8DFF → #3171FF → #2459EC`; hover `brightness(1.12)`; pressed `#2459EC` |
| Link / active icon | `#8FB2FF`, hover `#B5CCFF`; nav icon `#A9C1FF` |
| Selected fill | `rgba(91,140,255,.34) → rgba(47,107,255,.12)`, border `#2F6BFF` |
| Focus ring | 2px `rgba(91,140,255,.6)`, keyboard focus only |
| Success | `#3DD68C` |
| Warning | `#FFB86B` |
| Error | `#FF7A7A` |

Status colours are used for words and small marks, never to flood a panel.
Green appears only for real completion; amber only for the upscale warning
and amber notices; red only for errors and blocking validation.

### Borders

White at low alpha: `0.06` (header and sidebar rules), `0.07` (section rules,
chips), `0.085` (controls), `0.10` (hovered controls). Controls carry a 1px
top highlight, `inset 0 1px 0 rgba(255,255,255,.06)`.

### Type

System faces only — nothing is bundled.

- **Sans:** `-apple-system, BlinkMacSystemFont, "SF Pro Text", …` for all UI.
- **Mono:** `ui-monospace, "SF Mono", …` for timecodes, sizes, dimensions,
  filenames, the build label and technical details. Numbers are tabular.

Scale in use: 28/600 home headline · 22/600 conversion values · 19/600 job
headings · 17/600 result titles · 15/600 header title · 13–13.5 body and
controls · 11.5/500 field labels · 10–11 badges and the build label.

### Radius and heights

Radii: 6 (badges, small fields) · 8 (chips, small buttons) · 10 (buttons,
tiles, cards) · 12 (link field) · 14 (preview stages) · 16 (panels and the drop
zone).

Heights: nav row 36 · chip 30 · button 42 · small button 32 · link field 50.

## Shell

- **Sidebar** — 200px. An empty draggable strip for the traffic lights, the
  `SHIFT™` wordmark, the five modes (Download, Convert, Edit, Resize,
  Compress) with ⌘1–⌘5 hints, and the build label pinned to the foot on one
  line (`SHIFT v<version> · <sha>`, with `-dirty` on uncommitted builds). There is no Settings item.
- **Modes are views over one source.** There is one loaded source and one
  export. Availability is derived from the export's own state: Convert, Edit,
  Resize and Compress need a loaded single source; Edit needs something that
  plays; Resize needs an output with a shape; Compress needs an image. A post
  with several items offers Download only. While a job runs, finishes or
  fails, no mode is drawn as current.
- **Header** — 48px, a window drag region. In Download it names the mode; in
  the other modes and the job screens it names the source with its real
  metadata (type · dimensions · duration · size · container · audio). Edit
  puts the Sound control on its right.
- **Workspace** — modes use a two-column grid: content, then an inspector of
  256px (232px below 900px wide). Download and the job screens are a centred
  column that scrolls when it does not fit.

## Shared components

- **Button** — primary (gradient, the one action per screen), secondary
  (control surface, hairline border), text (link colour). A disabled primary
  loses its colour and glow and reads as a quiet dark control.
- **Chip** — 30px, 8px radius; selected uses the selected fill and accent
  border. Used for output formats and quality.
- **Segmented** — a recessed well of buttons; the selected one takes the
  accent gradient. Used for Fill/Fit, duration presets and loop size.
- **Switch** — 36 × 22, accent gradient when on, `#24262C` when off.
- **Panel / Inspector / Field / SummaryRow** — 16px panels on the surface
  gradient. The inspector has a title row, a scrolling body and a pinned
  footer for the primary action.
- **Notice** — a bordered one-line message with an icon; danger, warning or
  info tone.
- **Spinner** — the single activity indicator, a small turning ring. It never
  measures anything.

## Screens

### Download (Home)

Headline "Anything in. Anything out." and one line beneath it; the link field
(Fetch is disabled until the text is an http(s) address); a dashed drop zone
with **Choose File… ⌘O**; the supported link sources (X, Instagram, TikTok,
Other public links) as plain, non-interactive labels; "Local files stay on your
Mac." A broken engine replaces the source labels with a danger notice.

While a link or file is being read: the input in a field-style row with a
spinner, "Resolving link…" or "Reading file…", and a placeholder card. There
are no invented steps and no Cancel (analysis cannot be stopped).

A loaded single source shows a result card: thumbnail with duration, platform
and author for links, title, real metadata, the link preview's real stage,
format chips, quality chips when the provider has several renditions, a line
of settings applied in other modes, shortcuts to the applicable modes, and the
primary **Download…** / **Export…**. Links carry the authorization note.

### Multi-item posts

The collection on the left in provider order — 4:5 tiles with position,
type badge (`VIDEO · 00:28` / `IMAGE`) and a checkbox — and the active item on
the right. Choosing a tile makes it active; the checkbox decides whether it
downloads. Unchecked tiles are dimmed; the active tile has a link-colour ring.
A missing or broken thumbnail shows the media type instead. **Download N
Selected…** opens the folder picker; with nothing selected it is disabled and
says why. No format, trim or size controls: items are saved as posted.

### Edit

The preview fills the column above one controls panel. Trim is the export's
own switch — opening Edit never turns it on. With Trim on: play/pause, Play
Selection, the time readout, the timeline, IN/OUT fields with Set IN / Set
OUT, the duration presets with "OUT follows IN" while a preset is active, and
the status line (selected length or the validation error).

The timeline is a 30px track; the selected range is outlined in accent; the
IN/OUT handles are solid accent bars; the playhead is a white line. The range
inputs are invisible 18px hit areas and everything visible is drawn in a track
inset by half a thumb so handles land exactly under them. There is no
filmstrip.

The inspector holds Format, Quality (real renditions only), Loop size for
GIF/animated WEBP, the applied-settings summary, and **Export Clip…** /
**Export…** / **Download…**.

### Resize

A large framing stage drawn from `aspect_preview`'s content box — the frame is
outlined in accent; under Fill the cropped part stays visible, dimmed, outside
the outline; under Fit the padding is black, or a checkerboard when the output
keeps transparency. Below it, Source → Output dimensions in mono. The
inspector holds the seven ratio tiles (each draws its own shape), Fill/Fit,
Freeform width × height with a proportion lock, and the upscale warning. There
is no crop positioning.

### Compress

Images only. The source image with a "Source preview" tag and the note that
encoded quality is not previewed. The inspector holds the format chips, then
the levels for that format as cards — None / Light / Balanced / Strong, or
None / Optimize for PNG — with a qualitative strength mark, the AVIF
transparency note when it applies, the original size, and **Compress Image…**.
No size is ever predicted; the real one appears on Complete.

### Convert

Source → output in large type over the format choices, grouped as Video,
Loop, Audio and Image, from the export's own output list. WEBP is a loop from
moving media and an image from a still. The inspector shows the chosen format,
the loop size when it applies, and what other modes have set.

### Processing

The source and its target format, the real stage label as the heading, a
determinate bar with a percentage only when the native layer reports one for
the current stage, otherwise an indeterminate sweep, "Step N of M" from the
real plan, the output name, the destination for single exports, and Cancel.

### Complete

A small success mark, "Export complete" or "Download complete", the output
name, then real facts only: format, original and output size with the change
worked out from the two measured sizes, total size for multi-item downloads,
the folder, and whether streams were copied without re-encoding. **New
Shift** and **Show in Finder**.

### Error

A label saying what failed (export, download, file or link), the plain
message, the input, the hint, then actions: **Paste Another Link** / **Choose
Another File…** / **Start Over**, and **Try Again** after an input failure or
**Reopen File / Reopen Link** after an export failure (retry repeats the input,
not the export). Technical details stay collapsed, in mono, wrapping and
scrolling within the panel.

## Motion

120–220ms, opacity and small translation. A 180ms fade on screen entry, the
indeterminate sweep, the spinner, and a slow sheen on loading placeholders.
`prefers-reduced-motion` collapses all of it.

## Deliberate differences from the design

1. **No batch queue.** Convert is one source and one export.
2. **No video compression or size estimates.** Compress is image-only; sizes
   appear only after export.
3. **No filmstrip** on the timeline, no compressed before/after slider, no
   Settings, no Open in Browser.
4. **Fetching shows one honest stage**, not three invented ones.
5. **Multi-item posts** have no format or "Save as Convert" choice: items are
   saved as posted.
6. **Real controls the prototype omitted** have a home: typed IN/OUT, Set
   IN/OUT, Play Selection, Loop size, Freeform lock, PNG Optimize, the AVIF
   note, preview status with Cancel/Retry, the authorization note, the engine
   notice, and Technical details.
7. **Traffic lights are real**, not drawn.
8. **Lighting is toned down**: one 7% glow, no blur, no gradient text.
