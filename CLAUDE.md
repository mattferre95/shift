# SHIFT™ — anything in, anything out.

A local-first macOS media utility. Tauri 2 + Vite + React + TypeScript, with a
Rust orchestration layer over bundled yt-dlp, FFmpeg and ffprobe.

## Read first

- `private/SHIFT_PRD_V1.docx` — product scope and V1 requirements. Source of truth.
- `docs/ARCHITECTURE.md` — implementation boundaries and the decisions behind them.
- `docs/DESIGN_SPEC.md` — how the approved Claude Design maps onto the app.
- `docs/QA_CHECKLIST.md` — acceptance checks.

## Setup

```bash
npm install && npm run sidecars   # downloads ffmpeg, ffprobe, yt-dlp
npm run app:dev                   # or: npm run app:build
```

Sidecars are not committed. `npm run sidecars` is required before the first build.

## Conventions

- **The frontend never builds a command.** It submits structured intent to a
  narrow Tauri command; the Rust layer owns every process, path and argument.
- **Format decisions live in two places and nowhere else.** Audio, video and
  loop (GIF / animated WEBP) codec and container choices are in
  `src-tauri/src/media/profiles.rs`; still-image conversion and compression are
  in `src-tauri/src/media/image.rs`. Do not spread FFmpeg or sips flags beyond
  them.
- **WEBP means two things, and the source decides which.** A still from a photo,
  an animation from a video. The input picks the pipeline in `jobs::execute`;
  never branch on the output format alone.
- **Loop frame rates must divide 100.** GIF frame delays are whole
  centiseconds, so 10 / 12.5 / 20 fps are exact and 12 or 15 are not. Add a
  preset only if it survives that rule.
- **Loop length limits are per format** — GIF 15s, animated WEBP 30s — because
  GIF has no interframe compression. They live in `profiles` and are mirrored in
  `types/index.ts`; change both together.
- **An audio stream is only copied when the result means the same thing.**
  See `audio_copy_is_faithful`. Legal-in-container is not the test.
- **yt-dlp is one provider behind `providers::UrlProvider`**, not a hardcoded
  dependency.
- **Never invent progress.** Report a percentage only when the native layer has
  a real one; otherwise show stage position.
- **Never overwrite an output by accident.** Automatically named outputs go
  through `filesystem::unique_path`. A Save As destination is written to the
  path the user confirmed, because the native panel already asked about
  replacing it.
- The design tokens in `src/app/index.css` are transcribed from the approved
  design. Do not add values that are not in it.

## Two traps

Both look like "the app hangs with no child process in `ps`":

1. **Never use `pre_exec` on a spawned `Command`.** It forces `fork` + `exec`,
   and a fork in this Cocoa app deadlocks before `exec`. Use `process_group(0)`.
2. **Never put a CSP `<meta>` tag in `index.html`.** Tauri can only patch the CSP
   it injects from `tauri.conf.json`; a hardcoded one blocks all IPC.

## Scope

Supported today: URL download with optional clipping, exporting
MP4/GIF/WEBP/MP3/WAV; local video and audio conversion, trimming and audio
extraction across MP4/MOV/WEBM and MP3/M4A/WAV/FLAC; silent looping export to
GIF (max 15s) and animated WEBP (max 30s); and image conversion from
HEIC/HEIF/JPG/PNG/WEBP/AVIF to JPG/PNG/WEBP/AVIF with optional compression.
Reads more containers than it writes — MKV, M4V, AVI, AIFF, OGG and Opus
included. Every export is named and placed through the native Save panel.

Still out: batch, presets, history, accounts, analytics, cloud. Ideas for later
go in the future-work section of `docs/ARCHITECTURE.md`, not into the app.

## Git

- All commits must be signed.
- Conventional Commits only. Messages in English.
- Commits must be atomic and self-contained.
- Author and committer must always be `Matt Ferre <mattferre05@gmail.com>`.
- NEVER use Claude, Anthropic, ChatGPT, Codex, OpenAI, or any other AI identity
  as author, committer, co-author, or contributor.
- NEVER add `Co-Authored-By` / `Co-authored-by`.
- NEVER add `Generated-by` or any other AI attribution, in commits or PRs.
- Before pushing, audit the history for unintended identities and attribution.
- After publishing, verify GitHub's Contributors list holds only the intended
  human contributors.
