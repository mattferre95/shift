//! ffprobe inspection (LOC-02).
//!
//! Runs once per local input and produces the only media facts the rest of the
//! app is allowed to reason about. The UI receives a user-relevant subset.

use crate::errors::{Result, ShiftError};
use crate::process::{run_capture, Binary, CancelToken};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub codec: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// The probed truth about a local file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub duration: Option<f64>,
    pub container: String,
    pub size_bytes: u64,
    pub video: Option<StreamInfo>,
    pub audio: Option<StreamInfo>,
}

impl MediaProbe {
    pub fn has_video(&self) -> bool {
        self.video.is_some()
    }
}

#[derive(Deserialize)]
struct RawProbe {
    streams: Option<Vec<RawStream>>,
    format: Option<RawFormat>,
}

#[derive(Deserialize)]
struct RawStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    disposition: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawFormat {
    duration: Option<String>,
    format_name: Option<String>,
    size: Option<String>,
}

pub fn probe(path: &Path, cancel: &CancelToken) -> Result<MediaProbe> {
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string_lossy().to_string(),
    ];
    let out = run_capture(Binary::Ffprobe, &args, cancel)?;
    if !out.success {
        return Err(ShiftError::probe_failed(out.log()));
    }
    let raw: RawProbe = serde_json::from_str(&out.stdout)
        .map_err(|e| ShiftError::probe_failed(format!("could not parse ffprobe output: {e}")))?;

    let format = raw.format.unwrap_or(RawFormat { duration: None, format_name: None, size: None });
    let duration = format.duration.and_then(|d| d.parse::<f64>().ok()).filter(|d| *d > 0.0);
    let size_bytes = format
        .size
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| std::fs::metadata(path).ok().map(|m| m.len()))
        .unwrap_or(0);

    let container = format
        .format_name
        .unwrap_or_default()
        .split(',')
        .next()
        .unwrap_or("")
        .to_string();

    let mut video = None;
    let mut audio = None;
    for s in raw.streams.unwrap_or_default() {
        let kind = s.codec_type.clone().unwrap_or_default();
        let codec = s.codec_name.clone().unwrap_or_else(|| "unknown".into());
        // Cover art inside audio files reports as a video stream; ignore it.
        let is_cover = s
            .disposition
            .as_ref()
            .and_then(|d| d.get("attached_pic"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            == 1;
        match kind.as_str() {
            "video" if !is_cover && video.is_none() => {
                video = Some(StreamInfo { codec, width: s.width, height: s.height })
            }
            "audio" if audio.is_none() => {
                audio = Some(StreamInfo { codec, width: None, height: None })
            }
            _ => {}
        }
    }

    if video.is_none() && audio.is_none() {
        return Err(ShiftError::unsupported_file());
    }

    Ok(MediaProbe { duration, container, size_bytes, video, audio })
}
