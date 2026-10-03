# SHIFT — Architecture

Implementation boundaries and the decisions that were made while building V1.
The PRD (`private/SHIFT_PRD_V1.docx`) defines *what*; this defines *how*.

## Shape

```
React (presentation, intent)          src/
        │  narrow, typed Tauri commands
        ▼
Rust (jobs, validation, processes)    src-tauri/src/
        │  explicit argument arrays
        ▼
yt-dlp · ffprobe · ffmpeg             bundled sidecars
```

The frontend can only describe *what it wants*: an input, an output format, an
optional IN/OUT pair, a destination. It cannot pass a flag, an argument array,
or a shell string. Ten commands make up the entire IPC surface
(`src-tauri/src/commands/mod.rs`).

## Modules

| Module | Owns |
| --- | --- |
| `validation` | URLs, timestamps, clip bounds, paths. Everything user-supplied becomes structured data here first. |
| `process` | Binary resolution, spawning, cancellation. The only place a child process is created. |
| `providers` | URL sources behind `UrlProvider`. yt-dlp is the first implementation, not the interface. |
| `media::ffprobe` | The single source of truth about a file's streams. |
| `media::aspect` | Shape: ratios, Fill/Fit, freeform sizes, and the filter chain each implies. The only place that arithmetic happens. |
| `media::preview` | Small cached derivatives the interface draws framing previews with. Never an export input. |
| `media::profiles` | Every codec and container decision, including the loop presets. Nothing else builds FFmpeg arguments. |
| `media::ffmpeg` | Running a plan and normalizing its progress. |
| `jobs` | The state machine, the registry, and the pipeline runner. |
| `filesystem` | Per-job temp dirs, filename sanitizing, collision-safe output, the final move. |
| `settings` | A small JSON file. No database. |
| `errors` | Normalization into `{ code, message, hint, technical }`. |

## Decisions

**Actions are data.** A job carries `ActionSpec[]` (`Analyze`, `Download`,
`Trim`, `Convert`, `ExtractAudio`, `ConvertImage`, `CompressImage`, `MakeLoop`)
and they travel to the UI on every event. Adding Crop or Normalize later means
extending that enum and `media::profiles`, not adding a screen flow.

**Trimming always re-encodes video.** A stream copy can only cut on keyframes,
which would silently hand the user a different range than they typed. Input-side
`-ss` before `-i` is frame-accurate when re-encoding and still seeks fast.
Verified: a 2.000 → 4.500 request produces 2.5s ±0.15
(`tests/media_pipeline.rs::trims_accurately`).

**Conversion remuxes when it can.** `profiles::build_plan` compares the probed
codecs against the target container and stream-copies when they fit. H.264/AAC
MP4 → MOV is a copy; anything → WEBM transcodes.

**URL clips download first, then trim.** `--download-sections` is faster but
only reliable on some extractors. V1 takes the predictable path. Revisit per
provider once there is a second provider to compare against.

**A public post is an ordered collection of media.** `UrlProvider::analyze`
returns a `PostResult` containing `PostMedia` entries, each with its own type,
source, dimensions, duration, thumbnail and quality choices. Ordinary URLs are
the one-item case. X, Instagram and TikTok sometimes expose images or carousel
order only in public page metadata, so the yt-dlp provider parses that metadata
as a narrow fallback while yt-dlp continues to own network acquisition. A
single active item feeds preview and conversion; multiple selected items are
downloaded to one folder with their native extensions. Every thumbnail uses a
per-item cache directory, and resetting the shift removes the whole post cache.

**Progress is never invented.** FFmpeg's `-progress` stream divided by a known
duration is a real percentage. yt-dlp reports bytes via `--progress-template`;
when the total is unknown the provider reports `None` and the UI falls back to
stage position with an indeterminate sweep.

**WEBP is decided by the source, not the format.** WEBP is a still image from a
photo and an animation from a video, so it is in both `is_image` and
`is_animation`. The consequence is that the *input* chooses which pipeline runs
(`jobs::execute`), never the output format on its own — asking the format alone
would send a video headed for animated WebP into the still-image pipeline.

**A GIF is built from a palette, not a filter.** GIF holds 256 colours per frame
and has no interframe compression, so quality is almost entirely a palette
question. A single pass lets FFmpeg pick a fixed heuristic palette and the result
bands badly; `palettegen` + `paletteuse` in one `-filter_complex` builds the
palette from the actual footage. `stats_mode=full` and `dither=sierra2_4a` are
FFmpeg's own defaults, written out explicitly so the choice is visible and cannot
drift. Measured on both flat UI capture and smooth gradients they were best or
joint-best on size *and* SSIM; bayer dithering was consistently larger and worse.

