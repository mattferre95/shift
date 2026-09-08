//! Preview material for the UI.
//!
//! One small image per source, cached, that the interface positions and crops
//! with CSS using the geometry `media::aspect` already computed. Nothing here
//! touches an export: the derivative is disposable, deliberately low resolution,
//! and never an input to the real pipeline.
//!
//! Changing 16:9 → 9:16 → 1:1 re-uses the same file every time. Only the source
//! itself changing, or a video's IN point moving, costs another extraction.

use crate::errors::{Result, ShiftError};
use crate::media::image;
use crate::process::{run_capture, Binary, CancelToken};
use std::path::{Path, PathBuf};

/// Base64, so a derivative can be handed to the webview as a `data:` URI.
///
/// The asset protocol would be the obvious route, but serving a file to the
/// webview means getting a scope glob, a canonicalised path and a CSP entry to
/// agree, and a mismatch fails silently as a blank image. A preview is ~50 KB
/// and is fetched only when the source or the IN point changes — never when a
/// ratio is clicked — so inlining it is cheap and cannot break that way.
fn base64(bytes: &[u8]) -> String {
    const SET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(SET[(n >> 18) as usize & 63] as char);
        out.push(SET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            SET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            SET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The derivative as a `data:` URI the webview can render directly.
pub fn data_uri(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).map_err(|e| {
        ShiftError::new("preview_failed", "SHIFT couldn't read the preview.")
            .technical(e.to_string())
    })?;
    Ok(format!("data:image/png;base64,{}", base64(&bytes)))
}

/// Longest edge of a preview derivative. Comfortably above the ~300px the
/// viewport can ever be on a Retina panel, and far below anything expensive.
const PREVIEW_EDGE: u32 = 640;

/// Where derivatives live.
///
/// The caller passes the app's cache directory rather than the system temp
/// root. `std::env::temp_dir()` on macOS is under `/var/folders/...`, and
/// `/var` is a symlink to `/private/var`; the webview's asset protocol
/// canonicalises the path it is asked for and then no longer matches a scope
/// written against the un-resolved form, so the image silently fails to load.
/// The app cache directory has no such indirection.
fn cache_dir(root: &Path) -> Result<PathBuf> {
    let dir = root.join("preview");
    std::fs::create_dir_all(&dir).map_err(|e| {
        ShiftError::new("preview_cache", "SHIFT couldn't prepare a preview.")
            .technical(e.to_string())
    })?;
    Ok(dir)
}

/// A stable name for one source at one moment, so an edited file is not served
/// from a stale derivative.
fn cache_key(path: &Path, at: Option<f64>) -> String {
    let meta = std::fs::metadata(path).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Frames are cached per whole second: scrubbing the IN point a few
    // milliseconds should not re-extract.
    let stamp = at
        .map(|s| format!("-t{}", s.max(0.0) as u64))
        .unwrap_or_default();

    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}-{len}-{mtime}{stamp}.png")
}

/// Build (or reuse) a preview image for a source.
///
/// `at` is a position in seconds for moving media — the IN point when there is
/// one, otherwise somewhere representative. It is ignored for stills.
pub fn derive(
    path: &Path,
    at: Option<f64>,
    cache_root: &Path,
    cancel: &CancelToken,
) -> Result<PathBuf> {
    let is_still = path
        .extension()
        .map(|e| image::is_image_ext(&e.to_string_lossy()))
        .unwrap_or(false);

    let out = cache_dir(cache_root)?.join(cache_key(path, if is_still { None } else { at }));
    if out.is_file() {
        return Ok(out);
    }

    if is_still {
        still(path, &out, cancel)
    } else {
        frame(path, at.unwrap_or(0.0), &out, cancel)
    }
}

