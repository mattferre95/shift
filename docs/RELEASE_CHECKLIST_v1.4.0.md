# SHIFT v1.4.0 publication checklist

This is an execution checklist, not authorization to publish. The current ad hoc signed DMG is for local review only.

## Remaining gates before approval

1. Complete the Rust/JavaScript third-party notice inventory and review how recipients can rebuild and substitute compatible LGPL FFmpeg shared libraries under the final signing model. Keep FFmpeg's `LICENSES/`, shared libraries and matching corresponding-source asset with the package.
2. Obtain a paid Apple Developer Program membership and a valid **Developer ID Application** certificate with private key in the signing Mac's keychain. `security find-identity -v -p codesigning` must list it. This Mac currently has zero valid identities.
3. Configure notarization using either App Store Connect API variables `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`, or Apple ID app-specific password variables `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Keep credentials out of Git and chat. See [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).

## After explicit approval: integrate and build

Use the isolated release checkout. Confirm the signed commits and clean tree, and review the integration result. Preserve the Dashboard and Keychain worktrees and their unfinished changes. If `--ff-only` fails, stop and review the branch delta; do not force integration.

```bash
git status --short --branch
git log -5 --format='%h %G? %an <%ae> %s'
git switch main
git merge --ff-only codex/shift-v1.4.0-release
npm ci
npm run sidecars
security find-identity -v -p codesigning
export APPLE_SIGNING_IDENTITY='Developer ID Application: YOUR NAME (TEAMID)'
# Set one of Tauri's notarization credential sets in the local shell.
npx tauri build --bundles dmg
DMG=src-tauri/target/release/bundle/dmg/SHIFT_1.4.0_aarch64.dmg
SOURCE=src-tauri/target/ffmpeg-lgpl-build/out/SHIFT-ffmpeg-9.0.1-lgpl-corresponding-source.tar.xz
MOUNT=$(mktemp -d)
hdiutil verify "$DMG"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG"
APP="$MOUNT/SHIFT.app"
codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$DMG"
spctl --assess --type execute --verbose=4 "$APP"
shasum -a 256 "$DMG" "$SOURCE"
hdiutil detach "$MOUNT"
```

Tauri removes its intermediate `.app` after building the DMG, so inspect the mounted app. Check the Developer ID identity and hardened runtime on the app, ffmpeg, ffprobe and every bundled dylib; inspect the bundled yt-dlp code too. The local ad hoc build needed inside-out re-signing and DMG recreation to pass `codesign --verify`, so do not assume Tauri signed the final nested code correctly. If Apple rejects notarization or any nested binary remains ad hoc, fix signing and rebuild before publication. Install and launch the notarized DMG on a clean Apple Silicon Mac; repeat the focused Dashboard trim, playback and export checks and the LGPL library substitution check.

## After final package verification: publish

Create a signed tag on the approved `main` commit, push `main` and the tag, then create a GitHub Release titled `SHIFT v1.4.0` using [`RELEASE_NOTES_v1.4.0.md`](RELEASE_NOTES_v1.4.0.md). Attach **both** the notarized DMG and matching LGPL corresponding-source archive. Verify each asset's published SHA-256 hash and public URL. The proposed DMG URL is `https://github.com/mattferre95/shift/releases/download/v1.4.0/SHIFT_1.4.0_aarch64.dmg`; it is **not live yet**.

```bash
git push origin main
git tag -s v1.4.0 -m 'SHIFT v1.4.0'
git push origin v1.4.0
gh release create v1.4.0 "$DMG" "$SOURCE" \
  --title 'SHIFT v1.4.0' --notes-file docs/RELEASE_NOTES_v1.4.0.md
```

Only after both asset URLs work publicly, update the README download status with a reviewed signed commit and push. Do not claim a public download earlier.
