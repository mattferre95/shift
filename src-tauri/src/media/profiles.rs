//! Output profiles — the single place that decides what FFmpeg is told to do.
//!
//! Nothing else in SHIFT builds codec arguments. Adding a future action means
//! extending this module, not scattering flags through the codebase.

use crate::errors::{Result, ShiftError};
use crate::media::ffprobe::MediaProbe;
use crate::validation::ClipRange;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OutputFormat {
    Mp4,
    Mov,
    Webm,
    Mp3,
    Wav,
    M4a,
    Aac,
}

impl OutputFormat {
    pub fn ext(self) -> &'static str {
        match self {
            OutputFormat::Mp4 => "mp4",
            OutputFormat::Mov => "mov",
            OutputFormat::Webm => "webm",
            OutputFormat::Mp3 => "mp3",
            OutputFormat::Wav => "wav",
            OutputFormat::M4a => "m4a",
            OutputFormat::Aac => "aac",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            OutputFormat::Mp4 => "MP4",
            OutputFormat::Mov => "MOV",
            OutputFormat::Webm => "WEBM",
            OutputFormat::Mp3 => "MP3",
            OutputFormat::Wav => "WAV",
            OutputFormat::M4a => "M4A",
            OutputFormat::Aac => "AAC",
        }
    }

    pub fn is_audio_only(self) -> bool {
        matches!(self, OutputFormat::Mp3 | OutputFormat::Wav | OutputFormat::M4a | OutputFormat::Aac)
    }
}

/// Which output chips make sense for a probed local file (LOC-03/04/05).
pub fn options_for(probe: &MediaProbe) -> Vec<OutputFormat> {
    if probe.has_video() {
        vec![
            OutputFormat::Mp4,
            OutputFormat::Mov,
            OutputFormat::Webm,
            OutputFormat::Mp3,
            OutputFormat::Wav,
        ]
    } else {
        vec![OutputFormat::Mp3, OutputFormat::Wav, OutputFormat::M4a, OutputFormat::Aac]
    }
}

// -------------------------------------------------------- container fitness

/// Can this video codec live in the target container untouched?
fn video_codec_fits(container: OutputFormat, codec: &str) -> bool {
    let c = codec.to_ascii_lowercase();
    match container {
        OutputFormat::Mp4 => matches!(c.as_str(), "h264" | "hevc" | "mpeg4" | "av1"),
        OutputFormat::Mov => matches!(c.as_str(), "h264" | "hevc" | "mpeg4" | "prores" | "dnxhd"),
        OutputFormat::Webm => matches!(c.as_str(), "vp8" | "vp9" | "av1"),
        _ => false,
    }
}

/// Can this audio codec live in the target container untouched?
fn audio_codec_fits(container: OutputFormat, codec: &str) -> bool {
    let c = codec.to_ascii_lowercase();
    match container {
        OutputFormat::Mp4 | OutputFormat::M4a => matches!(c.as_str(), "aac" | "mp3" | "alac"),
        OutputFormat::Mov => matches!(c.as_str(), "aac" | "alac" | "pcm_s16le" | "pcm_s24le" | "mp3"),
        OutputFormat::Webm => matches!(c.as_str(), "opus" | "vorbis"),
        OutputFormat::Mp3 => c == "mp3",
        OutputFormat::Aac => c == "aac",
        OutputFormat::Wav => c.starts_with("pcm_"),
    }
}

// --------------------------------------------------------------- the plan

#[derive(Debug, Clone)]
pub struct EncodePlan {
    pub args: Vec<String>,
    /// True when every stream is copied — no quality loss, near-instant.
    pub remuxed: bool,
}

/// Build the complete FFmpeg argument array for one transformation.
///
/// Trimming always re-encodes video: a stream copy can only cut on keyframes,
/// which would silently give the user a different range than they typed. Correct
/// output beats a faster inaccurate one (PRD §12, "Precise cuts").
pub fn build_plan(
    input: &Path,
    probe: &MediaProbe,
    format: OutputFormat,
    clip: Option<ClipRange>,
    output: &Path,
) -> Result<EncodePlan> {
    if format.is_audio_only() && probe.audio.is_none() {
        return Err(ShiftError::new("no_audio", "This file has no audio to extract.")
            .hint("Choose a video output format instead."));
    }
    if !format.is_audio_only() && !probe.has_video() {
        return Err(ShiftError::new("no_video", "This is an audio file.")
            .hint("Choose MP3, WAV, M4A or AAC."));
    }

    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];

    // Input-side seek. Since FFmpeg 2.1 this is frame-accurate when re-encoding
    // and still fast, because the decoder skips ahead before decoding.
    if let Some(range) = clip {
        args.push("-ss".into());
        args.push(format!("{:.3}", range.start));
    }
    args.push("-i".into());
    args.push(input.to_string_lossy().to_string());
    if let Some(range) = clip {
        args.push("-t".into());
        args.push(format!("{:.3}", range.duration()));
    }

    let trimming = clip.is_some();
    let mut remuxed = false;

    if format.is_audio_only() {
        args.push("-vn".into());
        let src = probe.audio.as_ref().map(|a| a.codec.as_str()).unwrap_or("");
        // A straight container change (M4A/AAC from an AAC source) can copy.
        if !trimming && audio_codec_fits(format, src) && matches!(format, OutputFormat::M4a | OutputFormat::Aac | OutputFormat::Mp3) {
            args.push("-c:a".into());
            args.push("copy".into());
            remuxed = true;
        } else {
            args.extend(audio_encoder(format));
        }
    } else {
        let v_src = probe.video.as_ref().map(|v| v.codec.as_str()).unwrap_or("");
        let a_src = probe.audio.as_ref().map(|a| a.codec.as_str()).unwrap_or("");
        let can_copy_video = !trimming && video_codec_fits(format, v_src);
        let can_copy_audio = probe.audio.is_none() || (!trimming && audio_codec_fits(format, a_src));

        if can_copy_video && can_copy_audio {
            args.push("-c".into());
            args.push("copy".into());
            remuxed = true;
        } else {
            args.extend(video_encoder(format));
            if probe.audio.is_some() {
                if can_copy_audio {
                    args.push("-c:a".into());
                    args.push("copy".into());
                } else {
                    args.extend(container_audio_encoder(format));
                }
            } else {
                args.push("-an".into());
            }
        }
        // MP4/MOV need the index up front so the file plays while still on disk.
        if matches!(format, OutputFormat::Mp4 | OutputFormat::Mov) {
            args.push("-movflags".into());
            args.push("+faststart".into());
        }
    }

    args.push("-map_metadata".into());
    args.push("0".into());
    // Machine-readable progress on stdout; the human log stays on stderr.
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().to_string());

    Ok(EncodePlan { args, remuxed })
}

