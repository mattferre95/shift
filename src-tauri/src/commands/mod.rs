//! The complete IPC surface.
//!
//! A dozen narrow commands. None of them accept a flag, an argument array, or a
//! shell string — the frontend can only describe *what* it wants (PRD §9).

use crate::errors::{Result, ShiftError};
use crate::filesystem;
use crate::jobs::{self, ExportRequest, JobRegistry};
use crate::media::aspect::{self, AspectSpec, ContentBox, FrameMode};
use crate::media::image;
use crate::media::preview;
use crate::media::profiles::LoopSize;
use crate::media::{ffprobe::probe, profiles};
use crate::process::CancelToken;
use crate::providers::{self, UrlMedia};
use crate::settings::SettingsStore;
use crate::validation;
use serde::Serialize;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

/// Local file extensions accepted (LOC-01).
///
/// Wider than the output list on purpose: ffprobe and FFmpeg already demux all
/// of these, and what a file can be *turned into* is decided by its streams in
/// `profiles::options_for`, never by its extension. Refusing to read a MKV that
/// FFmpeg handles perfectly would be an artificial limit.
const VIDEO_EXTS: [&str; 6] = ["mp4", "mov", "webm", "mkv", "m4v", "avi"];
const AUDIO_EXTS: [&str; 9] = [
    "mp3", "wav", "m4a", "aac", "flac", "aiff", "aif", "ogg", "opus",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMedia {
    /// "video" | "audio" | "image". Decides which interface the UI shows.
    pub kind: &'static str,
    pub path: String,
    pub name: String,
    /// Uppercase source extension, shown in the file badge.
    pub ext: String,
    pub size_bytes: u64,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub has_video: bool,
    /// Output chips this file can actually produce.
    pub outputs: Vec<String>,
    /// Images only: whether the source carries transparency. The UI uses it to
    /// explain why AVIF is not on offer.
    pub has_alpha: bool,
}

#[tauri::command]
pub async fn analyze_url(url: String) -> Result<UrlMedia> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = validation::validate_url(&url)?;
        let provider = providers::for_url(&parsed)
            .ok_or_else(|| ShiftError::new("no_provider", "SHIFT can't handle this link."))?;
        let cache = std::env::temp_dir()
            .join("SHIFT")
            .join("thumbs")
            .join(uuid::Uuid::new_v4().to_string());
        let cancel = CancelToken::new();
        let result = provider.analyze(&parsed, &cache, &cancel);
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&cache);
        }
        result
    })
    .await
    .map_err(|e| {
        ShiftError::new("internal", "SHIFT couldn't complete that.").technical(e.to_string())
    })?
}

#[tauri::command]
pub async fn analyze_file(path: String) -> Result<LocalMedia> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = validation::validate_input_path(&path)?;
        let ext = resolved
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let cancel = CancelToken::new();

        // Images take the sips path; audio and video keep the ffprobe one.
        if image::is_image_ext(&ext) {
            let info = image::probe(&resolved, &cancel)?;
            return Ok(LocalMedia {
                kind: "image",
                path: resolved.to_string_lossy().to_string(),
                name: resolved
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                ext: ext.to_uppercase(),
                size_bytes: info.size_bytes,
                duration: None,
                width: Some(info.width),
                height: Some(info.height),
                has_video: false,
                outputs: profiles::image_options(info.has_alpha)
                    .iter()
                    .map(|f| f.label().to_string())
                    .collect(),
                has_alpha: info.has_alpha,
            });
        }

        if !VIDEO_EXTS.contains(&ext.as_str()) && !AUDIO_EXTS.contains(&ext.as_str()) {
            return Err(ShiftError::unsupported_file());
        }

        let info = probe(&resolved, &cancel)?;

        Ok(LocalMedia {
            kind: if info.has_video() { "video" } else { "audio" },
            path: resolved.to_string_lossy().to_string(),
            name: resolved
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            ext: ext.to_uppercase(),
            size_bytes: info.size_bytes,
            duration: info.duration,
            width: info.video.as_ref().and_then(|v| v.width),
            height: info.video.as_ref().and_then(|v| v.height),
            has_video: info.has_video(),
            outputs: profiles::options_for(&info)
                .iter()
                .map(|f| f.label().to_string())
                .collect(),
            has_alpha: false,
        })
    })
    .await
    .map_err(|e| {
        ShiftError::new("internal", "SHIFT couldn't read that file.").technical(e.to_string())
    })?
}

