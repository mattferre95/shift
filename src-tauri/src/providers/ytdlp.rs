//! The yt-dlp provider.
//!
//! yt-dlp is used for exactly two things: reading metadata and pulling bytes
//! down. Every conversion, trim and container decision happens afterwards in
//! `media::profiles`, so there is one place that knows about codecs.

use super::{DownloadKind, QualityOption, UrlMedia, UrlProvider};
use crate::errors::{Result, ShiftError};
use crate::process::{resolve, run, run_capture, Binary, CancelToken};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use url::Url;

/// Marker yt-dlp prints for us on stdout, so progress never depends on parsing
/// its human-readable output.
const PROGRESS_PREFIX: &str = "@SHIFT";
const PROGRESS_TEMPLATE: &str =
    "download:@SHIFT %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s";

/// Heights offered when the source actually carries them.
const LADDER: [(u32, &str); 5] = [
    (2160, "2160p"),
    (1440, "1440p"),
    (1080, "1080p"),
    (720, "720p"),
    (480, "480p"),
];

pub struct YtDlpProvider;

impl YtDlpProvider {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Deserialize)]
struct RawInfo {
    title: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
    extractor_key: Option<String>,
    formats: Option<Vec<RawFormat>>,
    #[serde(rename = "_type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct RawFormat {
    width: Option<u32>,
    height: Option<u32>,
    vcodec: Option<String>,
}

impl UrlProvider for YtDlpProvider {
    fn id(&self) -> &'static str {
        "ytdlp"
    }

    fn handles(&self, url: &Url) -> bool {
        // yt-dlp has a generic extractor, so it is the fallback for any http(s).
        matches!(url.scheme(), "http" | "https")
    }

    fn analyze(&self, url: &Url, cache_dir: &Path, cancel: &CancelToken) -> Result<UrlMedia> {
        let args: Vec<String> = vec![
            "--dump-single-json".into(),
            "--no-playlist".into(),
            "--no-warnings".into(),
            "--no-progress".into(),
            "--socket-timeout".into(),
            "20".into(),
            url.as_str().to_string(),
        ];
        let out = run_capture(Binary::YtDlp, &args, cancel)?;
        if !out.success {
            return Err(ShiftError::fetch_failed(out.log()));
        }
        let raw_json = out.stdout.trim().to_string();
        let info: RawInfo = serde_json::from_str(&raw_json)
            .map_err(|e| ShiftError::fetch_failed(format!("unreadable metadata: {e}")))?;

        if info.kind.as_deref() == Some("playlist") {
            return Err(ShiftError::new("playlist", "That link is a playlist.")
                .hint("Paste a link to a single video or track."));
        }

        let domain = url
            .host_str()
            .unwrap_or("")
            .trim_start_matches("www.")
            .to_string();
        let title = info
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| domain.clone());

        let formats = info.formats.unwrap_or_default();
        // Treat a source as video unless every format positively says otherwise.
        // The generic extractor reports neither height nor vcodec, and guessing
        // "audio" there would hide MP4 from the user on an ordinary video file.
        let known_video = formats.iter().any(|f| {
            f.height.unwrap_or(0) > 0 || matches!(f.vcodec.as_deref(), Some(v) if v != "none")
        });
        let all_audio_only =
            !formats.is_empty() && formats.iter().all(|f| f.vcodec.as_deref() == Some("none"));
        let has_video = known_video || !all_audio_only;
        let max_height = formats.iter().filter_map(|f| f.height).max().unwrap_or(0);

        let mut qualities = vec![QualityOption {
            id: "best".into(),
            label: "Best".into(),
        }];
        for (h, label) in LADDER {
            // Only offer a rung the source can actually satisfy, and never one
            // that equals "Best" — that would be two chips for one outcome.
            if max_height > h && formats.iter().any(|f| f.height.unwrap_or(0) >= h) {
                qualities.push(QualityOption {
                    id: h.to_string(),
                    label: label.into(),
                });
            }
        }
        qualities.truncate(4);

        let thumbnail_path = info
            .thumbnail
            .as_deref()
            .and_then(|_| fetch_thumbnail(&raw_json, cache_dir, cancel).ok().flatten())
            .map(|p| p.to_string_lossy().to_string());

        // Top-level width/height when the extractor gives them, otherwise the
        // largest format that reports both. Either is the real frame size, not
        // a guess from the thumbnail.
        let source_size = match (info.width, info.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => (Some(w), Some(h)),
            _ => formats
                .iter()
                .filter(|f| f.width.unwrap_or(0) > 0 && f.height.unwrap_or(0) > 0)
                .max_by_key(|f| f.height.unwrap_or(0))
                .map(|f| (f.width, f.height))
                .unwrap_or((None, None)),
        };

        Ok(UrlMedia {
            provider: self.id().to_string(),
            url: info.webpage_url.unwrap_or_else(|| url.to_string()),
            title,
            domain: if domain.is_empty() {
                info.extractor_key.unwrap_or_default()
            } else {
                domain
            },
            duration: info.duration.filter(|d| *d > 0.0),
            thumbnail_path,
            qualities,
            has_video,
            // The shape of the best video the site offers. Enough for the
            // aspect controls to report real dimensions before anything is
            // downloaded; the picture beside them is still only a thumbnail.
            width: source_size.0,
            height: source_size.1,
        })
    }

    fn download(
        &self,
        url: &Url,
        kind: DownloadKind,
        quality_id: &str,
        dest_dir: &Path,
        cancel: &CancelToken,
        on_progress: &mut dyn FnMut(Option<f64>),
    ) -> Result<PathBuf> {
        let selector = match kind {
            DownloadKind::Audio => "bestaudio/best".to_string(),
            DownloadKind::Video => match quality_id.parse::<u32>() {
                Ok(h) => format!("bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b"),
                Err(_) => "bv*+ba/b".to_string(),
            },
            // A small progressive MP4 reaches WebKit much sooner than the
            // best separate HLS video+audio pair. The fallbacks retain broad
            // provider support and the playback layer proxies only if probe
            // shows that WebKit cannot decode what was returned.
            DownloadKind::PreviewVideo => {
                "b[ext=mp4][protocol=https][height<=540]/b[ext=mp4][height<=540]/b[height<=540]/b"
                    .to_string()
            }
            DownloadKind::PreviewAudio => "ba[ext=m4a]/ba[ext=mp4]/ba/b".to_string(),
        };

        let mut args: Vec<String> = vec![
            "--no-playlist".into(),
            "--no-warnings".into(),
            "--newline".into(),
            "--no-colors".into(),
            "--progress".into(),
            "--progress-template".into(),
            PROGRESS_TEMPLATE.into(),
            "--socket-timeout".into(),
            "20".into(),
            "--retries".into(),
            "3".into(),
            "--concurrent-fragments".into(),
            "4".into(),
            "-f".into(),
            selector,
            "-o".into(),
            dest_dir
                .join("source.%(ext)s")
                .to_string_lossy()
                .to_string(),
        ];
        if matches!(kind, DownloadKind::Video | DownloadKind::PreviewVideo) {
            // Give the muxer a container that always accepts the merged streams.
            args.push("--merge-output-format".into());
            args.push(
                if kind == DownloadKind::PreviewVideo {
                    "mp4"
                } else {
                    "mkv"
                }
                .into(),
            );
        }
        // Point yt-dlp at the same FFmpeg SHIFT ships, never at whatever is on PATH.
        if let Ok(ffmpeg) = resolve(Binary::Ffmpeg) {
            if let Some(dir) = ffmpeg.parent() {
                args.push("--ffmpeg-location".into());
                args.push(dir.to_string_lossy().to_string());
            }
        }
        args.push(url.as_str().to_string());

        let mut on_stdout = |line: &str| {
            if let Some(fraction) = parse_progress(line) {
                on_progress(fraction);
            }
        };

        let out = run(Binary::YtDlp, &args, cancel, Some(&mut on_stdout), None)?;
        if !out.success {
            return Err(ShiftError::download_failed(out.log()));
        }

        find_downloaded(dest_dir).ok_or_else(|| {
            ShiftError::download_failed("yt-dlp reported success but produced no file")
        })
    }
}

