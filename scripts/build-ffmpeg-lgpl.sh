#!/usr/bin/env bash
# Rebuild the Apple Silicon LGPL FFmpeg/ffprobe package from pinned sources.
# Requires Xcode Command Line Tools, cmake, pkg-config, meson and ninja.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${SHIFT_FFMPEG_BUILD_DIR:-$ROOT/src-tauri/target/ffmpeg-lgpl-build}"
UPSTREAM="https://github.com/dfloresc/ffmpeg-macos-builds.git"
COMMIT="e95a80ee4eeaf8bdb4f208ccbc1952eb79e0b08a"
PATCH="$ROOT/scripts/patches/ffmpeg-lgpl-webp.patch"
ARCHIVE="$BUILD_DIR/out/ffmpeg-9.0.1-1-lgpl-macos-arm64.tar.xz"
SOURCE_ASSET="$BUILD_DIR/out/SHIFT-ffmpeg-9.0.1-lgpl-corresponding-source.tar.xz"

mkdir -p "$BUILD_DIR"
if [ ! -d "$BUILD_DIR/.git" ]; then
  git clone "$UPSTREAM" "$BUILD_DIR"
fi
cd "$BUILD_DIR"
if [ "$(git rev-parse HEAD)" != "$COMMIT" ]; then
  git fetch origin "$COMMIT"
  git checkout --detach "$COMMIT"
fi
if git apply --check "$PATCH"; then
  git apply "$PATCH"
elif ! git apply --check --reverse "$PATCH"; then
  echo 'FFmpeg build checkout differs from the pinned patch' >&2
  exit 1
fi
./build.sh lgpl arm64
./check.sh --require-run "$ARCHIVE"

# Offer the exact source archives, patched scripts and their license notices
# alongside any public DMG. The shared FFmpeg libraries remain replaceable.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/SHIFT-ffmpeg-9.0.1-lgpl-source/build/sources"
cp -R build.sh check.sh scripts keys versions.env LICENSE README.md "$STAGE/SHIFT-ffmpeg-9.0.1-lgpl-source/build/"
cp -R sources/. "$STAGE/SHIFT-ffmpeg-9.0.1-lgpl-source/build/sources/"
cp "$PATCH" "$STAGE/SHIFT-ffmpeg-9.0.1-lgpl-source/SHIFT-ffmpeg-lgpl-webp.patch"
cp "$BUILD_DIR/work/arm64/ffmpeg-lgpl/pkg/ffmpeg-9.0.1-1-lgpl-macos-arm64/BUILDINFO.txt" "$STAGE/SHIFT-ffmpeg-9.0.1-lgpl-source/BUILDINFO.txt" 2>/dev/null || \
  tar -xOf "$ARCHIVE" ffmpeg-9.0.1-1-lgpl-macos-arm64/BUILDINFO.txt > "$STAGE/SHIFT-ffmpeg-9.0.1-lgpl-source/BUILDINFO.txt"
cat > "$STAGE/SHIFT-ffmpeg-9.0.1-lgpl-source/README-SHIFT.txt" <<EOT
Corresponding source material for SHIFT's FFmpeg 9.0.1 LGPL arm64 package.
Upstream build scripts: $UPSTREAM at commit $COMMIT.
The build/ directory includes SHIFT's WebP patch already applied.
build/sources/ contains all SHA-256-pinned third-party source archives.
Rebuild on an Apple Silicon Mac with: cd build && ./build.sh lgpl arm64
The corresponding binary archive and its LICENSES directory ship separately.
EOT
COPYFILE_DISABLE=1 tar -cJf "$SOURCE_ASSET" -C "$STAGE" SHIFT-ffmpeg-9.0.1-lgpl-source
shasum -a 256 "$ARCHIVE" "$SOURCE_ASSET"