/// What an aspect choice would actually produce.
///
/// The UI shows this beside the ratio chips. It is answered here rather than
/// recomputed in the frontend so the numbers on screen are the same ones the
/// export will use — there is one implementation of this arithmetic, and it is
/// `media::aspect`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AspectPreview {
    pub width: u32,
    pub height: u32,
    /// True when the request enlarges the source, which only Freeform can do.
    pub upscales: bool,
    /// Where the picture sits inside the frame. The UI lays out its preview
    /// from exactly these numbers, which are the ones the encoder is given.
    pub content: ContentBox,
    pub mode: FrameMode,
}

/// `None` when there is nothing to show: Original, an unknown source size (a
/// URL before it is fetched), or a request that is not valid yet.
/// `loop_size` is passed when the output is a GIF or animated WEBP, because the
/// preset then caps the result — a 9:16 crop of a 1280x720 clip is 404x720 as a
/// video and 268x480 as a Standard loop, and the label has to show the number
/// the file will actually have.
#[tauri::command]
pub fn aspect_preview(
    source_width: u32,
    source_height: u32,
    spec: AspectSpec,
    loop_size: Option<LoopSize>,
) -> Option<AspectPreview> {
    if spec.is_original() || source_width == 0 || source_height == 0 {
        return None;
    }
    let source = (source_width, source_height);
    let reframe = match aspect::resolve(source, &spec) {
        Ok(Some(r)) => r,
        // A ratio the source already has: nothing changes, but the loop preset
        // may still resize it.
        Ok(None) => aspect::identity(source),
        // Half-typed dimensions are not an error worth shouting about; the
        // label simply waits until there is something to say.
        Err(_) => return None,
    };
    let framed = match loop_size {
        Some(size) => reframe.capped(size.longest_edge()),
        None => reframe,
    };
    let (width, height) = framed.final_size();
    Some(AspectPreview {
        width,
        height,
        upscales: reframe.upscales,
        content: framed.content_box(),
        mode: framed.mode,
    })
}

/// A small, disposable image the UI can draw a framing preview with.
///
/// Returns a path the webview can load. The file is cached per source and per
/// whole second of `at`, so cycling through ratios never re-extracts anything —
/// only a new source, or a moved IN point, costs work. It is deliberately low
/// resolution and is never an input to an export.
#[tauri::command]
pub async fn preview_source(app: AppHandle, path: String, at: Option<f64>) -> Result<String> {
    // The app cache directory, not the system temp root: see `preview::cache_dir`
    // for why the asset protocol cannot serve the latter on macOS.
    let root = app.path().app_cache_dir().map_err(|e| {
        ShiftError::new("preview_cache", "SHIFT couldn't prepare a preview.")
            .technical(e.to_string())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = validation::validate_input_path(&path)?;
        let cancel = CancelToken::new();
        let out = preview::derive(&resolved, at, &root, &cancel)?;
        // Inlined rather than served: see `preview::base64`.
        preview::data_uri(&out)
    })
    .await
    .map_err(|e| {
        ShiftError::new("internal", "SHIFT couldn't build a preview.").technical(e.to_string())
    })?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipCheck {
    pub seconds: f64,
    /// Canonical `MM:SS.mmm` length, shown next to the range.
    pub label: String,
}

/// Validate an IN/OUT pair as the user types, without starting anything.
#[tauri::command]
pub fn validate_clip(start: String, end: String, duration: Option<f64>) -> Result<ClipCheck> {
    let range = validation::validate_clip(&start, &end, duration)?;
    Ok(ClipCheck {
        seconds: range.duration(),
        label: validation::format_timestamp(range.duration()),
    })
}

#[tauri::command]
pub fn start_export(app: AppHandle, request: ExportRequest) -> Result<String> {
    Ok(jobs::spawn(app, request))
}

/// What the Save panel should be prefilled with.
///
/// The naming rules live in the jobs layer and are not duplicated in the
/// frontend; `source_title` is the title or filename the UI already has from
/// analysis, so no source is re-fetched to answer this.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePrompt {
    pub filename: String,
    /// Folder the panel should open in: last used, else Downloads.
    pub directory: String,
}

