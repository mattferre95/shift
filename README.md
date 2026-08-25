# SHIFT™

**Anything in. Anything out.**

A premium, local-first Mac utility for downloading, clipping, converting,
trimming and extracting media — without bouncing between single-purpose
websites.

Drop a file or paste a link, choose what you want out, export.

## What it does

- Paste a supported media URL → inspect it → export **MP4**, **MP3** or **WAV**,
  optionally clipped to an IN/OUT range.
- Drop a local **MP4 / MOV / WEBM** or **MP3 / WAV / M4A / AAC** → convert,
  trim, or extract its audio.
- Every job is cancellable, every failure is readable, and nothing is ever
  silently overwritten.

Local files stay on your Mac. No accounts, no telemetry, no cloud.

Downloading from a URL is for media you are authorized or legally permitted to
download.

## Build

Requires Node, Rust, and Xcode command line tools.

```bash
npm install
npm run sidecars
npm run app:build
```

The result is `src-tauri/target/release/bundle/macos/SHIFT.app`.

For development: `npm run app:dev`.

## Documentation

`docs/ARCHITECTURE.md` · `docs/DESIGN_SPEC.md` · `docs/QA_CHECKLIST.md`

## Licensing

SHIFT bundles FFmpeg builds that include libx264 and libvpx and are therefore
**GPL-licensed**. Review `docs/ARCHITECTURE.md` § Packaging before any public or
commercial distribution.