/// Pull the thumbnail down through the backend rather than letting the webview
/// reach out to a remote host (PRD §9, "Remote content").
///
/// Reuses the metadata already extracted via `--load-info-json` instead of
/// asking yt-dlp to visit the site a second time. On a real extractor that is
/// the difference between roughly forty seconds of "Reading…" and a handful.
fn fetch_thumbnail(
    raw_info: &str,
    cache_dir: &Path,
    cancel: &CancelToken,
) -> Result<Option<PathBuf>> {
    std::fs::create_dir_all(cache_dir).ok();
    let info_path = cache_dir.join("info.json");
    if std::fs::write(&info_path, raw_info).is_err() {
        return Ok(None);
    }
    let stem = cache_dir.join("thumb");
    let args: Vec<String> = vec![
        "--load-info-json".into(),
        info_path.to_string_lossy().to_string(),
        "--skip-download".into(),
        "--write-thumbnail".into(),
        "--convert-thumbnails".into(),
        "jpg".into(),
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--no-progress".into(),
        "-o".into(),
        format!("{}.%(ext)s", stem.to_string_lossy()),
    ];
    // A missing thumbnail is cosmetic; never fail analysis over it.
    let _ = run_capture(Binary::YtDlp, &args, cancel);
    for ext in ["jpg", "jpeg", "png", "webp"] {
        let candidate = cache_dir.join(format!("thumb.{ext}"));
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn find_downloaded(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        // Skip yt-dlp's in-flight fragments.
        if name.ends_with(".part") || name.ends_with(".ytdl") {
            continue;
        }
        let size = entry.metadata().ok().map(|m| m.len()).unwrap_or(0);
        if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
            best = Some((size, path));
        }
    }
    best.map(|(_, p)| p)
}

/// `@SHIFT <downloaded> <total> <estimate>` — returns `None` when the total is
/// unknown, so the UI falls back to stage progress instead of a fake number.
fn parse_progress(line: &str) -> Option<Option<f64>> {
    let rest = line.trim().strip_prefix(PROGRESS_PREFIX)?;
    let parts: Vec<&str> = rest.split_whitespace().collect();
    if parts.is_empty() {
        return Some(None);
    }
    let done: f64 = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let total: Option<f64> = parts
        .get(1)
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| parts.get(2).and_then(|v| v.parse::<f64>().ok()))
        .filter(|t| *t > 0.0);
    Some(total.map(|t| (done / t).clamp(0.0, 1.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_known_total() {
        assert_eq!(parse_progress("@SHIFT 500 1000 NA"), Some(Some(0.5)));
    }

    #[test]
    fn falls_back_to_the_estimate() {
        assert_eq!(parse_progress("@SHIFT 250 NA 1000"), Some(Some(0.25)));
    }

    #[test]
    fn reports_nothing_when_the_size_is_unknown() {
        assert_eq!(parse_progress("@SHIFT 250 NA NA"), Some(None));
    }

    #[test]
    fn ignores_unrelated_output() {
        assert_eq!(parse_progress("[download] Destination: source.mp4"), None);
    }
}
