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
| `media::profiles` | Every codec and container decision. Nothing else builds FFmpeg arguments. |
| `media::ffmpeg` | Running a plan and normalizing its progress. |
| `jobs` | The state machine, the registry, and the pipeline runner. |
| `filesystem` | Per-job temp dirs, filename sanitizing, collision-safe output, the final move. |
| `settings` | A small JSON file. No database. |
| `errors` | Normalization into `{ code, message, hint, technical }`. |

## Decisions

**Actions are data.** A job carries `ActionSpec[]` (`Analyze`, `Download`,
`Trim`, `Convert`, `ExtractAudio`) and they travel to the UI on every event.
Adding Crop or Normalize later means extending that enum and `media::profiles`,
not adding a screen flow.

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

**Progress is never invented.** FFmpeg's `-progress` stream divided by a known
duration is a real percentage. yt-dlp reports bytes via `--progress-template`;
when the total is unknown the provider reports `None` and the UI falls back to
stage position with an indeterminate sweep.

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

Post-V1, in the PRD's order: image conversion/resize/crop, compression presets,
local history, batch jobs, reusable presets, a multi-action chain editor.
Also worth revisiting: provider-assisted section downloads, and a second
`UrlProvider` to prove the abstraction.
