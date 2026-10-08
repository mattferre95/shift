//! The job model.
//!
//! Every export is a job with an id, an explicit state, a private temp
//! directory, and exactly one cancellation token that owns its child processes.
//! Actions are data (`ActionSpec`), so a future Crop or Normalize slots into the
//! same pipeline without a new screen flow (PRD §7).

use crate::errors::{Result, ShiftError};
use crate::filesystem::{self, TempDir};
use crate::media::aspect::{AspectRatio, AspectSpec, FrameMode};
use crate::media::image::{self, Compression};
use crate::media::{
    ffmpeg, ffprobe,
    profiles::{self, LoopSize, OutputFormat},
};
use crate::process::{Binary, CancelToken};
use crate::providers::{self, DownloadKind};
use crate::settings::SettingsStore;
use crate::validation::{self, ClipRange};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub const JOB_EVENT: &str = "shift://job";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Analyzing,
    Downloading,
    Processing,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
}

/// One unit of work inside a pipeline. V1 emits Analyze/Download/Trim/Convert/
/// ExtractAudio; later actions extend this enum, not the job runner's shape.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum ActionSpec {
    Analyze,
    Download {
        kind: &'static str,
        quality: String,
    },
    Trim {
        start: f64,
        end: f64,
    },
    Convert {
        format: OutputFormat,
    },
    ExtractAudio {
        format: OutputFormat,
    },
    ConvertImage {
        format: OutputFormat,
    },
    CompressImage {
        level: Compression,
    },
    MakeLoop {
        format: OutputFormat,
        size: LoopSize,
    },
    Reframe {
        ratio: AspectRatio,
        frame: FrameMode,
    },
}

// ------------------------------------------------------------------- request

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum InputSpec {
    Url {
        url: String,
        quality: Option<String>,
    },
    Local {
        path: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSpec {
    pub start: String,
    pub end: String,
}

/// The only shape the frontend can submit. No flags, no argument arrays.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub input: InputSpec,
    pub format: OutputFormat,
    pub clip: Option<ClipSpec>,
    /// Metadata from the analyzed source, shared by Save As and the job.
    #[serde(default)]
    pub source_title: Option<String>,
    #[serde(default)]
    pub source_hint: Option<String>,
    #[serde(default)]
    pub source_duration: Option<f64>,
    pub output_dir: Option<String>,
    /// Images only. Ignored by the audio/video pipeline.
    #[serde(default)]
    pub compression: Option<Compression>,
    /// GIF and animated WEBP only. Ignored by every other output.
    #[serde(default)]
    pub loop_size: Option<LoopSize>,
    /// Visual outputs only. Ignored by audio, which has no shape.
    #[serde(default)]
    pub aspect: Option<AspectSpec>,
    /// Video outputs only. False removes the audio stream rather than encoding
    /// silence. Audio exports deliberately ignore this preference.
    #[serde(default = "default_true")]
    pub sound_enabled: bool,
    /// Full path chosen in the native Save panel. When present the user has
    /// already named the file and confirmed any overwrite, so SHIFT writes
    /// exactly there instead of inventing a collision-safe name.
    #[serde(default)]
    pub destination_path: Option<String>,
}

fn default_true() -> bool {
    true
}

// --------------------------------------------------------------------- event

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutput {
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    /// True when every stream was copied rather than re-encoded.
    pub remuxed: bool,
    /// Size of the input, when it was a local file, so the UI can show the
    /// before/after of a compression.
    pub source_bytes: Option<u64>,
    /// Where it landed, home-abbreviated, for the completion screen.
    pub directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub job_id: String,
    pub state: JobState,
    pub stage_label: String,
    pub stage_index: usize,
    pub stage_count: usize,
    /// 0.0–1.0 within the current stage, or `None` when it can't be trusted.
    pub progress: Option<f64>,
    pub output_filename: String,
    pub output: Option<JobOutput>,
    pub error: Option<crate::errors::ShiftError>,
    /// The pipeline this job is running, as data.
    pub actions: Vec<ActionSpec>,
}

// ------------------------------------------------------------------ registry

#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, Arc<CancelToken>>>,
}

impl JobRegistry {
    pub fn register(&self, id: &str) -> Arc<CancelToken> {
        let token = CancelToken::new();
        self.jobs
            .lock()
            .unwrap()
            .insert(id.to_string(), Arc::clone(&token));
        token
    }

