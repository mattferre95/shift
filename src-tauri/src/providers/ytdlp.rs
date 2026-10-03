//! The yt-dlp provider.
//!
//! yt-dlp is used for exactly two things: reading metadata and pulling bytes
//! down. Every conversion, trim and container decision happens afterwards in
//! `media::profiles`, so there is one place that knows about codecs.
//!
//! Public social posts need one extra metadata step so ordered image and mixed
//! media entries are not discarded by extractors that expose only video.

use super::{DownloadKind, PostMedia, PostMediaType, QualityOption, UrlMedia, UrlProvider};
use crate::errors::{Result, ShiftError};
use crate::process::{resolve, run, run_capture, Binary, CancelToken};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
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

#[derive(Clone, Deserialize)]
struct RawInfo {
    id: Option<String>,
    title: Option<String>,
    uploader: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
    extractor_key: Option<String>,
    ext: Option<String>,
    formats: Option<Vec<RawFormat>>,
    entries: Option<Vec<Option<RawInfo>>>,
    #[serde(rename = "_type")]
    kind: Option<String>,
}
#[derive(Clone, Deserialize)]
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

    fn analyze(&self, url: &Url, cache: &Path, cancel: &CancelToken) -> Result<UrlMedia> {
        let platform = platform_for(url);
        // X's extractor deliberately discards photos. Its dumped public API
        // response contains the complete ordered media array, including video,
        // so use that single response first rather than resolving a mixed post
        // twice and returning only its moving items.
        if platform == "X" {
            if let Some(post) = public_fallback(url, cache, cancel, &platform)? {
                return Ok(post);
            }
        }
        let args = vec![
            "--dump-single-json".into(),
            "--no-warnings".into(),
            "--no-progress".into(),
            "--socket-timeout".into(),
            "20".into(),
            url.as_str().into(),
        ];
        let out = run_capture(Binary::YtDlp, &args, cancel)?;
        let direct = if out.success {
            serde_json::from_str::<RawInfo>(out.stdout.trim())
                .ok()
                .and_then(|info| post_from_ytdlp(url, cache, cancel, info).ok())
        } else {
            None
        };
        let needs_fallback = direct.as_ref().is_none_or(|post| {
            is_social(&platform)
                && (post.media_items.is_empty()
                    || (platform == "TikTok"
                        && post
                            .media_items
                            .iter()
                            .all(|item| item.media_type == PostMediaType::Audio)))
        });
        let inspect_carousel = platform == "Instagram"
            && direct
                .as_ref()
                .is_some_and(|post| post.media_items.len() > 1);
        if needs_fallback || inspect_carousel {
            if let Some(post) = public_fallback(url, cache, cancel, &platform)? {
                if needs_fallback
                    || direct
                        .as_ref()
                        .is_none_or(|current| post.media_items.len() >= current.media_items.len())
                {
                    return Ok(post);
                }
            }
        }
        direct.ok_or_else(|| social_error(&platform, out.log()))
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
            DownloadKind::Image => None,
            DownloadKind::Audio => Some("bestaudio/best".to_string()),
            DownloadKind::Video => Some(match quality_id.parse::<u32>() {
                Ok(h) => format!("bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b"),
                Err(_) => "bv*+ba/b".to_string(),
            }),
            // A small progressive MP4 reaches WebKit much sooner when a
            // provider offers one. Some providers expose only separate video
            // and audio streams, so retain a height-limited merged fallback.
            // The playback layer proxies only if probe shows that WebKit
            // cannot decode what was returned.
            DownloadKind::PreviewVideo => Some(
                "b[ext=mp4][protocol=https][height<=540]/b[ext=mp4][height<=540]/bv*[height<=540]+ba/b[height<=540]/bv*+ba/b"
                    .to_string(),
            ),
            DownloadKind::PreviewAudio => Some("ba[ext=m4a]/ba[ext=mp4]/ba/b".to_string()),
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
        ];
        if let Some(selector) = selector {
            args.push("-f".into());
            args.push(selector);
        }
        args.push("-o".into());
        args.push(
            dest_dir
                .join("source.%(ext)s")
                .to_string_lossy()
                .to_string(),
        );
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
        if let Some(referer) = referer_for(url) {
            args.push("--referer".into());
            args.push(referer.into());
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
            ShiftError::download_failed(format!(
                "yt-dlp reported success but produced no file: {}",
                out.log()
            ))
        })
    }
}

