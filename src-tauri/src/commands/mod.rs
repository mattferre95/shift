//! The complete IPC surface.
//!
//! Nine narrow commands. None of them accept a flag, an argument array, or a
//! shell string — the frontend can only describe *what* it wants (PRD §9).

use crate::errors::{Result, ShiftError};
use crate::filesystem;
use crate::jobs::{self, ExportRequest, JobRegistry};
use crate::media::{ffprobe::probe, profiles};
use crate::process::CancelToken;
use crate::providers::{self, UrlMedia};
use crate::settings::SettingsStore;
use crate::validation;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// Local file extensions accepted in V1 (LOC-01).
const VIDEO_EXTS: [&str; 3] = ["mp4", "mov", "webm"];
const AUDIO_EXTS: [&str; 4] = ["mp3", "wav", "m4a", "aac"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMedia {
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
        provider.analyze(&parsed, &cache, &cancel)
    })
    .await
    .map_err(|e| ShiftError::new("internal", "SHIFT couldn't complete that.").technical(e.to_string()))?
}

#[tauri::command]
pub async fn analyze_file(path: String) -> Result<LocalMedia> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = validation::validate_input_path(&path)?;
        let ext = resolved
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if !VIDEO_EXTS.contains(&ext.as_str()) && !AUDIO_EXTS.contains(&ext.as_str()) {
            return Err(ShiftError::unsupported_file());
        }

        let cancel = CancelToken::new();
        let info = probe(&resolved, &cancel)?;

        Ok(LocalMedia {
            path: resolved.to_string_lossy().to_string(),
            name: resolved.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            ext: ext.to_uppercase(),
            size_bytes: info.size_bytes,
            duration: info.duration,
            width: info.video.as_ref().and_then(|v| v.width),
            height: info.video.as_ref().and_then(|v| v.height),
            has_video: info.has_video(),
            outputs: profiles::options_for(&info).iter().map(|f| f.label().to_string()).collect(),
        })
    })
    .await
    .map_err(|e| ShiftError::new("internal", "SHIFT couldn't read that file.").technical(e.to_string()))?
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
}