    pub fn cancel(&self, id: &str) -> bool {
        let token = self.jobs.lock().unwrap().get(id).cloned();
        match token {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    pub fn finish(&self, id: &str) {
        self.jobs.lock().unwrap().remove(id);
    }

    /// Used at shutdown so nothing outlives the window.
    pub fn cancel_all(&self) {
        for token in self.jobs.lock().unwrap().values() {
            token.cancel();
        }
    }
}

// -------------------------------------------------------------------- runner

/// Live reporting state for one job, so every emit carries full context.
struct Reporter {
    app: AppHandle,
    job_id: String,
    stages: Vec<String>,
    actions: Vec<ActionSpec>,
    index: usize,
    filename: String,
}

impl Reporter {
    fn emit(&self, state: JobState, progress: Option<f64>) {
        let event = JobEvent {
            job_id: self.job_id.clone(),
            state,
            stage_label: self.stages.get(self.index).cloned().unwrap_or_default(),
            stage_index: self.index,
            stage_count: self.stages.len(),
            progress,
            output_filename: self.filename.clone(),
            output: None,
            error: None,
            actions: self.actions.clone(),
        };
        let _ = self.app.emit(JOB_EVENT, event);
    }

    fn advance(&mut self, state: JobState) {
        self.emit(state, None);
    }

    fn finish(&self, output: JobOutput) {
        let event = JobEvent {
            job_id: self.job_id.clone(),
            state: JobState::Completed,
            stage_label: "Done.".into(),
            stage_index: self.stages.len().saturating_sub(1),
            stage_count: self.stages.len(),
            progress: Some(1.0),
            output_filename: output.filename.clone(),
            output: Some(output),
            error: None,
            actions: self.actions.clone(),
        };
        let _ = self.app.emit(JOB_EVENT, event);
    }

    fn fail(&self, error: ShiftError) {
        let cancelled = error.code == "cancelled";
        let event = JobEvent {
            job_id: self.job_id.clone(),
            state: if cancelled {
                JobState::Cancelled
            } else {
                JobState::Failed
            },
            stage_label: self.stages.get(self.index).cloned().unwrap_or_default(),
            stage_index: self.index,
            stage_count: self.stages.len(),
            progress: None,
            output_filename: self.filename.clone(),
            output: None,
            error: if cancelled { None } else { Some(error) },
            actions: self.actions.clone(),
        };
        let _ = self.app.emit(JOB_EVENT, event);
    }
}

/// Build the pipeline description up front — it decides the stage labels the
/// user sees and the actions recorded on the job.
fn plan_actions(
    request: &ExportRequest,
    clip: Option<ClipRange>,
) -> (Vec<ActionSpec>, Vec<String>) {
    let mut actions = vec![ActionSpec::Analyze];
    let mut stages: Vec<String> = Vec::new();

    match &request.input {
        InputSpec::Url { quality, .. } => {
            stages.push("Fetching media…".into());
            let kind = if request.format.is_audio_only() {
                "audio"
            } else {
                "video"
            };
            actions.push(ActionSpec::Download {
                kind,
                quality: quality.clone().unwrap_or_else(|| "best".into()),
            });
            stages.push("Downloading…".into());
        }
        InputSpec::Local { .. } => {
            stages.push("Reading media…".into());
        }
    }

    let aspect = request.aspect.unwrap_or_default();
    if !aspect.is_original() && !request.format.is_audio_only() {
        actions.push(ActionSpec::Reframe {
            ratio: aspect.ratio,
            frame: aspect.frame,
        });
    }

    if request.format.is_animation() {
        // A loop is one pass whether or not it is also trimmed, so the trim
        // does not get a stage of its own the way it does elsewhere.
        if let Some(range) = clip {
            actions.push(ActionSpec::Trim {
                start: range.start,
                end: range.end,
            });
        }
        actions.push(ActionSpec::MakeLoop {
            format: request.format,
            size: request.loop_size.unwrap_or_default(),
        });
        stages.push("Building loop…".into());
    } else if let Some(range) = clip {
        actions.push(ActionSpec::Trim {
            start: range.start,
            end: range.end,
        });
        stages.push("Clipping…".into());
    } else if request.format.is_audio_only() {
        actions.push(ActionSpec::ExtractAudio {
            format: request.format,
        });
        stages.push("Converting…".into());
    } else {
        actions.push(ActionSpec::Convert {
            format: request.format,
        });
        stages.push("Converting…".into());
    }

    stages.push("Finalizing…".into());
    (actions, stages)
}

/// Name the result the way the user would (EXP-02): the source, then what was
/// done to it — `<source>_<aspect>_<duration>`, e.g. `carti_169_15s`. Only
/// shape and length are named; compression, sound, loop size and Fill/Fit are
/// not, and a default never is.
fn output_stem(
    request: &ExportRequest,
    source_title: &str,
    clip: Option<ClipRange>,
    duration: Option<f64>,
) -> String {
    let mut stem = match request.input {
        InputSpec::Url { .. } => filesystem::sanitize_title_stem(source_title),
        InputSpec::Local { .. } => filesystem::sanitize_stem(source_title),
    };
    // Audio has no shape, whatever aspect was chosen before switching to it.
    if !request.format.is_audio_only() {
        if let Some(tag) = request.aspect.as_ref().and_then(aspect_tag) {
            stem.push('_');
            stem.push_str(&tag);
        }
    }
    let timed = !matches!(
        request.format,
        OutputFormat::Jpg | OutputFormat::Png | OutputFormat::Avif
    );
    if let Some(seconds) = clip
        .map(|range| range.duration())
        .or(duration)
        .filter(|v| timed && v.is_finite() && *v > 0.0)
    {
        stem.push_str(&format!("_{}s", clip_seconds(seconds)));
    }
    stem
}

/// `16:9` → `169`, freeform → `1080x1350`; nothing for Original.
fn aspect_tag(aspect: &AspectSpec) -> Option<String> {
    if let Some((w, h)) = aspect.ratio.parts() {
        return Some(format!("{w}{h}"));
    }
    match (aspect.ratio, aspect.width, aspect.height) {
        (AspectRatio::Freeform, Some(w), Some(h)) => Some(format!("{w}x{h}")),
        _ => None,
    }
}

/// The clip's length in whole seconds for the name only; the trim itself keeps
/// its full precision. A non-empty clip is never named `0s`.
fn clip_seconds(duration: f64) -> u64 {
    (duration.round() as u64).max(1)
}

/// Select metadata before sanitizing: a real title, a meaningful hint, then
/// an identifier from the URL. A local source always keeps its filename stem.
fn source_name(request: &ExportRequest, analyzed_title: Option<&str>) -> String {
    match &request.input {
        InputSpec::Local { path } => PathBuf::from(path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "output".into()),
        InputSpec::Url { url, .. } => {
            let parsed = url::Url::parse(url).ok();
            let identifier = parsed.as_ref().and_then(|url| {
                url.query_pairs()
                    .find(|(key, _)| key == "v")
                    .map(|(_, value)| value.into_owned())
                    .or_else(|| {
                        url.path_segments()?
                            .filter(|part| !part.is_empty())
                            .next_back()
                            .map(str::to_owned)
                    })
            });
            let useful = |value: &str| {
                let trimmed = value.trim();
                !trimmed.is_empty()
                    && !trimmed.starts_with("http://")
                    && !trimmed.starts_with("https://")
                    && !trimmed.to_ascii_lowercase().ends_with(" post")
                    && !trimmed.to_ascii_lowercase().ends_with("-post")
                    && !trimmed.to_ascii_lowercase().contains("-post.")
                    && identifier.as_deref() != Some(trimmed)
                    && filesystem::sanitize_title_stem(trimmed) != "shift-output"
            };
            request
                .source_title
                .as_deref()
                .filter(|title| useful(title))
                .or_else(|| analyzed_title.filter(|title| useful(title)))
                .map(str::to_owned)
                .or_else(|| {
                    request.source_hint.as_deref().and_then(|hint| {
                        let stem = std::path::Path::new(hint).file_stem()?.to_str()?;
                        let generic = stem.to_ascii_lowercase();
                        (useful(stem)
                            && !generic.ends_with("-post")
                            && !generic.contains("-post-"))
                        .then(|| stem.to_owned())
                    })
                })
                .or(identifier)
                .unwrap_or_else(|| "media".into())
        }
    }
}

/// Resolve where the finished file goes.
///
/// A path from the Save panel wins outright: the user named it and macOS has
/// already asked about overwriting. Without one, fall back to the generated
/// collision-safe name so nothing is ever clobbered silently.
fn resolve_destination(
    request: &ExportRequest,
    output_dir: &std::path::Path,
    stem: &str,
) -> Result<PathBuf> {
    match request.destination_path.as_deref() {
        Some(chosen) => validation::normalize_destination(chosen, request.format.ext()),
        None => Ok(filesystem::unique_path(
            output_dir,
            stem,
            request.format.ext(),
        )),
    }
}

/// The filename SHIFT would choose, used to prefill the Save panel. Naming
/// rules stay here so the frontend never has to reimplement them.
pub fn suggested_filename(request: &ExportRequest) -> String {
    let clip = request
        .clip
        .as_ref()
        .and_then(|c| validation::validate_clip(&c.start, &c.end, None).ok());

    let title = source_name(request, None);
    let stem = output_stem(request, &title, clip, request.source_duration);
    format!("{stem}.{}", request.format.ext())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str, format: OutputFormat) -> ExportRequest {
        ExportRequest {
            input: InputSpec::Local { path: path.into() },
            format,
            clip: None,
            source_title: None,
            source_hint: None,
            source_duration: None,
            output_dir: None,
            compression: None,
            loop_size: None,
            aspect: None,
            sound_enabled: true,
            destination_path: None,
        }
    }

    #[test]
    fn a_local_suggestion_drops_the_source_extension() {
        // The UI passes the display name, which still has ".HEIC" on it.
        let r = request("/photos/IMG_7397.HEIC", OutputFormat::Jpg);
        assert_eq!(suggested_filename(&r), "IMG_7397.jpg");
    }

    #[test]
    fn compression_never_changes_the_name() {
        let mut r = request("/photos/IMG_7397.HEIC", OutputFormat::Jpg);
        r.compression = Some(Compression::Balanced);
        assert_eq!(suggested_filename(&r), "IMG_7397.jpg");
        r.aspect = ratio(AspectRatio::R4x5);
        assert_eq!(suggested_filename(&r), "IMG_7397_45.jpg");
    }

    fn clip(start: &str, end: &str) -> Option<ClipSpec> {
        Some(ClipSpec {
            start: start.into(),
            end: end.into(),
        })
    }

    fn ratio(ratio: AspectRatio) -> Option<AspectSpec> {
        Some(AspectSpec {
            ratio,
            ..AspectSpec::default()
        })
    }

    fn named(r: &ExportRequest) -> String {
        suggested_filename(r)
    }

    #[test]
    fn an_unmodified_export_is_named_after_its_source() {
        assert_eq!(named(&request("/v/carti.mov", OutputFormat::Mp4)), "carti.mp4");
        // Original is a default, not a modifier.
        let mut r = request("/v/carti.mov", OutputFormat::Mp4);
        r.aspect = ratio(AspectRatio::Original);
        assert_eq!(named(&r), "carti.mp4");
    }

    #[test]
    fn a_trim_is_named_by_the_clip_length_not_its_timestamps() {
        let mut r = request("/v/carti.mov", OutputFormat::Mp4);
        r.clip = clip("00:43.000", "00:58.000");
        assert_eq!(named(&r), "carti_15s.mp4");
        r.clip = clip("00:00.000", "01:00.000");
        assert_eq!(named(&r), "carti_60s.mp4");
    }

    #[test]
    fn an_aspect_is_named_compactly_before_the_duration() {
        let mut r = request("/v/carti.mov", OutputFormat::Mp4);
        r.aspect = ratio(AspectRatio::R16x9);
        assert_eq!(named(&r), "carti_169.mp4");
        r.clip = clip("00:10.000", "00:25.000");
        assert_eq!(named(&r), "carti_169_15s.mp4");
        r.aspect = ratio(AspectRatio::R9x16);
        r.clip = clip("00:00.000", "00:30.000");
        assert_eq!(named(&r), "carti_916_30s.mp4");
        r.aspect = ratio(AspectRatio::R4x5);
        r.clip = None;
        assert_eq!(named(&r), "carti_45.mp4");
        r.aspect = ratio(AspectRatio::R4x3);
        assert_eq!(named(&r), "carti_43.mp4");
    }

    #[test]
    fn a_loop_uses_the_same_names() {
        let mut r = request("/v/carti.mov", OutputFormat::Gif);
        r.aspect = ratio(AspectRatio::R1x1);
        r.clip = clip("00:05.000", "00:15.000");
        assert_eq!(named(&r), "carti_11_10s.gif");
    }

    #[test]
    fn a_freeform_size_is_named_by_its_pixels() {
        let mut r = request("/v/carti.mov", OutputFormat::Mp4);
        r.aspect = Some(AspectSpec {
            ratio: AspectRatio::Freeform,
            frame: FrameMode::Fit,
            width: Some(1080),
            height: Some(1350),
        });
        r.clip = clip("00:00.000", "00:15.000");
        assert_eq!(named(&r), "carti_1080x1350_15s.mp4");
    }

    #[test]
    fn audio_names_carry_the_trim_but_never_an_aspect() {
        let mut r = request("/v/carti.mov", OutputFormat::Mp3);
        r.aspect = ratio(AspectRatio::R16x9);
        r.clip = clip("00:43.000", "00:58.000");
        assert_eq!(named(&r), "carti_15s.mp3");
    }

    #[test]
    fn a_fractional_clip_is_rounded_for_the_name_only() {
        let mut r = request("/v/carti.mov", OutputFormat::Mp4);
        r.clip = clip("00:01.250", "00:15.900");
        assert_eq!(named(&r), "carti_15s.mp4");
        // The request itself keeps the exact boundaries.
        let spec = r.clip.as_ref().unwrap();
        let range = validation::validate_clip(&spec.start, &spec.end, None).unwrap();
        assert!((range.duration() - 14.65).abs() < 1e-9);
        // Shorter than half a second is still a clip, not `0s`.
        r.clip = clip("00:01.000", "00:01.200");
        assert_eq!(named(&r), "carti_1s.mp4");
    }

    #[test]
    fn the_stem_is_sanitized_as_before() {
        let r = request("/v/Carti Live!.mp4", OutputFormat::Mp4);
        assert_eq!(
            suggested_filename(&r),
            format!("{}.mp4", filesystem::sanitize_stem("Carti Live!"))
        );
    }

    #[test]
    fn a_url_title_takes_the_same_suffixes() {
        let r = ExportRequest {
            input: InputSpec::Url {
                url: "https://example.com/x?id=123".into(),
                quality: None,
            },
            format: OutputFormat::Mp3,
            clip: clip("02:52.000", "02:56.000"),
            source_title: Some("The Sopranos".into()),
            source_hint: None,
            source_duration: None,
            output_dir: None,
            compression: None,
            loop_size: None,
            aspect: None,
            sound_enabled: true,
            destination_path: None,
        };
        assert_eq!(suggested_filename(&r), "The_Sopranos_4s.mp3");
    }

    #[test]
    fn an_image_takes_the_aspect() {
        let mut r = request("/photos/photo.HEIC", OutputFormat::Jpg);
        r.aspect = ratio(AspectRatio::R4x5);
        assert_eq!(suggested_filename(&r), "photo_45.jpg");
    }

    #[test]
    fn url_title_wins_over_hint_and_identifier_for_full_and_trimmed_exports() {
        let mut r = request("/unused", OutputFormat::Mp4);
        r.input = InputSpec::Url {
            url: "https://www.youtube.com/watch?v=8m91-gu-x8U".into(),
            quality: None,
        };
        r.source_title = Some("Empty Room Ambient Noise Sound Effect".into());
        r.source_hint = Some("youtube-post.mp4".into());
        r.source_duration = Some(60.0);
        assert_eq!(named(&r), "Empty_Room_Ambient_Noise_Sound_Effect_60s.mp4");

        r.format = OutputFormat::Mp3;
        assert_eq!(named(&r), "Empty_Room_Ambient_Noise_Sound_Effect_60s.mp3");
        r.format = OutputFormat::Mp4;
        r.aspect = ratio(AspectRatio::R9x16);
        assert_eq!(named(&r), "Empty_Room_Ambient_Noise_Sound_Effect_916_60s.mp4");
        r.source_duration = Some(300.0);
        r.clip = clip("01:00.000", "01:15.000");
        assert_eq!(named(&r), "Empty_Room_Ambient_Noise_Sound_Effect_916_15s.mp4");
    }

    #[test]
    fn full_local_video_and_audio_use_known_duration() {
        let mut r = request("/v/carti.mov", OutputFormat::Mp4);
        r.source_duration = Some(120.0);
        assert_eq!(named(&r), "carti_120s.mp4");
        r.source_duration = Some(90.0);
        assert_eq!(named(&r), "carti_90s.mp4");
        r.source_duration = Some(125.0);
        assert_eq!(named(&r), "carti_125s.mp4");
        r.source_duration = Some(0.2);
        assert_eq!(named(&r), "carti_1s.mp4");
        r.clip = clip("00:20.000", "00:35.000");
        assert_eq!(named(&r), "carti_15s.mp4");
        r.clip = None;
        r.format = OutputFormat::Mp3;
        r.source_duration = Some(60.0);
        r.aspect = ratio(AspectRatio::R9x16);
        assert_eq!(named(&r), "carti_60s.mp3");
        r.input = InputSpec::Local { path: "/v/ambient.wav".into() };
        r.source_duration = Some(180.0);
        assert_eq!(named(&r), "ambient_180s.mp3");
    }

    #[test]
    fn still_images_have_no_duration_even_with_metadata() {
        let mut r = request("/photos/photo.HEIC", OutputFormat::Jpg);
        r.source_duration = Some(60.0);
        // The UI sends no duration for stills; the native suggestion also
        // ignores stray duration metadata for a still output.
        assert_eq!(named(&r), "photo.jpg");
        r.aspect = ratio(AspectRatio::R4x5);
        assert_eq!(named(&r), "photo_45.jpg");
    }

    #[test]
    fn messy_url_titles_are_normalized_and_missing_titles_use_safe_fallbacks() {
        let mut r = request("/unused", OutputFormat::Mp4);
        r.input = InputSpec::Url {
            url: "https://www.youtube.com/watch?v=8m91-gu-x8U".into(),
            quality: None,
        };
        r.source_duration = Some(60.0);
        r.source_title = Some("Empty Room: Ambient / Noise | Sound Effect!".into());
        assert_eq!(named(&r), "Empty_Room_Ambient_Noise_Sound_Effect_60s.mp4");
        r.source_title = Some("YouTube post".into());
        r.source_hint = Some("youtube-post.mp4".into());
        assert_eq!(named(&r), "8m91_gu_x8U_60s.mp4");
        r.source_hint = Some("A useful caption.mp4".into());
        assert_eq!(named(&r), "A_useful_caption_60s.mp4");
    }
}

/// Run one export to completion. Called on a worker thread.
pub fn run(app: AppHandle, job_id: String, request: ExportRequest, cancel: Arc<CancelToken>) {
    let settings = app.state::<SettingsStore>();

    let mut reporter: Option<Reporter> = None;
    let result = execute(
        &app,
        &job_id,
        &request,
        &cancel,
        settings.inner(),
        &mut reporter,
    );

    let registry = app.state::<JobRegistry>();
    registry.finish(&job_id);

    if let Err(error) = result {
        // Once the pipeline is planned the reporter knows which stage broke;
        // before that there is nothing to report but the failure itself.
        if let Some(reporter) = reporter.as_ref() {
            reporter.fail(error);
            return;
        }
        let event = JobEvent {
            job_id: job_id.clone(),
            state: if error.code == "cancelled" {
                JobState::Cancelled
            } else {
                JobState::Failed
            },
            stage_label: String::new(),
            stage_index: 0,
            stage_count: 1,
            progress: None,
            output_filename: String::new(),
            output: None,
            error: if error.code == "cancelled" {
                None
            } else {
                Some(error)
            },
            actions: Vec::new(),
        };
        let _ = app.emit(JOB_EVENT, event);
    }
}

fn execute(
    app: &AppHandle,
    job_id: &str,
    request: &ExportRequest,
    cancel: &Arc<CancelToken>,
    settings: &SettingsStore,
    slot: &mut Option<Reporter>,
) -> Result<()> {
    let output_dir = match &request.output_dir {
        Some(dir) => validation::validate_output_dir(dir)?,
        None => settings.default_output_dir(),
    };

    let temp = TempDir::create(job_id)?;

    // Images are a different medium with a different toolchain, so they get
    // their own short pipeline rather than being bent into the A/V one. Job
    // ids, temp dirs, progress events, cancellation, naming and finalizing are
    // all still the shared machinery below.
    // The *input* decides which pipeline runs, not the output. WEBP is both a
    // still and an animation, so asking the format alone would send a video
    // headed for animated WebP into the image pipeline.
    let remote_image = matches!(request.input, InputSpec::Url { .. }) && request.format.is_image();
    let local_image = matches!(&request.input, InputSpec::Local { path } if image_input(path, cancel));
    if remote_image || local_image {
        return execute_image(
            app, job_id, request, cancel, settings, slot, temp, &output_dir,
        );
    }

    let playback = app
        .state::<crate::media::playback::PlaybackRegistry>()
        .cached(&request.input, request.format.is_audio_only());

    // ---- Stage 1: understand the source -----------------------------------
    // Clip bounds can only be validated once the real duration is known, so the
    // pipeline is planned after analysis.
    let (source_title, duration, local_input): (String, Option<f64>, Option<PathBuf>) =
        match &request.input {
            InputSpec::Url { .. } if playback.is_some() => {
                let asset = playback.as_ref().unwrap();
                (
                    asset.title.clone(),
                    asset.probe.duration,
                    Some(asset.source.clone()),
                )
            }
            InputSpec::Url { url, .. } => {
                let parsed = validation::validate_url(url)?;
                let provider = providers::for_url(&parsed).ok_or_else(|| {
                    ShiftError::new("no_provider", "SHIFT can't handle this link.")
                })?;
                let cache = temp.sub("meta")?;
                let media = provider.analyze(&parsed, &cache, cancel)?;
                let duration = media.media_items.first().and_then(|item| item.duration);
                (media.title, duration, None)
            }
            InputSpec::Local { path } => {
                let resolved = validation::validate_input_path(path)?;
                let probe = ffprobe::probe(&resolved, cancel)?;
                let stem = resolved
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "output".into());
                (stem, probe.duration, Some(resolved))
            }
        };