**Loop frame rates divide 100.** GIF stores each frame's delay in hundredths of
a second. A "sensible" 12 or 15 fps encodes as alternating 8/9cs or 7/6cs delays
— visible judder, and a real rate that is not the one requested. The three
presets are 10, 12.5 and 20 fps (10cs, 8cs, 5cs), which is why they are exposed
as Small/Standard/Large rather than as a frame-rate field a user could set to
something GIF cannot store. Verified in
`tests/media_pipeline.rs::a_gif_really_encodes_and_loops_uniformly`.

**Loop limits are per format, because the formats do not cost the same.**
Measured at the Standard preset on full-frame motion: GIF is 1.8 MB at 10s,
2.7 MB at 15s, 5.5 MB at 30s; animated WEBP is 0.7 / 1.1 / 2.1 MB at the same
lengths. A 30-second WEBP is smaller than a 15-second GIF. So GIF is capped at
**15s** and proposes **10s**, while animated WEBP keeps **30s** and proposes
**15s** — holding WEBP to GIF's ceiling would be an arbitrary penalty. The UI
arms the trim in plain sight when a loop is chosen on a longer source, and
re-arms when moving *between* loop formats, so a 20s WEBP range cannot strand
the user on a disabled Export button after switching to GIF.

**An audio copy has to mean the same thing, not merely be legal.**
`audio_codec_fits` answers "is this codec allowed in this container", which is
the right question when muxing a video. Audio-only exports ask a stricter one in
`audio_copy_is_faithful`: MP3 inside an `.m4a` is legal and nobody wants it, and
ALAC inside an `.m4a` is Apple Lossless — a different product from the AAC the
M4A chip promises, at many times the size. Both re-encode. Only a genuine AAC
source is copied, which makes extracting audio from an MP4 a lossless container
change rather than a second generation.

**Raw `.aac` is an input, not an output.** It is the same codec M4A already
carries, in a container macOS handles worse. Offering both would put a codec
question in front of the user, which the product exists to avoid.

**AVIF is withheld from transparent sources.** The bundled libaom-av1 advertises
no alpha pixel format at all — even `-pix_fmt yuva420p` silently falls back and
flattens transparency onto whatever sat behind it. `sips` already reports
`hasAlpha` in the probe SHIFT was making anyway, so `profiles::image_options`
simply does not offer the chip, and `image::build_plan` refuses the same case as
a backstop. WEBP keeps alpha and is offered in its place.

**AVIF encodes at `-cpu-used 6`.** libaom's default effort took 19.6s on a 12 MP
photograph and produced 1,317,118 bytes; `-cpu-used 6` took 2.3s and produced
1,312,226 — 8.6x faster and marginally smaller. The default would make the app
look hung on any phone photo, so the preset is covered by a timing test rather
than a comment.

**Input formats are wider than output formats.** ffprobe and FFmpeg already
demux MKV, AVI, M4V, FLAC, AIFF, OGG and Opus, and what a file can become is
decided by its streams in `profiles::options_for`, never by its extension.
Refusing to read a container FFmpeg handles perfectly would be an artificial
limit.

**A ratio change is a crop or a pad, never a stretch.** `media::aspect` resolves
a request against the source's real dimensions and returns a `Reframe`: an
optional resample, a canvas, and which of crop or pad joins them. There is no
Stretch mode to select because there is no code path that could produce one —
both axes always move by the same factor, and a test asserts it across every
ratio and source shape.

**A preset ratio can only ever discard.** The canvas is derived from the
source's own pixels, so Fill on 1920x1080 to 9:16 is a 608x1080 crop rather than
an invented 1080x1920. Only Freeform can enlarge, because only there has the
user named an exact size — and it reports `upscales` so the UI can say so before
the export rather than after.

**Fit is held to the source's longest edge.** Padding 16:9 into 9:16 at native
size would be a 1920x3413 canvas: correct, absurd, and expensive. The canvas
instead takes the source's longest edge and the picture shrinks to sit inside
it, so a 1080p clip letterboxes to a sane 1080x1920.

**Crop before scale, scale before palette.** `Reframe::capped` puts a pure crop
at full resolution and the resize after it, because shrinking pixels that are
about to be discarded is wasted work; where a resample already exists the cap is
folded into it rather than adding a second one. In a loop the whole reframe runs
after `fps` and before `palettegen`, so the expensive pass only ever sees pixels
that survive into the finished file.

**A loop preset caps the longest edge, not the width.** Once reframing makes
portrait loops ordinary, a width-only cap would let a 9:16 GIF carry three times
the pixels of a 16:9 one at the same preset — and the length limits are
calibrated on weight.

**Images reframe through the existing conversion, not around it.** The transform
runs as its own lossless PNG pass; the format's own encoder then does the
encoding with the quality ladder it already had. One conversion path, not two.

