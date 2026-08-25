#!/usr/bin/env bash
# Fetch the external binaries SHIFT bundles as Tauri sidecars.
#
# Tauri's bundler expects `<name>-<rust-target-triple>` in src-tauri/binaries/
# and copies each into SHIFT.app/Contents/MacOS/<name>.
#
# Licensing: the FFmpeg builds below are GPL (they include libx264/libvpx).
# See docs/ARCHITECTURE.md § FFmpeg licensing before distributing commercially.
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="src-tauri/binaries"
mkdir -p "$DEST"

TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
case "$TRIPLE" in
  aarch64-apple-darwin) FF_ARCH="arm64" ;;
  x86_64-apple-darwin)  FF_ARCH="amd64" ;;
  *) echo "SHIFT V1 targets macOS only (got $TRIPLE)" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ target triple: $TRIPLE"

fetch_ffmpeg_tool() {
  local tool="$1"
  local out="$DEST/${tool}-${TRIPLE}"
  if [ -x "$out" ]; then echo "✓ $tool already present"; return; fi
  echo "→ downloading $tool ($FF_ARCH static build)"
  curl -fsSL --retry 3 \
    "https://ffmpeg.martin-riedl.de/redirect/latest/macos/${FF_ARCH}/release/${tool}.zip" \
    -o "$TMP/${tool}.zip"
  unzip -qo "$TMP/${tool}.zip" -d "$TMP/${tool}"
  find "$TMP/${tool}" -type f -name "$tool" -perm -u+x -exec cp {} "$out" \; -quit
  [ -f "$out" ] || { echo "could not find $tool inside the archive" >&2; exit 1; }
  chmod +x "$out"
}

fetch_ytdlp() {
  local dir="$DEST/ytdlp"
  if [ -x "$dir/yt-dlp_macos" ]; then echo "✓ yt-dlp already present"; return; fi
  echo "→ downloading yt-dlp (macOS directory build)"
  # The directory build, not the single-file one. Both are self-contained, but
  # the single-file variant unpacks itself on every launch and costs ~11s per
  # invocation on macOS; this one starts in about a third of a second, which is
  # the difference between an instant analysis and a stalled-looking app.
  curl -fsSL --retry 3 \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip" \
    -o "$TMP/yt-dlp.zip"
  rm -rf "$dir"
  mkdir -p "$dir"
  unzip -qo "$TMP/yt-dlp.zip" -d "$dir"
  chmod +x "$dir/yt-dlp_macos"
}

fetch_ffmpeg_tool ffmpeg
fetch_ffmpeg_tool ffprobe
fetch_ytdlp

echo
echo "Bundled sidecars:"
for b in ffmpeg ffprobe; do
  path="$DEST/${b}-${TRIPLE}"
  # Ad-hoc sign so Gatekeeper lets the freshly downloaded binaries execute.
  codesign --force --sign - "$path" >/dev/null 2>&1 || true
  printf '  %-8s %s\n' "$b" "$("$path" -version 2>/dev/null | head -1)"
done
# yt-dlp ships already signed; re-signing would invalidate its bundle.
printf '  %-8s %s\n' "yt-dlp" "$("$DEST/ytdlp/yt-dlp_macos" --version 2>/dev/null | head -1)"
