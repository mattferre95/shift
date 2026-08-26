<p align="center">
  <img src="public/brand/shift-symbol.png" alt="" width="104">
</p>

<h1 align="center">SHIFT™</h1>

<p align="center">
  <strong>Anything in. Anything out.</strong>
</p>

<p align="center">
  A local-first macOS media utility for downloading, clipping, converting,
  compressing and transforming everyday media.
</p>

## How it works

```
Input → Detect → Choose output → Export
```

Drop a file or paste a link. SHIFT works out what it is and shows only the
outputs that make sense for it — a photo never offers you a bitrate, an audio
file never offers you a resolution. There is no dashboard of unrelated
converters to navigate.

## What it does

### URL media

- Paste any link yt-dlp supports
- Read the title, thumbnail, duration and source before committing to anything
- Export **MP4**, **MP3** or **WAV**
- Optional **IN / OUT** clipping with millisecond precision
- Quality selection where the source actually offers alternatives

### Local video and audio

- Read **MP4 · MOV · WEBM** and **MP3 · WAV · M4A · AAC**
- Convert between compatible formats, copying streams untouched when possible
- Trim to an exact range
- Extract the audio from a video

### Images

- Read **HEIC · HEIF · JPG · JPEG · PNG · WEBP**
- Export **JPG · PNG · WEBP**
- Quality presets for the lossy formats — None, Light, Balanced, Strong
- Lossless optimization for PNG, which never touches a pixel

Every export is named and placed through the native macOS Save panel, so the
file lands exactly where you put it. Long jobs show real progress and can be
cancelled.

## Privacy

**Local files stay on your Mac.** Video, audio and image transformations run
on-device. No accounts, no telemetry, no cloud uploads, no analytics.

Analyzing and downloading a URL naturally requires network access. That path is
intended for media you are authorized or legally permitted to download.

## Built with

Tauri 2 · React · TypeScript · Rust · FFmpeg and ffprobe · yt-dlp · native macOS
image tooling

## Build locally

Requires Node, Rust and the Xcode command line tools.

```bash
npm install
npm run sidecars
npm run app:build
```

`npm run sidecars` downloads FFmpeg, ffprobe and yt-dlp into
`src-tauri/binaries/`. They are deliberately not committed, and the step is
required before the first build.

The result is `src-tauri/target/release/bundle/macos/SHIFT.app`.

```bash
npm run app:dev                 # development
cd src-tauri && cargo test      # tests (network tests are #[ignore]d)
```

## Project status

SHIFT is built primarily as my personal everyday media utility. The repository
is public because I like building tools in the open.

It is developed and tested on macOS running Apple Silicon. There are no signed
or notarized releases, and no support commitment — build it yourself with the
steps above.

Implementation notes live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
including the FFmpeg licensing position for the bundled builds.
