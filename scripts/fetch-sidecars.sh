#!/usr/bin/env bash
# Prepare pinned Apple Silicon media sidecars for local builds and packaging.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEST="src-tauri/binaries"
mkdir -p "$DEST"
TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
[ "$TRIPLE" = "aarch64-apple-darwin" ] || {
  echo "The v1.4.0 public package currently supports Apple Silicon only (got $TRIPLE)" >&2
  exit 1
}
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

verify_archive() {
  printf '%s  %s\n' "$2" "$1" | shasum -a 256 -c -
}

FF_ARCHIVE="${SHIFT_FFMPEG_LGPL_ARCHIVE:-$ROOT/src-tauri/target/ffmpeg-lgpl-build/out/ffmpeg-9.0.1-1-lgpl-macos-arm64.tar.xz}"
SOURCE_ASSET="${SHIFT_FFMPEG_LGPL_SOURCE_ASSET:-$(dirname "$FF_ARCHIVE")/SHIFT-ffmpeg-9.0.1-lgpl-corresponding-source.tar.xz}"
if [ ! -f "$FF_ARCHIVE" ] || [ ! -f "$SOURCE_ASSET" ]; then
  bash scripts/build-ffmpeg-lgpl.sh
fi
[ -f "$FF_ARCHIVE" ] || { echo "Missing LGPL FFmpeg archive: $FF_ARCHIVE" >&2; exit 1; }
[ -f "$SOURCE_ASSET" ] || { echo "Missing LGPL corresponding source: $SOURCE_ASSET" >&2; exit 1; }
tar -xf "$FF_ARCHIVE" -C "$TMP"
FF_ROOT="$TMP/ffmpeg-9.0.1-1-lgpl-macos-arm64"
tar -xOf "$SOURCE_ASSET" SHIFT-ffmpeg-9.0.1-lgpl-source/BUILDINFO.txt | cmp - "$FF_ROOT/BUILDINFO.txt"
[ -x "$FF_ROOT/bin/ffmpeg" ] && [ -x "$FF_ROOT/bin/ffprobe" ] || exit 1
license_text="$("$FF_ROOT/bin/ffmpeg" -L 2>/dev/null)"
grep -q 'GNU Lesser General Public' <<<"$license_text"
encoders="$("$FF_ROOT/bin/ffmpeg" -encoders 2>/dev/null)"
if grep -Eq 'libx264|libx265' <<<"$encoders"; then
  echo 'Unexpected GPL encoder in the FFmpeg archive' >&2
  exit 1
fi
for encoder in h264_videotoolbox libvpx-vp9 libwebp_anim libaom-av1 libopus libmp3lame; do
  grep -q "$encoder" <<<"$encoders" || {
    echo "Missing required FFmpeg encoder: $encoder" >&2; exit 1;
  }
done
rm -rf "$DEST/ffmpeg-lib" "$DEST/ffmpeg-licenses"
mkdir -p "$DEST/ffmpeg-lib"
cp -R "$FF_ROOT/lib/." "$DEST/ffmpeg-lib/"
cp -R "$FF_ROOT/LICENSES" "$DEST/ffmpeg-licenses"
cp "$FF_ROOT/BUILDINFO.txt" "$DEST/ffmpeg-BUILDINFO.txt"
for tool in ffmpeg ffprobe; do
  out="$DEST/${tool}-${TRIPLE}"
  cp "$FF_ROOT/bin/$tool" "$out"
  # Both dev and app-bundle rpaths are set when FFmpeg is linked.
  codesign --force --sign - --timestamp=none "$out" >/dev/null
  printf '  %-8s %s\n' "$tool" "$("$out" -version 2>/dev/null | head -1)"
done

YTDLP_DIR="$DEST/ytdlp"
if [ ! -x "$YTDLP_DIR/yt-dlp_macos" ]; then
  curl -fsSL --retry 3 \
    'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos.zip' \
    -o "$TMP/yt-dlp.zip"
  verify_archive "$TMP/yt-dlp.zip" 07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8
  mkdir -p "$YTDLP_DIR"
  unzip -qo "$TMP/yt-dlp.zip" -d "$YTDLP_DIR"
  chmod +x "$YTDLP_DIR/yt-dlp_macos"
fi
printf '  %-8s %s\n' 'yt-dlp' "$("$YTDLP_DIR/yt-dlp_macos" --version 2>/dev/null | head -1)"
