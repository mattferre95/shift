//! URL providers.
//!
//! yt-dlp is the first provider (URL-01), not the interface. Everything the app
//! needs from a remote source is expressed by `UrlProvider`, so a second
//! provider can be added later without touching the jobs or UI layers.

pub mod ytdlp;

use crate::errors::Result;
use crate::process::CancelToken;
use serde::Serialize;
use std::path::{Path, PathBuf};
use url::Url;

/// One selectable source quality.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityOption {
    /// Stable id passed back on export, e.g. `best` or `1080`.
    pub id: String,
    /// What the chip reads, e.g. `Best` or `1080p`.
    pub label: String,
}

/// What SHIFT knows about a remote item after analysis (URL-02).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlMedia {
    /// Which provider produced this, so a second one stays distinguishable.
    pub provider: String,
    pub url: String,
    pub title: String,
    pub domain: String,
    pub duration: Option<f64>,
    /// Local path to a cached thumbnail, served through the asset protocol.
    pub thumbnail_path: Option<String>,
    pub qualities: Vec<QualityOption>,
    pub has_video: bool,
}

/// What a download should produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadKind {
    /// Best video+audio at or below the selected height.
    Video,
    /// Best audio-only stream; SHIFT converts it afterwards.
    Audio,
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
