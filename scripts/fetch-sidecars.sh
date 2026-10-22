#!/usr/bin/env bash
# Fetch the external binaries SHIFT bundles as Tauri sidecars.
# The Apple Silicon release inputs are pinned so a rebuild cannot silently
# pick up a different FFmpeg or yt-dlp binary.
# Licensing and public-distribution requirements: docs/THIRD_PARTY_NOTICES.md.
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="src-tauri/binaries"
mkdir -p "$DEST"

TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
case "$TRIPLE" in
  aarch64-apple-darwin)
    FF_ARCH="arm64"
    FFMPEG_RELEASE="https://ffmpeg.martin-riedl.de/download/macos/arm64/1787073674_9.0.1"
    ;;
  x86_64-apple-darwin)
    FF_ARCH="amd64"
    FFMPEG_RELEASE="https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release"
    ;;
  *) echo "SHIFT targets macOS only (got $TRIPLE)" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ target triple: $TRIPLE"

verify_archive() {
  local path="$1" expected="$2"
  printf '%s  %s\n' "$expected" "$path" | shasum -a 256 -c -
}

fetch_ffmpeg_tool() {
  local tool="$1"
  local out="$DEST/${tool}-${TRIPLE}"
  if [ -x "$out" ]; then echo "✓ $tool already present"; return; fi
  echo "→ downloading $tool ($FF_ARCH build)"
  curl -fsSL --retry 3 "$FFMPEG_RELEASE/${tool}.zip" -o "$TMP/${tool}.zip"
  if [ "$TRIPLE" = "aarch64-apple-darwin" ]; then
    case "$tool" in
      ffmpeg)  verify_archive "$TMP/${tool}.zip" 8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe ;;
      ffprobe) verify_archive "$TMP/${tool}.zip" 102a26b8940a053298d9929bfaae71e4b6ef65ba5f19a99a88c433108560741a ;;
    esac
  fi
  unzip -qo "$TMP/${tool}.zip" -d "$TMP/${tool}"
  find "$TMP/${tool}" -type f -name "$tool" -perm -u+x -exec cp {} "$out" \; -quit
  [ -f "$out" ] || { echo "could not find $tool inside the archive" >&2; exit 1; }
  chmod +x "$out"
}

fetch_ytdlp() {
  local dir="$DEST/ytdlp"
  if [ -x "$dir/yt-dlp_macos" ]; then echo "✓ yt-dlp already present"; return; fi
  echo "→ downloading yt-dlp 2026.08.19 (macOS directory build)"
  curl -fsSL --retry 3 \
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos.zip" \
    -o "$TMP/yt-dlp.zip"
  verify_archive "$TMP/yt-dlp.zip" 07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8
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
for tool in ffmpeg ffprobe; do
  path="$DEST/${tool}-${TRIPLE}"
  # The archive's vendor signature no longer applies after Tauri renames a sidecar.
  codesign --force --sign - "$path" >/dev/null 2>&1 || true
  printf '  %-8s %s\n' "$tool" "$("$path" -version 2>/dev/null | head -1)"
done
# yt-dlp's executable is kept byte-for-byte from the verified release archive.
printf '  %-8s %s\n' "yt-dlp" "$("$DEST/ytdlp/yt-dlp_macos" --version 2>/dev/null | head -1)"