fn post_from_ytdlp(
    url: &Url,
    cache: &Path,
    cancel: &CancelToken,
    info: RawInfo,
) -> Result<UrlMedia> {
    let platform = platform_for(url);
    let title = info
        .title
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("{platform} post"));
    let mut raws: Vec<_> = info
        .entries
        .clone()
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .collect();
    if raws.is_empty() && info.kind.as_deref() != Some("playlist") {
        raws.push(info.clone());
    }
    let count = raws.len();
    let mut media_items = Vec::with_capacity(count);
    for (index, raw) in raws.into_iter().enumerate() {
        let formats = raw.formats.clone().unwrap_or_default();
        // Treat a source as video unless every format positively says otherwise.
        // The generic extractor reports neither height nor vcodec, and guessing
        // "audio" there would hide MP4 from the user on an ordinary video file.
        let known_video = formats.iter().any(|f| {
            f.height.unwrap_or(0) > 0 || matches!(f.vcodec.as_deref(), Some(v) if v != "none")
        });
        let all_audio =
            !formats.is_empty() && formats.iter().all(|f| f.vcodec.as_deref() == Some("none"));
        let media_type = if known_video || !all_audio {
            PostMediaType::Video
        } else {
            PostMediaType::Audio
        };
        let (width, height) = source_size(&raw, &formats);
        let thumb = raw.thumbnail.as_deref().and_then(|source| {
            fetch_thumbnail(source, &cache.join(format!("item-{index}")), cancel)
                .ok()
                .flatten()
        });
        media_items.push(PostMedia {
            id: raw.id.clone().unwrap_or_else(|| (index + 1).to_string()),
            media_type,
            width,
            height,
            duration: raw.duration.filter(|v| *v > 0.0),
            thumbnail_path: thumb.map(|v| v.to_string_lossy().into_owned()),
            source: raw.webpage_url.clone().unwrap_or_else(|| url.to_string()),
            filename_hint: Some(filename_hint(&platform, index, count, raw.ext.as_deref())),
            qualities: qualities(&formats),
        });
    }
    Ok(UrlMedia {
        provider: "ytdlp".into(),
        url: url.to_string(),
        title,
        author: info.uploader,
        platform,
        domain: domain_for(url, info.extractor_key.as_deref()),
        media_items,
    })
}

fn public_fallback(
    url: &Url,
    cache: &Path,
    cancel: &CancelToken,
    platform: &str,
) -> Result<Option<UrlMedia>> {
    if !is_social(platform) {
        return Ok(None);
    }
    let args = vec![
        "--skip-download".into(),
        "--no-warnings".into(),
        "--dump-pages".into(),
        "--socket-timeout".into(),
        "20".into(),
        url.as_str().into(),
    ];
    let out = run_capture(Binary::YtDlp, &args, cancel)?;
    let docs = dumped_json(&out.stdout);
    let mut items = match platform {
        "X" => extract_x(&docs),
        "Instagram" => extract_instagram(&docs),
        "TikTok" => extract_tiktok(&docs),
        _ => Vec::new(),
    };
    if items.is_empty() {
        return Ok(None);
    }
    let (title, author) = fallback_metadata(&docs, platform);
    let count = items.len();
    for (index, item) in items.iter_mut().enumerate() {
        item.filename_hint = Some(filename_hint(
            platform,
            index,
            count,
            extension_from_url(&item.source).as_deref(),
        ));
        if let Some(source) = item.thumbnail_path.take() {
            item.thumbnail_path =
                fetch_thumbnail(&source, &cache.join(format!("item-{index}")), cancel)
                    .ok()
                    .flatten()
                    .map(|v| v.to_string_lossy().into_owned());
        }
    }
    Ok(Some(UrlMedia {
        provider: "ytdlp".into(),
        url: url.to_string(),
        title: title.unwrap_or_else(|| format!("{platform} post")),
        author,
        platform: platform.into(),
        domain: domain_for(url, None),
        media_items: items,
    }))
}

