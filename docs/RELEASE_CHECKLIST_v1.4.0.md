# SHIFT v1.4.0 publication checklist

This is an execution checklist, not an authorization to publish. Run the publication steps only after explicit approval. The local ad hoc signed DMG is for review and cannot substitute for the final Developer ID package.

## Before final packaging

1. Complete the Rust/JavaScript third-party notice inventory and review the LGPL replaceability path in a Developer ID signed bundle. Keep FFmpeg's `LICENSES/`, shared libraries and matching source archive with the package. Confirm no ad hoc signed nested Mach-O files remain in the final package.
2. Obtain a paid Apple Developer Program membership and a valid **Developer ID Application** certificate installed with its private key on the signing Mac. `security find-identity -v -p codesigning` must show it. The current signing Mac has zero valid identities.
3. Configure local notarization credentials using either App Store Connect API variables `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`, or the Apple ID app-specific password variables `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Keep keys and passwords out of Git and chat. See [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).

## Build and verify the final package

Run from the approved integrated source tree on Apple Silicon:

```bash
npm ci
npm run sidecars
security find-identity -v -p codesigning
export APPLE_SIGNING_IDENTITY='Developer ID Application: YOUR NAME (TEAMID)'
# Set one of Tauri's notarization credential sets in the local shell.
npx tauri build --bundles dmg
APP=src-tauri/target/release/bundle/macos/SHIFT.app
DMG=src-tauri/target/release/bundle/dmg/SHIFT_1.4.0_aarch64.dmg
SOURCE=src-tauri/target/ffmpeg-lgpl-build/out/SHIFT-ffmpeg-9.0.1-lgpl-corresponding-source.tar.xz
codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$DMG"
spctl --assess --type execute --verbose=4 "$APP"
shasum -a 256 "$DMG" "$SOURCE"
```

Inspect the Developer ID identity and hardened runtime on the app, ffmpeg, ffprobe and every bundled dylib; verify the bundled yt-dlp code too. Test installation and launch from the notarized DMG on a clean Apple Silicon Mac, then perform the focused Dashboard trim, playback and export checks. If Tauri leaves an ad hoc nested binary or Apple rejects notarization, fix signing inside out and rebuild/re-notarize before publication. Validate that recipients can rebuild and substitute compatible LGPL libraries under the final signing model.

## Git and GitHub publication, only after approval

1. Confirm this branch's signed commits and clean tree. Integrate `codex/shift-v1.4.0-release` into `main` through the approved review/merge route, resolving any divergence deliberately. Preserve the Dashboard and Keychain worktrees and their unfinished changes. Do not copy unrelated changes.
2. Confirm `main` contains exactly the approved release commits, then create and push signed tag `v1.4.0` from that commit.
3. Create a GitHub Release titled `SHIFT v1.4.0` from the tag with [`RELEASE_NOTES_v1.4.0.md`](RELEASE_NOTES_v1.4.0.md). Attach **both** the notarized `SHIFT_1.4.0_aarch64.dmg` and matching `SHIFT-ffmpeg-9.0.1-lgpl-corresponding-source.tar.xz`; record and verify their SHA-256 hashes.
4. Confirm both asset URLs resolve publicly. Only then update the README's download status to a live link. The proposed DMG URL is `https://github.com/mattferre95/shift/releases/download/v1.4.0/SHIFT_1.4.0_aarch64.dmg` and is **not live yet**.

Example publication commands, to run only after approval and final package verification:

```bash
# In the approved integration checkout, after reviewing the merge result:
git switch main
git merge --ff-only codex/shift-v1.4.0-release
git push origin main
git tag -s v1.4.0 -m 'SHIFT v1.4.0'
git push origin v1.4.0
gh release create v1.4.0 "$DMG" "$SOURCE" \
  --title 'SHIFT v1.4.0' --notes-file docs/RELEASE_NOTES_v1.4.0.md
```

If `--ff-only` fails, stop and review the branch delta; do not force integration. The README live-link update itself requires a reviewed signed commit and push after the asset URL is verified.