/// A still is downscaled by macOS, which already decodes every input format
/// SHIFT accepts — including HEIC, which FFmpeg cannot read.
fn still(input: &Path, out: &Path, cancel: &CancelToken) -> Result<PathBuf> {
    let args: Vec<String> = vec![
        "-s".into(),
        "format".into(),
        "png".into(),
        "-Z".into(),
        PREVIEW_EDGE.to_string(),
        input.to_string_lossy().to_string(),
        "--out".into(),
        out.to_string_lossy().to_string(),
    ];
    let result = run_capture(Binary::Sips, &args, cancel)?;
    if !result.success || !out.is_file() {
        return Err(failed(result.log()));
    }
    Ok(out.to_path_buf())
}

/// One frame, seeked cheaply and scaled down.
///
/// `-ss` before `-i` keeps this fast on a long file, and no attempt is made at
/// frame accuracy: this is a picture of roughly the right moment, not a cut.
/// `scale` caps the longest edge without ever enlarging, and `setsar=1` keeps
/// the preview's own pixels square so the UI is not measuring a stretched image.
fn frame(input: &Path, at: f64, out: &Path, cancel: &CancelToken) -> Result<PathBuf> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    if at > 0.0 {
        args.push("-ss".into());
        args.push(format!("{at:.3}"));
    }
    args.push("-i".into());
    args.push(input.to_string_lossy().to_string());
    args.extend([
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        format!(
            "scale=w='min(iw,{e})':h='min(ih,{e})':force_original_aspect_ratio=decrease,setsar=1",
            e = PREVIEW_EDGE
        ),
        "-an".into(),
        out.to_string_lossy().to_string(),
    ]);

    let result = run_capture(Binary::Ffmpeg, &args, cancel)?;
    if !result.success || !out.is_file() {
        // A seek past the end of a short file lands nowhere; one retry from the
        // start is cheaper than reasoning about durations up front.
        if at > 0.0 {
            return frame(input, 0.0, out, cancel);
        }
        return Err(failed(result.log()));
    }
    Ok(out.to_path_buf())
}

fn failed(technical: String) -> ShiftError {
    ShiftError::new("preview_failed", "SHIFT couldn't build a preview.")
        .hint("The export itself is unaffected.")
        .technical(technical)
}

/// Where to take a video frame from: the IN point when the user has set one,
/// otherwise a representative moment rather than the first frame, which is
/// black on a great many files.
pub fn frame_position(duration: Option<f64>, clip_start: Option<f64>) -> Option<f64> {
    match (clip_start, duration) {
        (Some(start), _) => Some(start),
        (None, Some(d)) if d > 0.0 => Some(d / 2.0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_encoding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // The PNG magic number, which is what actually gets encoded here.
        assert_eq!(base64(&[0x89, b'P', b'N', b'G']), "iVBORw==");
    }

    #[test]
    fn an_in_point_wins_over_the_middle() {
        assert_eq!(frame_position(Some(60.0), Some(12.5)), Some(12.5));
    }

    #[test]
    fn without_a_clip_the_middle_is_used_rather_than_a_black_first_frame() {
        assert_eq!(frame_position(Some(30.0), None), Some(15.0));
    }

    #[test]
    fn an_unknown_duration_asks_for_nothing_in_particular() {
        assert_eq!(frame_position(None, None), None);
        assert_eq!(frame_position(Some(0.0), None), None);
    }

    #[test]
    fn a_frame_cache_key_follows_the_file_and_the_moment() {
        let a = cache_key(Path::new("/x/y.mp4"), Some(4.2));
        let b = cache_key(Path::new("/x/y.mp4"), Some(4.9));
        let c = cache_key(Path::new("/x/y.mp4"), Some(9.0));
        let d = cache_key(Path::new("/x/z.mp4"), Some(4.2));
        assert_eq!(a, b, "sub-second scrubbing must not re-extract");
        assert_ne!(a, c, "a different second is a different frame");
        assert_ne!(a, d, "a different file is a different preview");
        assert!(a.ends_with(".png"));
    }
}