#[tauri::command]
pub fn save_prompt(
    settings: State<'_, SettingsStore>,
    request: ExportRequest,
    source_title: String,
) -> SavePrompt {
    SavePrompt {
        filename: jobs::suggested_filename(&request, &source_title),
        directory: settings.default_output_dir().to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub fn cancel_job(registry: State<'_, JobRegistry>, job_id: String) -> bool {
    registry.cancel(&job_id)
}

#[tauri::command]
pub fn default_output_dir(settings: State<'_, SettingsStore>) -> String {
    settings.default_output_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn set_output_dir(settings: State<'_, SettingsStore>, dir: String) -> Result<String> {
    let validated = validation::validate_output_dir(&dir)?;
    let s = validated.to_string_lossy().to_string();
    settings.set_output_dir(&s);
    Ok(s)
}

/// EXP-04. Delegated to the opener plugin so SHIFT never spawns `open(1)` itself.
#[tauri::command]
pub fn reveal_in_finder(app: AppHandle, path: String) -> Result<()> {
    let resolved = validation::validate_input_path(&path)?;
    tauri_plugin_opener::reveal_item_in_dir(&resolved).map_err(|e| {
        ShiftError::new("reveal_failed", "SHIFT couldn't open Finder.").technical(e.to_string())
    })?;
    let _ = app;
    Ok(())
}

/// Startup housekeeping, exposed so the UI can trigger it once on mount.
#[tauri::command]
pub fn prune_temp() {
    filesystem::prune_stale_temp_dirs();
}

/// Reported in the empty state so a broken install is visible immediately.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ffmpeg: bool,
    pub ffprobe: bool,
    pub ytdlp: bool,
}

#[tauri::command]
pub fn health(app: AppHandle) -> Health {
    let _ = app;
    use crate::process::{resolve, Binary};
    Health {
        ffmpeg: resolve(Binary::Ffmpeg).is_ok(),
        ffprobe: resolve(Binary::Ffprobe).is_ok(),
        ytdlp: resolve(Binary::YtDlp).is_ok(),
    }
}

/// Cancel everything still running when the window goes away.
pub fn shutdown(app: &AppHandle) {
    app.state::<JobRegistry>().cancel_all();
    app.state::<crate::media::playback::PlaybackRegistry>()
        .clear();
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("SHIFT").join("thumbs"));
}

#[tauri::command]
pub fn create_playback(
    app: AppHandle,
    input: jobs::InputSpec,
    known_media: Option<UrlMedia>,
) -> String {
    app.state::<crate::media::playback::PlaybackRegistry>()
        .create_known(input, known_media)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackEvent {
    playback_id: String,
    stage: crate::media::playback::PlaybackStage,
    elapsed_ms: u64,
    detail: Option<String>,
}

#[tauri::command]
pub async fn prepare_playback(
    app: AppHandle,
    id: String,
    force_proxy: bool,
) -> Result<crate::media::playback::PlaybackInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let event_app = app.clone();
        let event_id = id.clone();
        let mut on_stage = move |stage, detail| {
            let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            let _ = event_app.emit(
                "shift://playback",
                PlaybackEvent {
                    playback_id: event_id.clone(),
                    stage,
                    elapsed_ms,
                    detail,
                },
            );
        };
        let asset = app
            .state::<crate::media::playback::PlaybackRegistry>()
            .prepare_traced(&id, force_proxy, None, &mut on_stage)?;
        app.asset_protocol_scope()
            .allow_file(&asset.playable)
            .map_err(|e| {
                ShiftError::new("preview_scope", "SHIFT couldn't open the preview.")
                    .technical(e.to_string())
            })?;
        Ok(asset.info())
    })
    .await
    .map_err(|e| {
        ShiftError::new("preview_failed", "SHIFT couldn't prepare playback.")
            .technical(e.to_string())
    })?
}
#[tauri::command]
pub fn release_playback(app: AppHandle, id: String) {
    app.state::<crate::media::playback::PlaybackRegistry>()
        .release(&id);
}

#[tauri::command]
pub fn release_url_media(thumbnail_path: Option<String>) {
    let Some(path) = thumbnail_path.map(std::path::PathBuf::from) else {
        return;
    };
    let root = std::env::temp_dir().join("SHIFT").join("thumbs");
    if path.starts_with(&root) {
        if let Some(parent) = path.parent().filter(|parent| parent.starts_with(&root)) {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}