    let clip = match &request.clip {
        Some(spec) => Some(validation::validate_clip(&spec.start, &spec.end, duration)?),
        None => None,
    };

    let (actions, stages) = plan_actions(request, clip);
    let stem = output_stem(request, &source_name(request, Some(&source_title)), clip, duration);
    let destination = resolve_destination(request, &output_dir, &stem)?;
    let filename = destination
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();

    *slot = Some(Reporter {
        app: app.clone(),
        job_id: job_id.to_string(),
        stages,
        actions,
        index: 0,
        filename: filename.clone(),
    });
    let reporter = slot.as_mut().expect("reporter was just installed");
    reporter.advance(JobState::Analyzing);

    // ---- Stage 2: get the bytes -------------------------------------------
    let source_path: PathBuf = match (&request.input, local_input) {
        (InputSpec::Url { .. }, Some(path)) => path,
        (InputSpec::Url { url, quality }, _) => {
            reporter.index = 1;
            reporter.advance(JobState::Downloading);

            let parsed = validation::validate_url(url)?;
            let provider = providers::for_url(&parsed)
                .ok_or_else(|| ShiftError::new("no_provider", "SHIFT can't handle this link."))?;
            let kind = if request.format.is_audio_only() {
                DownloadKind::Audio
            } else {
                DownloadKind::Video
            };
            let dest = temp.sub("download")?;
            let mut on_progress = |fraction: Option<f64>| {
                reporter.emit(JobState::Downloading, fraction);
            };
            provider.download(
                &parsed,
                kind,
                quality.as_deref().unwrap_or("best"),
                &dest,
                cancel,
                &mut on_progress,
            )?
        }
        (InputSpec::Local { .. }, Some(path)) => path,
        (InputSpec::Local { .. }, None) => unreachable!("local input is resolved above"),
    };