**Fit pads with nothing where the format can hold nothing.** PNG and WEBP get
transparent bars, JPEG and AVIF get black, and video always gets black. The
colour is not cosmetic: asked to pad with `black@0` on a frame that has no alpha
channel, FFmpeg drops the transparency and writes opaque black without
complaint, so `filters_with` emits `format=rgba` ahead of the pad and the image
pass forces an rgba intermediate. Either way the *source's* own transparency is
untouched — the picture and its bars are separate questions.

**A resample pins the pixels square.** FFmpeg's `scale` rewrites the sample
aspect ratio to preserve the display aspect it believes it is changing, which
leaves a reframed video with non-square pixels a player then stretches back —
a quarter of a percent, but a stretch. Every scale is followed by `setsar=1`.

**The preview is the export's own geometry, drawn.** `Reframe::content_box`
returns one shape for both modes — the source, at the size it meets the canvas,
offset from the canvas's corner — and that single computation produces both the
`crop`/`pad` offsets FFmpeg is given and the CSS the preview is laid out with.
The offsets are written into the filter string as concrete numbers rather than
`(in_w-out_w)/2` precisely so the two cannot drift: FFmpeg evaluates that
expression in floating point and rounds it its own way, which can land a pixel
from where the preview draws. A test asserts the filter string equals the
content box for every ratio, mode and source shape.

The same shape is what a draggable crop would move later: dragging changes
`offset`, and neither the filters nor the preview need to learn anything new.

**A preview never encodes.** `media::preview` makes one ~50 KB derivative per
source — `sips` for a still, a single seeked frame for video — cached by path,
size, mtime and whole second. Cycling 16:9 → 9:16 → 1:1 re-uses it every time;
only a new source or a moved IN point costs work, and no palette is ever built
merely to look at framing.

**The derivative is inlined, not served.** Handing the webview a file means
getting a scope glob, a canonicalised path and a CSP entry to agree, and a
mismatch fails silently as a blank image. A `data:` URI has none of those moving
parts, and at this size costs nothing.

**The dimensions on screen come from the same code as the export.**
`aspect_preview` is a command rather than a second implementation in TypeScript,
and it takes the loop preset too: a 9:16 crop of a 1280x720 clip is 404x720 as a
video and 268x480 as a Standard GIF, and the label has to show the one the file
will actually have.

**An animated GIF is a video source, on its own clock.** A GIF demuxes as a
silent video stream, so it takes the ffprobe path and is offered video and loop
outputs only. Its frame delays are whole hundredths of a second, and passing
those timestamps straight through looked right but failed three ways on a
variable-delay fixture: x264's B-frames pushed DTS far negative across the long
gaps and the MP4 muxer recorded 1.5s for a 2.17s animation, so a player stops
early; the last frame of a variable-rate encode got `1/r_frame_rate` instead of
its own delay, losing any final hold; and an input `-ss` discarded the frame
still on screen at IN because it began earlier — invisible at 30 fps, glaring
on a GIF that holds a frame for a second. Resampling to 100 fps is GIF's native
grid, so it moves no frame, and it removes all three; the repeats cost almost
nothing as H.264 skip blocks. A GIF is therefore trimmed in the filter graph
(`fps=100,trim,setpts`) and never input-seeked, on the video and loop paths
alike. The same clock and a black `-trans_color` go into the preview proxy, so
the player cannot disagree with the export. The regression fixture is written
byte for byte by the test itself, because FFmpeg's GIF muxer snapped the delays
it was asked for onto its own grid.

**An odd-sized source is cropped even, not scaled.** yuv420p subsamples chroma
by two and libx264 refuses odd dimensions outright — a 201x151 GIF produced no
file. Dropping the stray column or row resamples nothing and keeps pixels
square.

**Cancellation kills a process group, not a process.** yt-dlp spawns its own
children. Each job owns one `CancelToken`; the child is spawned into its own
process group and cancel sends `SIGTERM` to the whole group.

## Two things that cost real time

**`pre_exec` deadlocks a GUI app.** Setting the process group with a `pre_exec`
closure calling `setsid()` forces the standard library off `posix_spawn` and
onto `fork` + `exec`. A `fork` inside this Cocoa app produces a single-threaded
child holding locks (malloc, the Objective-C runtime) that other threads owned
at fork time; it deadlocks before ever reaching `exec`. Tests passed because
tests are not Cocoa apps. The fix is `Command::process_group(0)`, which is a
posix_spawn attribute, so no fork happens. **Never add `pre_exec` here.**

