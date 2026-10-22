#!/usr/bin/env bash
# Regenerates every macOS/Tauri icon from the approved 1024px master.
# Usage: npm run icons   (macOS only: needs sips + iconutil)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
master="$root/src/assets/brand/shift-app-icon.png"
out="$root/src-tauri/icons"
set="$(mktemp -d)/icon.iconset"
mkdir -p "$set"

[ "$(sips -g pixelWidth "$master" | awk '/pixelWidth/{print $2}')" = 1024 ] \
  || { echo "master must be 1024px" >&2; exit 1; }

# name:size pairs for the iconset (@2x files are the next size up)
for spec in 16:16x16 32:16x16@2x 32:32x32 64:32x32@2x 128:128x128 256:128x128@2x \
            256:256x256 512:256x256@2x 512:512x512 1024:512x512@2x; do
  sips -z "${spec%%:*}" "${spec%%:*}" "$master" --out "$set/icon_${spec#*:}.png" >/dev/null
done
iconutil -c icns "$set" -o "$out/icon.icns"

for spec in 32:32x32 64:64x64 128:128x128 256:128x128@2x 512:icon; do
  sips -z "${spec%%:*}" "${spec%%:*}" "$master" --out "$out/${spec#*:}.png" >/dev/null
done
echo "icons regenerated in $out"