    // ---- Stage 3: transform ------------------------------------------------
    reporter.index = reporter.stages.len().saturating_sub(2);
    reporter.advance(JobState::Processing);

    let probe = ffprobe::probe(&source_path, cancel)?;
    // Re-validate against the real downloaded media, not the site's metadata.
    let clip = match &request.clip {
        Some(spec) => Some(validation::validate_clip(
            &spec.start,
            &spec.end,
            probe.duration,
        )?),
        None => None,
    };

    let work_dir = temp.sub("out")?;
    let temp_output = work_dir.join(format!("output.{}", request.format.ext()));
    let plan = profiles::build_plan_with_audio(
        &source_path,
        &probe,
        request.format,
        clip,
        request.loop_size.unwrap_or_default(),
        &request.aspect.unwrap_or_default(),
        request.sound_enabled,
        &temp_output,
    )?;

    let expected = clip.map(|c| c.duration()).or(probe.duration);
    {
        let mut on_progress = |fraction: f64| {
            reporter.emit(JobState::Processing, Some(fraction));
        };
        ffmpeg::execute(&plan, expected, cancel, &mut on_progress)?;
    }

    // ---- Stage 4: land it --------------------------------------------------
    reporter.index = reporter.stages.len().saturating_sub(1);
    reporter.advance(JobState::Finalizing);