fn audio_encoder(format: OutputFormat) -> Vec<String> {
    match format {
        OutputFormat::Mp3 => vec!["-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into()],
        OutputFormat::Wav => vec!["-c:a".into(), "pcm_s16le".into()],
        OutputFormat::M4a | OutputFormat::Aac => {
            vec!["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]
        }
        _ => vec![],
    }
}

fn container_audio_encoder(format: OutputFormat) -> Vec<String> {
    match format {
        OutputFormat::Webm => vec!["-c:a".into(), "libopus".into(), "-b:a".into(), "128k".into()],
        _ => vec!["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()],
    }
}

fn video_encoder(format: OutputFormat) -> Vec<String> {
    match format {
        OutputFormat::Webm => vec![
            "-c:v".into(),
            "libvpx-vp9".into(),
            "-crf".into(),
            "32".into(),
            "-b:v".into(),
            "0".into(),
            "-row-mt".into(),
            "1".into(),
            "-cpu-used".into(),
            "3".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
        _ => vec![
            "-c:v".into(),
            "libx264".into(),
            "-crf".into(),
            "20".into(),
            "-preset".into(),
            "medium".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::ffprobe::StreamInfo;

    fn h264_mov() -> MediaProbe {
        MediaProbe {
            duration: Some(43.0),
            container: "mov".into(),
            size_bytes: 1000,
            video: Some(StreamInfo { codec: "h264".into(), width: Some(1920), height: Some(1080) }),
            audio: Some(StreamInfo { codec: "aac".into(), width: None, height: None }),
        }
    }

    #[test]
    fn h264_mov_to_mp4_is_a_remux() {
        let plan =
            build_plan(Path::new("/in.mov"), &h264_mov(), OutputFormat::Mp4, None, Path::new("/out.mp4"))
                .unwrap();
        assert!(plan.remuxed);
        assert!(plan.args.windows(2).any(|w| w == ["-c", "copy"]));
    }

    #[test]
    fn h264_to_webm_must_transcode() {
        let plan =
            build_plan(Path::new("/in.mov"), &h264_mov(), OutputFormat::Webm, None, Path::new("/out.webm"))
                .unwrap();
        assert!(!plan.remuxed);
        assert!(plan.args.iter().any(|a| a == "libvpx-vp9"));
    }

    #[test]
    fn trimming_forces_a_re_encode_for_accuracy() {
        let clip = ClipRange { start: 172.0, end: 176.0 };
        let plan = build_plan(
            Path::new("/in.mov"),
            &h264_mov(),
            OutputFormat::Mp4,
            Some(clip),
            Path::new("/out.mp4"),
        )
        .unwrap();
        assert!(!plan.remuxed);
        assert!(plan.args.windows(2).any(|w| w == ["-ss", "172.000"]));
        assert!(plan.args.windows(2).any(|w| w == ["-t", "4.000"]));
    }

    #[test]
    fn audio_only_output_drops_the_video_stream() {
        let plan =
            build_plan(Path::new("/in.mov"), &h264_mov(), OutputFormat::Wav, None, Path::new("/out.wav"))
                .unwrap();
        assert!(plan.args.iter().any(|a| a == "-vn"));
        assert!(plan.args.iter().any(|a| a == "pcm_s16le"));
    }

    #[test]
    fn audio_source_refuses_a_video_container() {
        let audio = MediaProbe {
            duration: Some(10.0),
            container: "mp3".into(),
            size_bytes: 10,
            video: None,
            audio: Some(StreamInfo { codec: "mp3".into(), width: None, height: None }),
        };
        assert!(build_plan(Path::new("/a.mp3"), &audio, OutputFormat::Mp4, None, Path::new("/o.mp4")).is_err());
    }
}
