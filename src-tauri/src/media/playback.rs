//! Session-owned playable assets. Originals may feed exports; proxies never do.
use crate::{
    errors::{Result, ShiftError},
    filesystem::TempDir,
    jobs::InputSpec,
    media::{
        ffprobe::{self, MediaProbe},
        profiles,
    },
    process::CancelToken,
    providers::{self, DownloadKind, PostMedia},
    validation,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub struct Asset {
    pub source: PathBuf,
    pub playable: PathBuf,
    pub probe: MediaProbe,
    pub title: String,
    pub proxy: bool,
    /// True only when the preview download also satisfies the requested
    /// export quality. Lightweight previews otherwise remain preview-only.
    pub export_safe: bool,
    // An export holds an Arc lease, so reset cannot remove its source mid-encode.
    _temp: TempDir,
}
struct Session {
    input: InputSpec,
    known_media: Option<PostMedia>,
    cancel: Arc<CancelToken>,
    asset: Mutex<Option<Arc<Asset>>>,
}
#[derive(Default)]
pub struct PlaybackRegistry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackInfo {
    pub path: String,
    pub duration: Option<f64>,
    pub has_video: bool,
    pub has_audio: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub proxy: bool,
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStage {
    ResolvingLink,
    SourceSelected,
    DownloadingPreview,
    MediaAvailable,
    PreparingPlayer,
    Proxying,
    BackendReady,
}
impl Asset {
    pub fn info(&self) -> PlaybackInfo {
        PlaybackInfo {
            path: self.playable.to_string_lossy().into_owned(),
            duration: self.probe.duration,
            has_video: self.probe.has_video(),
            has_audio: self.probe.audio.is_some(),
            width: self.probe.video.as_ref().and_then(|v| v.width),
            height: self.probe.video.as_ref().and_then(|v| v.height),
            proxy: self.proxy,
        }
    }
}
impl PlaybackRegistry {
    pub fn create(&self, input: InputSpec) -> String {
        self.create_known(input, None)
    }
    pub fn create_known(&self, input: InputSpec, known_media: Option<PostMedia>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(
            id.clone(),
            Arc::new(Session {
                input,
                known_media,
                cancel: CancelToken::new(),
                asset: Mutex::new(None),
            }),
        );
        id
    }
    pub fn release(&self, id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().remove(id) {
            session.cancel.cancel();
        }
    }
    pub fn clear(&self) {
        for (_, session) in self.sessions.lock().unwrap().drain() {
            session.cancel.cancel();
        }
    }
    pub fn cached(&self, input: &InputSpec, audio_only: bool) -> Option<Arc<Asset>> {
        let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        sessions.iter().find_map(|s| {
            let matches = match (&s.input, input) {
                (
                    InputSpec::Url {
                        url: a,
                        quality: aq,
                    },
                    InputSpec::Url {
                        url: b,
                        quality: bq,
                    },
                ) => a == b && (audio_only || aq == bq),
                _ => false,
            };
            if !matches || s.cancel.is_cancelled() {
                return None;
            }
            s.asset
                .try_lock()
                .ok()?
                .clone()
                .filter(|asset| asset.export_safe)
        })
    }
    pub fn prepare(&self, id: &str, force_proxy: bool) -> Result<Arc<Asset>> {
        self.prepare_traced(id, force_proxy, None, &mut |_, _| {})
    }
    /// Provider injection keeps offline integration tests on the real lifecycle.
    pub fn prepare_with_provider(
        &self,
        id: &str,
        force_proxy: bool,
        provider: Option<&dyn providers::UrlProvider>,
    ) -> Result<Arc<Asset>> {
        self.prepare_traced(id, force_proxy, provider, &mut |_, _| {})
    }
    pub fn prepare_traced(
        &self,
        id: &str,
        force_proxy: bool,
        provider: Option<&dyn providers::UrlProvider>,
        on_stage: &mut dyn FnMut(PlaybackStage, Option<String>),
    ) -> Result<Arc<Asset>> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(ShiftError::cancelled)?;
        let mut slot = session.asset.lock().unwrap();
        if session.cancel.is_cancelled() {
            return Err(ShiftError::cancelled());
        }
        if let Some(asset) = slot.as_ref() {
            if !force_proxy || asset.proxy {
                return Ok(asset.clone());
            }
        }
        let temp = TempDir::create(&format!("playback-{}", uuid::Uuid::new_v4()))?;
        let (source, title, export_safe) = if let Some(asset) = slot.as_ref() {
            // Fallback for a codec WebKit claimed it could play. Keep the source
            // in its original session directory until the replacement is ready.
            let dest = temp.path().join(asset.source.file_name().unwrap());
            std::fs::hard_link(&asset.source, &dest)
                .or_else(|_| std::fs::copy(&asset.source, &dest).map(|_| ()))
                .map_err(|e| ShiftError::io("retain source", e))?;
            (dest, asset.title.clone(), asset.export_safe)
        } else {
            match &session.input {
                InputSpec::Local { path } => {
                    on_stage(PlaybackStage::PreparingPlayer, None);
                    let p = validation::validate_input_path(path)?;
                    let title = p
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    (p, title, true)
                }
                InputSpec::Url { url, quality } => {
                    on_stage(PlaybackStage::ResolvingLink, None);
                    let parsed = validation::validate_url(url)?;
                    let resolved = providers::for_url(&parsed).ok_or_else(|| {
                        ShiftError::new("no_provider", "SHIFT can't handle this link.")
                    })?;
                    let provider = provider.unwrap_or(resolved.as_ref());
                    // URL detection already paid for metadata. Reuse it instead
                    // of making the provider resolve the same post a second time.
                    let media = match session.known_media.clone() {
                        Some(media) => media,
                        None => provider
                            .analyze(&parsed, &temp.sub("meta")?, &session.cancel)?
                            .media_items
                            .into_iter()
                            .next()
                            .ok_or_else(|| ShiftError::new("no_post_media", "No downloadable media was found."))?,
                    };
                    let kind = if media.has_video() {
                        DownloadKind::PreviewVideo
                    } else {
                        DownloadKind::PreviewAudio
                    };
                    on_stage(
                        PlaybackStage::SourceSelected,
                        Some(if media.has_video() { "video" } else { "audio" }.into()),
                    );
                    on_stage(PlaybackStage::DownloadingPreview, None);
                    let source = provider.download(
                        &parsed,
                        kind,
                        quality.as_deref().unwrap_or("best"),
                        &temp.sub("source")?,
                        &session.cancel,
                        &mut |_| {},
                    )?;
                    on_stage(PlaybackStage::MediaAvailable, None);
                    (source, media.filename_hint.unwrap_or_else(|| "media".into()), false)
                }
            }
        };
        on_stage(PlaybackStage::PreparingPlayer, None);
        let probe = ffprobe::probe(&source, &session.cancel)?;
        let export_safe = export_safe
            || preview_satisfies_export(&session.input, session.known_media.as_ref(), &probe);
        let proxy = force_proxy || !directly_playable(&source, &probe);
        let playable = if proxy {
            on_stage(PlaybackStage::Proxying, None);
            let out = temp.path().join(if probe.has_video() {
                "preview.mp4"
            } else {
                "preview.m4a"
            });
            let plan = profiles::playback_plan(&source, &probe, &out);
            crate::media::ffmpeg::execute(&plan, probe.duration, &session.cancel, &mut |_| {})?;
            out
        } else {
            source.clone()
        };
        if session.cancel.is_cancelled() {
            return Err(ShiftError::cancelled());
        }
        let asset = Arc::new(Asset {
            source,
            playable,
            probe,
            title,
            proxy,
            export_safe,
            _temp: temp,
        });
        *slot = Some(asset.clone());
        on_stage(PlaybackStage::BackendReady, None);
        Ok(asset)
    }
}

fn preview_satisfies_export(
    input: &InputSpec,
    media: Option<&PostMedia>,
    probe: &MediaProbe,
) -> bool {
    let (quality, media) = match (input, media) {
        (InputSpec::Url { .. }, Some(media)) if !media.has_video() => return probe.audio.is_some(),
        (InputSpec::Url { quality, .. }, Some(media)) => (quality.as_deref(), media),
        _ => return false,
    };
    let downloaded = probe.video.as_ref().and_then(|v| v.height).unwrap_or(0);
    let needed = match quality.and_then(|q| q.parse::<u32>().ok()) {
        Some(height) => media
            .height
            .map_or(height, |available| height.min(available)),
        None => media.height.unwrap_or(u32::MAX),
    };
    downloaded >= needed
}
/// Conservative direct-play shortlist; decode errors get one proxy fallback.
fn directly_playable(path: &std::path::Path, p: &MediaProbe) -> bool {
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let audio = p.audio.as_ref().map(|a| a.codec.as_str());
    if p.has_video() {
        matches!(ext.as_str(), "mp4" | "m4v" | "mov")
            && p.video.as_ref().is_some_and(|v| v.codec == "h264")
            && (audio.is_none() || audio == Some("aac"))
    } else {
        matches!(
            (ext.as_str(), audio),
            ("mp3", Some("mp3")) | ("m4a", Some("aac")) | ("wav", Some("pcm_s16le"))
        )
    }
}