    if cancel.is_cancelled() {
        return Err(ShiftError::cancelled());
    }

    // Without an explicit destination, re-check the generated name: another
    // export may have taken it while this one ran. A path the user chose is
    // left alone — they already confirmed it.
    let destination = if request.destination_path.is_none() && destination.exists() {
        filesystem::unique_path(&output_dir, &stem, request.format.ext())
    } else {
        destination
    };
    let size = filesystem::finalize(&temp_output, &destination)?;
    let landed_in = destination.parent().unwrap_or(&output_dir).to_path_buf();
    settings.set_output_dir(&landed_in.to_string_lossy());

    let filename = destination
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or(filename);

    reporter.finish(JobOutput {
        path: destination.to_string_lossy().to_string(),
        filename,
        size_bytes: size,
        remuxed: plan.remuxed,
        source_bytes: None,
        directory: validation::abbreviate_home(&landed_in),
    });

    // `temp` drops here, removing the whole per-job directory.
    Ok(())
}

/// True when the input takes the still-image pipeline.
///
/// A GIF is the one extension that can go either way: a single frame is a
/// picture, anything more is a moving source. `analyze_file` makes the same
/// call from the same count, so the pipeline that runs is the one the UI
/// offered outputs for.
fn image_input(path: &str, cancel: &CancelToken) -> bool {
    let p = PathBuf::from(path);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if image::is_image_ext(&ext) {
        return true;
    }
    ext == "gif" && matches!(ffprobe::frame_count(&p, cancel), Ok(n) if n <= 1)
}

