# SHIFT™

**Anything in. Anything out.**

A local-first macOS media utility for downloading, clipping, converting,
extracting audio, and trimming local video and audio.

Drop a file or paste a link, choose what you want out, export.

## What it does

- Paste a supported media URL → inspect it → export **MP4**, **MP3** or **WAV**,
  optionally clipped to an IN/OUT range.
- Drop a local **MP4 / MOV / WEBM** or **MP3 / WAV / M4A / AAC** → convert,
  trim, or extract its audio.
- Every job is cancellable, every failure is readable, and nothing is ever
  silently overwritten.

Local file processing happens on-device: SHIFT runs FFmpeg against the file
where it already is and never uploads it. Only URL analysis and download reach
the network. No accounts, no telemetry, no cloud.

Downloading from a URL is for media you are authorized or legally permitted to
download.

## Build

Built and run on macOS (Apple Silicon). Requires Node, Rust, and the Xcode
command line tools.

```bash
npm install
npm run sidecars
npm run app:build
```

`npm run sidecars` downloads FFmpeg, ffprobe and yt-dlp into
`src-tauri/binaries/`; they are not committed, and it is required before the
first build. The result is
`src-tauri/target/release/bundle/macos/SHIFT.app`, which runs from
`/Applications` as an ad-hoc signed build.

For development: `npm run app:dev`.

Tests: `cd src-tauri && cargo test` (the network-dependent URL tests are
`#[ignore]`d by default).

## Documentation

`docs/ARCHITECTURE.md` · `docs/DESIGN_SPEC.md` · `docs/QA_CHECKLIST.md`

## Note

SHIFT bundles GPL-licensed FFmpeg builds (libx264 / libvpx). That is fine for
personal use; see `docs/ARCHITECTURE.md` if that ever changes.
