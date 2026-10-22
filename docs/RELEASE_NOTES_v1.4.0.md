# SHIFT v1.4.0

SHIFT brings source, preview, timeline and export controls together in a unified Dashboard. The focused Download, Convert, Edit and Resize views remain available.

## Highlights

- Playable local previews and a timeline with manual IN/OUT points and quick trim presets.
- Aspect-ratio and crop controls with live framing feedback.
- MP4, MOV, WEBM, GIF, WEBP and AVIF exports where applicable, plus audio extraction and conversion.
- Public-link analysis and downloads through bundled yt-dlp, subject to changing site support and the documented URL egress controls.
- A trim correction: opening a longer source selects its full duration until you choose a shorter range.

## Download and requirements

Apple Silicon with macOS 12 or newer is the first release target. Developer ID signing, Apple notarization and the final third-party notice review are required before publication. The GitHub Release must contain both `SHIFT_1.4.0_aarch64.dmg` and `SHIFT-ffmpeg-9.0.1-lgpl-corresponding-source.tar.xz`. The latter is the corresponding source for bundled LGPL FFmpeg. There is no automatic updater.

Only download media you are authorized or legally permitted to use. See [third-party notices](THIRD_PARTY_NOTICES.md) and [URL egress details](URL_EGRESS.md).