/// The image pipeline: Analyze → Convert → (Compress) → Finalize.
///
/// Deliberately short. It reuses the job's temp directory, the collision-safe
/// naming, the finalize-then-move rule and the same event stream as everything
/// else — only the tools in the middle differ.
#[allow(clippy::too_many_arguments)]
fn execute_image(
    app: &AppHandle,
    job_id: &str,
    request: &ExportRequest,
    cancel: &Arc<CancelToken>,
    settings: &SettingsStore,
    slot: &mut Option<Reporter>,
    temp: TempDir,
    output_dir: &std::path::Path,
) -> Result<()> {
    let resolved = match &request.input {
        InputSpec::Local { path } => validation::validate_input_path(path)?,
        InputSpec::Url { url, .. } => {
            let parsed = validation::validate_url(url)?;
            let provider = providers::for_url(&parsed)
                .ok_or_else(|| ShiftError::new("no_provider", "SHIFT can't handle this link."))?;
            let download = temp.sub("download")?;
            provider.download(
                &parsed,
                DownloadKind::Image,
                "best",
                &download,
                cancel,
                &mut |_| {},
            )?
        }
    };
    let probe = image::probe(&resolved, cancel)?;
    let compression = request.compression.unwrap_or(Compression::None);

    let stem = output_stem(request, &source_name(request, None), None, None);
    let destination = resolve_destination(request, output_dir, &stem)?;

    let work_dir = temp.sub("out")?;
    let temp_output = work_dir.join(format!("output.{}", request.format.ext()));
    let plan = image::build_plan(
        &resolved,
        &probe.format,
        request.format,
        compression,
        probe.has_alpha,
        (probe.width, probe.height),
        &request.aspect.unwrap_or_default(),
        &work_dir,
        &temp_output,
    )?;

    // The stage list comes straight from the plan, so it describes the passes
    // that actually run rather than guessing from how many there are.
    let mut actions = vec![ActionSpec::Analyze];
    let aspect = request.aspect.unwrap_or_default();
    if !aspect.is_original() {
        actions.push(ActionSpec::Reframe {
            ratio: aspect.ratio,
            frame: aspect.frame,
        });
    }
    actions.push(ActionSpec::ConvertImage {
        format: request.format,
    });
    if plan.steps.len() > 1 {
        actions.push(ActionSpec::CompressImage { level: compression });
    }
    let mut stages: Vec<String> = vec!["Reading image…".into()];
    stages.extend(plan.labels.iter().cloned());
    stages.push("Finalizing…".into());

    *slot = Some(Reporter {
        app: app.clone(),
        job_id: job_id.to_string(),
        stages,
        actions,
        index: 0,
        filename: destination
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default(),
    });
    let reporter = slot.as_mut().expect("reporter was just installed");
    reporter.advance(JobState::Analyzing);

    // ---- run the passes ----------------------------------------------------
    for (i, step) in plan.steps.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(ShiftError::cancelled());
        }
        reporter.index = i + 1;
        reporter.advance(JobState::Processing);

        // Neither tool reports a usable percentage for a single still image,
        // and both finish in well under a second, so the UI shows stage
        // position rather than a number nobody measured.
        let (binary, args) = match step {
            image::ImageStep::Sips(args) => (Binary::Sips, args),
            image::ImageStep::Ffmpeg(args) => (Binary::Ffmpeg, args),
        };
        let out = crate::process::run_capture(binary, args, cancel)?;
        if !out.success {
            return Err(
                ShiftError::new("image_failed", "SHIFT couldn't convert this image.")
                    .hint("The file may be damaged or in an unexpected format.")
                    .technical(out.log()),
            );
        }
    }

    // ---- land it -----------------------------------------------------------
    reporter.index = reporter.stages.len().saturating_sub(1);
    reporter.advance(JobState::Finalizing);
    if cancel.is_cancelled() {
        return Err(ShiftError::cancelled());
    }

    let destination = if request.destination_path.is_none() && destination.exists() {
        filesystem::unique_path(output_dir, &stem, request.format.ext())
    } else {
        destination
    };
    let size = filesystem::finalize(&temp_output, &destination)?;
    let landed_in = destination.parent().unwrap_or(output_dir).to_path_buf();
    settings.set_output_dir(&landed_in.to_string_lossy());

    reporter.finish(JobOutput {
        path: destination.to_string_lossy().to_string(),
        filename: destination
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default(),
        size_bytes: size,
        remuxed: false,
        source_bytes: Some(probe.size_bytes),
        directory: validation::abbreviate_home(&landed_in),
    });

    Ok(())
}

/// Failures raised before a reporter exists still need the stage context, so
/// `execute` is wrapped rather than emitting from every `?`.
pub fn spawn(app: AppHandle, request: ExportRequest) -> String {
    let job_id = uuid::Uuid::new_v4().to_string();
    let cancel = app.state::<JobRegistry>().register(&job_id);
    // The UI switches to the processing screen on this, not on the first
    // yt-dlp byte — analysis can take a couple of seconds.
    let _ = app.emit(
        JOB_EVENT,
        JobEvent {
            job_id: job_id.clone(),
            state: JobState::Queued,
            stage_label: "Preparing…".into(),
            stage_index: 0,
            stage_count: 1,
            progress: None,
            output_filename: String::new(),
            output: None,
            error: None,
            actions: Vec::new(),
        },
    );
    let id = job_id.clone();
    std::thread::spawn(move || run(app, id, request, cancel));
    job_id
}
