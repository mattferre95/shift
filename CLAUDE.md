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
- **All codec and container decisions live in `src-tauri/src/media/profiles.rs`.**
  Do not spread FFmpeg flags elsewhere.
- **yt-dlp is one provider behind `providers::UrlProvider`**, not a hardcoded
  dependency.
- **Never invent progress.** Report a percentage only when the native layer has
  a real one; otherwise show stage position.
- **Never overwrite an output.** `filesystem::unique_path` handles collisions.
- The design tokens in `src/app/index.css` are transcribed from the approved
  design. Do not add values that are not in it.

## Two traps

Both look like "the app hangs with no child process in `ps`":

1. **Never use `pre_exec` on a spawned `Command`.** It forces `fork` + `exec`,
   and a fork in this Cocoa app deadlocks before `exec`. Use `process_group(0)`.
2. **Never put a CSP `<meta>` tag in `index.html`.** Tauri can only patch the CSP
   it injects from `tauri.conf.json`; a hardcoded one blocks all IPC.

## Scope

V1 is frozen: URL → MP4/MP3/WAV with optional clipping, and local
convert/extract/trim. No images, compression, batch, presets, history, accounts,
analytics, or cloud. Ideas for later go in the future-work section of
`docs/ARCHITECTURE.md`, not into the app.

## Git

No AI attribution trailers in commits or PRs.
