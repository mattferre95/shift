# Third-party software and distribution status

SHIFT's application source is licensed under the [MIT License](../LICENSE),
Copyright © 2026 Matt Ferre. That license does **not** replace the licenses of
bundled tools or dependencies.

## Bundled media tools in the Apple Silicon test package

| Tool | Exact bundled version | License and attribution | Provenance |
| --- | --- | --- | --- |
| FFmpeg and ffprobe | 9.0.1, Martin Riedl macOS arm64 build dated 18 August 2026 | FFmpeg developers; **GPL version 3 or later**, as reported by `ffmpeg -L` and `ffprobe -L`. Full text: [GPL-3.0.txt](licenses/GPL-3.0.txt). | [Archived build](https://ffmpeg.martin-riedl.de/info/detail/macos/arm64/1787073674_9.0.1); [build script](https://git.martin-riedl.de/ffmpeg/build-script/commit/f63b8aab8f). |
| yt-dlp | 2026.08.19 directory build | yt-dlp contributors; [Unlicense](licenses/yt-dlp-UNLICENSE.txt). Its packaged Python dependencies retain their own notices in `Contents/Resources/ytdlp/_internal/THIRD_PARTY_LICENSES.txt`. | [Upstream release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19). |

The upstream ZIP SHA-256 values checked before extraction are:

```text
ffmpeg.zip       8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe
ffprobe.zip      102a26b8940a053298d9929bfaae71e4b6ef65ba5f19a99a88c433108560741a
yt-dlp_macos.zip 07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8
```

The current FFmpeg and ffprobe sidecars were renamed and signed ad hoc by the
local fetch script. Their signed-file hashes therefore differ from the
upstream ZIP entries. After removing signatures from **temporary copies**, the
payload bytes from offset 12160 through EOF matched the archived vendor
executables byte for byte. The yt-dlp directory matched its upstream ZIP
without changes.

FFmpeg's configure line includes `--enable-gpl`, `--enable-version3`,
`--enable-libx264`, `--enable-libx265`, `--enable-libvpx`, `--enable-libwebp`,
`--enable-libaom`, `--enable-libdav1d`, `--enable-libmp3lame` and other
libraries. `otool -L` shows only Apple system frameworks and libraries for the
FFmpeg executable; these codec libraries are statically linked into the tool.
The exact configure line is available with `Contents/MacOS/ffmpeg -version`.

## Public distribution gate

The local DMG is a **test package**, not an approved public release. The exact
corresponding source and build material for FFmpeg **and its statically linked
components** have not yet been assembled and offered alongside the binary.
The archived build script and the upstream FFmpeg source are available, but
links alone do not establish that every corresponding source obligation for
this specific binary has been met. A complete, reviewed source distribution
and applicable notices must be attached to any public binary release, or the
bundle must use a suitably licensed replacement build that preserves SHIFT's
required exports. The existing GPL-enabled executable remains necessary for
SHIFT's current H.264 export implementation. The licenses and notices for the
other compiled Rust and JavaScript dependencies also need a final release
inventory.

See [FFmpeg's legal guidance](https://ffmpeg.org/legal.html) for its source and
notice checklist. This document records the technical findings; it is not a
legal clearance to publish the binary.
