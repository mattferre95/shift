//! URL providers.
//!
//! yt-dlp is the first provider (URL-01), not the interface. Everything the app
//! needs from a remote source is expressed by `UrlProvider`, so a second
//! provider can be added later without touching the jobs or UI layers.

pub mod ytdlp;

use crate::errors::Result;
use crate::process::CancelToken;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use url::Url;

/// One selectable source quality.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityOption {
    /// Stable id passed back on export, e.g. `best` or `1080`.
    pub id: String,
    /// What the chip reads, e.g. `Best` or `1080p`.
    pub label: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PostMediaType {
    Video,
    Image,
    Audio,
}

/// One ordered media item inside a public post.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostMedia {
    pub id: String,
    #[serde(rename = "type")]
    pub media_type: PostMediaType,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub thumbnail_path: Option<String>,
    /// A post URL for extractor-backed video/audio, or the public CDN URL for an image.
    pub source: String,
    pub filename_hint: Option<String>,
    pub qualities: Vec<QualityOption>,
}

impl PostMedia {
    pub fn has_video(&self) -> bool {
        self.media_type == PostMediaType::Video
    }
}

/// What SHIFT knows about an analyzed public URL.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostResult {
    pub provider: String,
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub platform: String,
    pub domain: String,
    pub media_items: Vec<PostMedia>,
}

pub type UrlMedia = PostResult;

/// What a download should produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadKind {
    /// Best video+audio at or below the selected height.
    Video,
    /// Best audio-only stream; SHIFT converts it afterwards.
    Audio,
    /// Small, directly playable video for the trim player. It may be lower
    /// quality than the eventual export and is only reused when its measured
    /// dimensions prove it satisfies the export request.
    PreviewVideo,
    /// Small audio-only source for the trim player.
    PreviewAudio,
    /// Original/highest practical still image, without conversion.
    Image,
}

pub trait UrlProvider: Send + Sync {
    fn id(&self) -> &'static str;

    /// Cheap check before spending a process on analysis.
    fn handles(&self, url: &Url) -> bool;

    fn analyze(&self, url: &Url, cache_dir: &Path, cancel: &CancelToken) -> Result<UrlMedia>;

    /// Download into `dest_dir`, returning the produced file.
    fn download(
        &self,
        url: &Url,
        kind: DownloadKind,
        quality_id: &str,
        dest_dir: &Path,
        cancel: &CancelToken,
        on_progress: &mut dyn FnMut(Option<f64>),
    ) -> Result<PathBuf>;
}

/// The provider registry. One entry today, ordered by specificity later.
pub fn for_url(url: &Url) -> Option<Box<dyn UrlProvider>> {
    let ytdlp = ytdlp::YtDlpProvider::new();
    if ytdlp.handles(url) {
        return Some(Box::new(ytdlp));
    }
    None
}