**A hardcoded CSP breaks IPC.** Tauri appends the IPC and asset origins to the
CSP it injects from `tauri.conf.json`, but it cannot patch a `<meta>` tag in
`index.html`. A hardcoded meta CSP silently blocked every `invoke`. **Define the
CSP only in `tauri.conf.json`.**

## Sidecars

`scripts/fetch-sidecars.sh` downloads all three into `src-tauri/binaries/`.
They are not committed.

- **ffmpeg / ffprobe** — static arm64 builds, shipped as Tauri `externalBin`,
  landing in `Contents/MacOS/`.
- **yt-dlp** — the **directory** build (`yt-dlp_macos.zip`), shipped as a bundle
  resource in `Contents/Resources/ytdlp/`. The single-file build costs ~11
  seconds *per invocation* on macOS (it unpacks itself every launch); the
  directory build starts in ~0.35s after a one-time warm-up. That was the
  difference between a 40-second analysis and an 8-second one.

`process::resolve` looks in `Contents/MacOS`, then `Contents/Resources`, then
the dev checkout, then `PATH`. A packaged build never reaches the `PATH` arm;
it exists so a development machine works before sidecars are fetched.

## Packaging

`npm run tauri build` produces `SHIFT.app` and a DMG. The app is ~254 MB,
almost entirely sidecars (ffmpeg and ffprobe are ~63 MB each, yt-dlp ~124 MB).

Still open before public distribution:

- **Codesigning and notarization.** The build is currently ad-hoc signed.
  Distribution needs a Developer ID identity, `--options runtime`, and
  notarization of the app *and* every bundled binary.
- **FFmpeg licensing.** The bundled builds include libx264 and libvpx and are
  therefore **GPL**. Shipping SHIFT commercially requires either complying with
  the GPL or rebuilding FFmpeg as LGPL without those encoders (which would
  remove H.264 and VP9 output). Decide before any public release.
- **yt-dlp updates.** Sources change often. `scripts/fetch-sidecars.sh` pulls
  the latest release; re-running it and rebuilding is the update path. No
  auto-updater — it is not needed yet.

## Future work

Post-V1, in the PRD's order: local history, batch jobs, reusable presets, a
multi-action chain editor.
Deliberately not built yet: APNG (rarely needed next to animated WebP), ProRes
and MKV output (real but narrow audiences), Opus as a separate chip (M4A/AAC
already covers lossy delivery), and AV1 video output (encode times do not suit
an interactive app).
Also worth revisiting: provider-assisted section downloads, and a second
`UrlProvider` to prove the abstraction.

## Playable trim preview

`media::playback::PlaybackRegistry` owns each input session. Focused commands
create, prepare, and release it. Preparation runs on a worker with the existing
process-group cancellation token. URL preparation starts as soon as detection
finishes and reuses the detected metadata instead of resolving the provider a
second time. Output, quality, aspect, and range changes keep the same preview.

For video, `UrlProvider` prefers a progressive MP4 no larger than 540p; for
audio it prefers a directly playable audio stream. The downloaded preview can
feed export only when its measured dimensions satisfy the requested export
quality. Otherwise export downloads the requested final source independently.
An `Arc` lease protects a reusable source from reset while export is running.

A conservative MP3, PCM WAV, AAC M4A, and H.264/AAC MP4/MOV shortlist is served
directly through an explicitly allowed asset-protocol path. Other sources get
an AAC M4A or modest H.264/AAC MP4 preview, with one proxy fallback if direct
playback fails. Preview encoding is defined in `profiles::playback_plan` and
never depends on IN, OUT, output format, or aspect. A proxy never feeds export.
WebKit compatibility references: [Apple's Safari video guidance](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)
and [Apple's media format table](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/CreatingContentforSafarioniPhone/CreatingContentforSafarioniPhone.html).

The player uses the existing IN/OUT strings as its sole range state and backend
validation gates Export against the exact current range. Seeking changes only
the playhead. Selection playback seeks to IN and pauses at OUT, checked on
animation frames and media time updates; this has display-frame granularity,
not sample-accurate audio scheduling. Export remains FFmpeg-accurate. Video
framing draws the existing backend `ContentBox`, with no second crop algorithm.
A waveform is deferred; the timeline contains only real bounds and playhead.

Playback directories are scoped `TempDir`s: release, reset, failure, and shutdown
cancel work and drop files when the final lease ends. URL thumbnail directories
are released on reset and shutdown. Crash leftovers use the existing stale-directory
pruning. The older still-image framing cache remains separate. Backend events
drive the indeterminate `Resolving link`, `Downloading preview`, `Preparing player`,
and `Ready` states; the interface never fabricates a percentage.

Targeted checks: `npm test`, `cargo test --test audio_trim`, and
`cargo test --test playback`. Existing network checks remain opt-in under
`url_pipeline`; they must not be added to ordinary offline runs.