fn fallback_metadata(docs: &[Value], platform: &str) -> (Option<String>, Option<String>) {
    let mut title = None;
    let mut author = None;
    walk(docs, &mut |object| {
        let owns_media = match platform {
            "X" => object.get("extended_entities").is_some(),
            "Instagram" => {
                object.get("carousel_media").is_some() || object.get("image_versions2").is_some()
            }
            "TikTok" => object.get("imagePost").is_some() || object.get("imagePostInfo").is_some(),
            _ => false,
        };
        if !owns_media {
            return;
        }
        title = title.take().or_else(|| match platform {
            "X" => object
                .get("full_text")
                .and_then(Value::as_str)
                .map(str::to_string),
            "Instagram" => object
                .get("caption")
                .and_then(|v| v.get("text"))
                .and_then(Value::as_str)
                .map(str::to_string),
            "TikTok" => object
                .get("desc")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        });
        author = author.take().or_else(|| {
            object
                .get("user")
                .and_then(|v| {
                    v.get("username")
                        .or_else(|| v.get("screen_name"))
                        .or_else(|| v.get("nickname"))
                })
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    });
    (title.map(|v| v.chars().take(96).collect()), author)
}

fn dumped_json(stdout: &str) -> Vec<Value> {
    let mut values = Vec::new();
    for line in stdout.lines().map(str::trim) {
        if line.len() < 8
            || !line
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
        {
            continue;
        }
        let Ok(decoded) = STANDARD.decode(line) else {
            continue;
        };
        let Ok(text) = String::from_utf8(decoded) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            values.push(value);
        }
        let mut rest = text.as_str();
        while let Some(start) = rest.find("<script") {
            rest = &rest[start + 7..];
            let Some(open) = rest.find('>') else { break };
            rest = &rest[open + 1..];
            let Some(close) = rest.find("</script>") else {
                break;
            };
            if let Ok(value) = serde_json::from_str::<Value>(rest[..close].trim()) {
                values.push(value);
            }
            rest = &rest[close + 9..];
        }
    }
    values
}

fn extract_x(docs: &[Value]) -> Vec<PostMedia> {
    let mut best = Vec::new();
    walk(docs, &mut |object| {
        let Some(media) = object
            .get("extended_entities")
            .and_then(|v| v.get("media"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let items = media
            .iter()
            .filter_map(|v| {
                let base = v.get("media_url_https")?.as_str()?;
                let kind = v.get("type").and_then(Value::as_str)?;
                let (media_type, source, duration) = if kind == "photo" {
                    (PostMediaType::Image, format!("{base}?name=orig"), None)
                } else if matches!(kind, "video" | "animated_gif") {
                    let variants = v.pointer("/video_info/variants")?.as_array()?;
                    let source = variants
                        .iter()
                        .filter(|variant| {
                            variant.get("content_type").and_then(Value::as_str) == Some("video/mp4")
                        })
                        .max_by_key(|variant| {
                            variant.get("bitrate").and_then(Value::as_u64).unwrap_or(0)
                        })?
                        .get("url")?
                        .as_str()?
                        .to_string();
                    let duration = v
                        .pointer("/video_info/duration_millis")
                        .and_then(Value::as_f64)
                        .map(|value| value / 1000.0);
                    (PostMediaType::Video, source, duration)
                } else {
                    return None;
                };
                Some(PostMedia {
                    id: v
                        .get("id_str")
                        .and_then(Value::as_str)
                        .unwrap_or(base)
                        .into(),
                    media_type,
                    width: v
                        .pointer("/original_info/width")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    height: v
                        .pointer("/original_info/height")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    duration,
                    thumbnail_path: Some(format!("{base}?name=small")),
                    source,
                    filename_hint: None,
                    qualities: if media_type == PostMediaType::Video {
                        vec![QualityOption {
                            id: "best".into(),
                            label: "Best".into(),
                        }]
                    } else {
                        Vec::new()
                    },
                })
            })
            .collect::<Vec<_>>();
        if items.len() > best.len() {
            best = items;
        }
    });
    dedupe(best)
}

fn extract_instagram(docs: &[Value]) -> Vec<PostMedia> {
    let mut best = Vec::new();
    walk(docs, &mut |object| {
        if let Some(carousel) = object.get("carousel_media").and_then(Value::as_array) {
            let items = carousel
                .iter()
                .filter_map(instagram_item)
                .collect::<Vec<_>>();
            if items.len() > best.len() {
                best = items;
            }
        }
    });
    if best.is_empty() {
        walk(docs, &mut |object| {
            if object.contains_key("image_versions2") {
                if let Some(item) = instagram_item(&Value::Object(object.clone())) {
                    best.push(item);
                }
            }
        });
    }
    dedupe(best)
}

fn instagram_item(value: &Value) -> Option<PostMedia> {
    let object = value.as_object()?;
    let is_video = object.get("media_type").and_then(Value::as_u64) == Some(2);
    let (source, thumb) = if is_video {
        let versions = object.get("video_versions")?.as_array()?;
        let best = versions.iter().max_by_key(area)?;
        let url = best.get("url")?.as_str()?.to_string();
        (url.clone(), url)
    } else {
        let candidates = object
            .get("image_versions2")?
            .get("candidates")?
            .as_array()?;
        let best = candidates.iter().max_by_key(area)?;
        let thumb = candidates
            .iter()
            .min_by_key(|v| {
                v.get("width")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX)
                    .abs_diff(320)
            })
            .unwrap_or(best);
        (
            best.get("url")?.as_str()?.to_string(),
            thumb.get("url")?.as_str()?.to_string(),
        )
    };
    Some(PostMedia {
        id: object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&source)
            .into(),
        media_type: if is_video {
            PostMediaType::Video
        } else {
            PostMediaType::Image
        },
        width: object
            .get("original_width")
            .or_else(|| object.get("width"))
            .and_then(Value::as_u64)
            .map(|v| v as u32),
        height: object
            .get("original_height")
            .or_else(|| object.get("height"))
            .and_then(Value::as_u64)
            .map(|v| v as u32),
        duration: object.get("video_duration").and_then(Value::as_f64),
        thumbnail_path: Some(thumb),
        source,
        filename_hint: None,
        qualities: vec![QualityOption {
            id: "best".into(),
            label: "Best".into(),
        }],
    })
}

fn extract_tiktok(docs: &[Value]) -> Vec<PostMedia> {
    let mut best = Vec::new();
    walk(docs, &mut |object| {
        let Some(images) = object
            .get("imagePost")
            .or_else(|| object.get("imagePostInfo"))
            .and_then(|v| v.get("images"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let items = images
            .iter()
            .enumerate()
            .filter_map(|(index, value)| {
                let image = value.get("imageURL").unwrap_or(value);
                let urls = image
                    .get("urlList")
                    .or_else(|| image.get("url_list"))?
                    .as_array()?;
                let source = urls.iter().filter_map(Value::as_str).next()?.to_string();
                Some(PostMedia {
                    id: image
                        .get("uri")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("photo-{}", index + 1)),
                    media_type: PostMediaType::Image,
                    width: image.get("width").and_then(Value::as_u64).map(|v| v as u32),
                    height: image
                        .get("height")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    duration: None,
                    thumbnail_path: Some(source.clone()),
                    source,
                    filename_hint: None,
                    qualities: Vec::new(),
                })
            })
            .collect::<Vec<_>>();
        if items.len() > best.len() {
            best = items;
        }
    });
    dedupe(best)
}

fn area(value: &&Value) -> u64 {
    value.get("width").and_then(Value::as_u64).unwrap_or(0)
        * value.get("height").and_then(Value::as_u64).unwrap_or(0)
}
fn walk(values: &[Value], visit: &mut impl FnMut(&Map<String, Value>)) {
    fn one(value: &Value, visit: &mut impl FnMut(&Map<String, Value>)) {
        match value {
            Value::Object(map) => {
                visit(map);
                for value in map.values() {
                    one(value, visit);
                }
            }
            Value::Array(values) => {
                for value in values {
                    one(value, visit);
                }
            }
            _ => {}
        }
    }
    for value in values {
        one(value, visit);
    }
}
fn dedupe(items: Vec<PostMedia>) -> Vec<PostMedia> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|v| seen.insert(v.source.clone()))
        .collect()
}
fn platform_for(url: &Url) -> String {
    let host = url.host_str().unwrap_or("").trim_start_matches("www.");
    if host == "x.com" || host.ends_with("twitter.com") {
        "X"
    } else if host.ends_with("instagram.com") {
        "Instagram"
    } else if host.ends_with("tiktok.com") {
        "TikTok"
    } else {
        host
    }
    .to_string()
}
fn is_social(platform: &str) -> bool {
    matches!(platform, "X" | "Instagram" | "TikTok")
}
fn domain_for(url: &Url, fallback: Option<&str>) -> String {
    url.host_str()
        .map(|v| v.trim_start_matches("www.").to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| fallback.map(str::to_string))
        .unwrap_or_default()
}
fn source_size(raw: &RawInfo, formats: &[RawFormat]) -> (Option<u32>, Option<u32>) {
    // Top-level width/height when the extractor gives them, otherwise the
    // largest format that reports both. Either is the real frame size, not a
    // guess from the thumbnail.
    match (raw.width, raw.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (Some(w), Some(h)),
        _ => formats
            .iter()
            .filter(|v| v.width.unwrap_or(0) > 0 && v.height.unwrap_or(0) > 0)
            .max_by_key(|v| v.height.unwrap_or(0))
            .map(|v| (v.width, v.height))
            .unwrap_or((None, None)),
    }
}
fn qualities(formats: &[RawFormat]) -> Vec<QualityOption> {
    let max = formats.iter().filter_map(|v| v.height).max().unwrap_or(0);
    let mut out = vec![QualityOption {
        id: "best".into(),
        label: "Best".into(),
    }];
    for (height, label) in LADDER {
        // Only offer a rung the source can actually satisfy, and never one that
        // equals "Best" — that would be two chips for one outcome.
        if max > height && formats.iter().any(|v| v.height.unwrap_or(0) >= height) {
            out.push(QualityOption {
                id: height.to_string(),
                label: label.into(),
            });
        }
    }
    out.truncate(4);
    out
}
fn filename_hint(platform: &str, index: usize, count: usize, ext: Option<&str>) -> String {
    let base = platform.to_ascii_lowercase();
    let ext = ext.filter(|v| !v.is_empty()).unwrap_or("media");
    if count > 1 {
        format!("{base}-post-{:02}.{ext}", index + 1)
    } else {
        format!("{base}-post.{ext}")
    }
}
fn extension_from_url(source: &str) -> Option<String> {
    let ext = source
        .split('?')
        .next()?
        .rsplit('.')
        .next()?
        .to_ascii_lowercase();
    (ext.len() <= 5 && ext.chars().all(|v| v.is_ascii_alphanumeric())).then_some(ext)
}
fn social_error(platform: &str, technical: String) -> ShiftError {
    if !is_social(platform) {
        return ShiftError::fetch_failed(technical);
    }
    let lower = technical.to_ascii_lowercase();
    if lower.contains("sign in")
        || lower.contains("login")
        || lower.contains("not available to everyone")
    {
        return ShiftError::new(
            "auth_required",
            format!("This {platform} post requires sign-in."),
        )
        .hint("SHIFT supports public posts that open without an account.")
        .technical(technical);
    }
    if lower.contains("private") {
        return ShiftError::new("private_post", "This post is private.")
            .hint("SHIFT only supports public media.")
            .technical(technical);
    }
    ShiftError::new("no_post_media", "No downloadable media was found.")
        .hint(if is_social(platform) {
            format!("{platform} may have changed its public media format, or the post may be unavailable.")
        } else { "Check the link and try again.".into() }).technical(technical)
}
/// Pull a thumbnail down through the backend instead of exposing its remote
/// host to the webview. Each post item receives its own cache directory.
fn fetch_thumbnail(source: &str, cache: &Path, cancel: &CancelToken) -> Result<Option<PathBuf>> {
    std::fs::create_dir_all(cache).ok();
    let mut args = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--no-progress".into(),
        "-o".into(),
        cache.join("thumb.%(ext)s").to_string_lossy().into_owned(),
    ];
    if let Ok(url) = Url::parse(source) {
        if let Some(referer) = referer_for(&url) {
            args.extend(["--referer".into(), referer.into()]);
        }
    }
    args.push(source.into());
    // A missing thumbnail is cosmetic; never fail analysis over it.
    let _ = run_capture(Binary::YtDlp, &args, cancel);
    for ext in ["jpg", "jpeg", "png", "webp"] {
        let path = cache.join(format!("thumb.{ext}"));
        if path.is_file() {
            return Ok(Some(path));
        }
    }
    Ok(None)
}
fn referer_for(url: &Url) -> Option<&'static str> {
    let host = url.host_str()?;
    if host.contains("cdninstagram") || host.ends_with("fbcdn.net") {
        Some("https://www.instagram.com/")
    } else if host.contains("tiktok") || host.contains("byteoversea") {
        Some("https://www.tiktok.com/")
    } else {
        None
    }
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

    #[test]
    fn x_photos_keep_order_and_original_size() {
        let fixture = serde_json::json!({"extended_entities":{"media":[
            {"id_str":"a","type":"photo","media_url_https":"https://pbs.twimg.com/media/a.jpg","original_info":{"width":1200,"height":800}},
            {"id_str":"b","type":"photo","media_url_https":"https://pbs.twimg.com/media/b.png","original_info":{"width":900,"height":1200}}
        ]}});
        let items = extract_x(&[fixture]);
        assert_eq!(
            items.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(
            items[0].source,
            "https://pbs.twimg.com/media/a.jpg?name=orig"
        );
        assert_eq!((items[0].width, items[0].height), (Some(1200), Some(800)));
    }
    #[test]
    fn instagram_mixed_carousel_keeps_types() {
        let fixture = serde_json::json!({"carousel_media":[
            {"id":"p","media_type":1,"original_width":1080,"original_height":1350,
             "image_versions2":{"candidates":[{"url":"https://cdn/p-small.jpg","width":320,"height":400},{"url":"https://cdn/p.jpg","width":1080,"height":1350}]}},
            {"id":"v","media_type":2,"original_width":720,"original_height":1280,
             "video_versions":[{"url":"https://cdn/v.mp4","width":720,"height":1280}]}
        ]});
        let items = extract_instagram(&[fixture]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].media_type, PostMediaType::Image);
        assert_eq!(items[1].media_type, PostMediaType::Video);
    }
    #[test]
    fn tiktok_photos_ignore_soundtrack() {
        let fixture = serde_json::json!({"imagePost":{"images":[
            {"imageURL":{"uri":"one","urlList":["https://cdn/1.webp"]}},
            {"imageURL":{"uri":"two","urlList":["https://cdn/2.webp"]}}
        ]},"music":{"playUrl":"https://cdn/sound.mp3"}});
        let items = extract_tiktok(&[fixture]);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|v| v.media_type == PostMediaType::Image));
    }
    #[test]
    #[ignore = "real public network smoke"]
    fn public_x_photo_smoke() {
        let url = Url::parse("https://x.com/NASA/status/2040059770237849635/photo/1").unwrap();
        let cache = std::env::temp_dir().join(format!("shift-x-photo-{}", std::process::id()));
        let post = YtDlpProvider::new()
            .analyze(&url, &cache, &CancelToken::new())
            .unwrap();
        assert_eq!(post.platform, "X");
        assert_eq!(post.media_items.len(), 1);
        assert_eq!(post.media_items[0].media_type, PostMediaType::Image);
        assert!(post.media_items[0].source.contains("name=orig"));
        assert!(post.media_items[0]
            .thumbnail_path
            .as_deref()
            .is_some_and(|path| Path::new(path).is_file()));
        let source = Url::parse(&post.media_items[0].source).unwrap();
        let download_dir = cache.join("download");
        std::fs::create_dir_all(&download_dir).unwrap();
        let acquired = YtDlpProvider::new()
            .download(
                &source,
                DownloadKind::Image,
                "best",
                &download_dir,
                &CancelToken::new(),
                &mut |_| {},
            )
            .unwrap();
        assert!(acquired.metadata().unwrap().len() > 0);
        std::fs::remove_dir_all(cache).ok();
    }
    #[test]
    #[ignore = "real public network smoke"]
    fn public_x_video_smoke() {
        let url = Url::parse("https://twitter.com/i/web/status/910031516746514432").unwrap();
        let cache = std::env::temp_dir().join(format!("shift-x-video-{}", std::process::id()));
        let post = YtDlpProvider::new()
            .analyze(&url, &cache, &CancelToken::new())
            .unwrap();
        assert_eq!(post.media_items.len(), 1);
        assert_eq!(post.media_items[0].media_type, PostMediaType::Video);
        assert!(post.media_items[0].source.contains(".mp4"));
        std::fs::remove_dir_all(cache).ok();
    }
    #[test]
    #[ignore = "real public network smoke"]
    fn public_x_multi_image_smoke() {
        let url = Url::parse("https://x.com/Garrodor/status/1967217092396208421/photo/4").unwrap();
        let cache = std::env::temp_dir().join(format!("shift-x-gallery-{}", std::process::id()));
        let post = YtDlpProvider::new()
            .analyze(&url, &cache, &CancelToken::new())
            .unwrap();
        assert_eq!(post.media_items.len(), 4);
        assert!(post
            .media_items
            .iter()
            .all(|item| item.media_type == PostMediaType::Image));
        assert_eq!(
            post.media_items
                .iter()
                .map(|item| item.filename_hint.as_deref())
                .collect::<Vec<_>>(),
            [
                Some("x-post-01.jpg"),
                Some("x-post-02.jpg"),
                Some("x-post-03.jpg"),
                Some("x-post-04.jpg")
            ]
        );
        std::fs::remove_dir_all(cache).ok();
    }
}
