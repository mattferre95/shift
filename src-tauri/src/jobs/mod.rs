//! The job model.
//!
//! Every export is a job with an id, an explicit state, a private temp
//! directory, and exactly one cancellation token that owns its child processes.
//! Actions are data (`ActionSpec`), so a future Crop or Normalize slots into the
//! same pipeline without a new screen flow (PRD §7).

use crate::errors::{Result, ShiftError};
use crate::filesystem::{self, TempDir};
use crate::media::image::{self, Compression};
use crate::media::{ffmpeg, ffprobe, profiles::{self, LoopSize, OutputFormat}};
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
    Download { kind: &'static str, quality: String },
    Trim { start: f64, end: f64 },
    Convert { format: OutputFormat },
    ExtractAudio { format: OutputFormat },
    ConvertImage { format: OutputFormat },
    CompressImage { level: Compression },
    MakeLoop { format: OutputFormat, size: LoopSize },
}

// ------------------------------------------------------------------- request

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum InputSpec {
    Url { url: String, quality: Option<String> },
    Local { path: String },
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
    pub output_dir: Option<String>,
    /// Images only. Ignored by the audio/video pipeline.
    #[serde(default)]
    pub compression: Option<Compression>,
    /// GIF and animated WEBP only. Ignored by every other output.
    #[serde(default)]
    pub loop_size: Option<LoopSize>,
    /// Full path chosen in the native Save panel. When present the user has
    /// already named the file and confirmed any overwrite, so SHIFT writes
    /// exactly there instead of inventing a collision-safe name.
    #[serde(default)]
    pub destination_path: Option<String>,
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
        self.jobs.lock().unwrap().insert(id.to_string(), Arc::clone(&token));
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
            state: if cancelled { JobState::Cancelled } else { JobState::Failed },
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
fn plan_actions(request: &ExportRequest, clip: Option<ClipRange>) -> (Vec<ActionSpec>, Vec<String>) {
    let mut actions = vec![ActionSpec::Analyze];
    let mut stages: Vec<String> = Vec::new();

    match &request.input {
        InputSpec::Url { quality, .. } => {
            stages.push("Fetching media…".into());
            let kind = if request.format.is_audio_only() { "audio" } else { "video" };
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

    if request.format.is_animation() {
        // A loop is one pass whether or not it is also trimmed, so the trim
        // does not get a stage of its own the way it does elsewhere.
        if let Some(range) = clip {
            actions.push(ActionSpec::Trim { start: range.start, end: range.end });
        }
        actions.push(ActionSpec::MakeLoop {
            format: request.format,
            size: request.loop_size.unwrap_or_default(),
        });
        stages.push("Building loop…".into());
    } else if let Some(range) = clip {
        actions.push(ActionSpec::Trim { start: range.start, end: range.end });
        stages.push("Clipping…".into());
    } else if request.format.is_audio_only() {
        actions.push(ActionSpec::ExtractAudio { format: request.format });
        stages.push("Converting…".into());
    } else {
        actions.push(ActionSpec::Convert { format: request.format });
        stages.push("Converting…".into());
    }

    stages.push("Finalizing…".into());
    (actions, stages)
}

/// Name the result the way the user would (EXP-02).
fn output_stem(request: &ExportRequest, source_title: &str, clip: Option<ClipRange>) -> String {
    let base = filesystem::sanitize_stem(source_title);
    match (&request.input, clip) {
        (InputSpec::Url { .. }, Some(range)) => format!(
            "{base}-{}-{}",
            validation::timestamp_tag(range.start),
            validation::timestamp_tag(range.end)
        ),
        (InputSpec::Url { .. }, None) => base,
        // A trimmed loop is already named by what it is, not by the trim.
        (InputSpec::Local { .. }, Some(_)) if request.format.is_animation() => base,
        (InputSpec::Local { .. }, Some(_)) => format!("{base}-trimmed"),
        (InputSpec::Local { path }, None) if request.format.is_image() => {
            let base = filesystem::sanitize_stem(source_title);
            let suffix = request
                .compression
                .map(|c| image::name_suffix(c, request.format))
                .unwrap_or(None);
            match suffix {
                Some(sfx) => format!("{base}{sfx}"),
                None => base,
            }
        }
        (InputSpec::Local { path }, None) => {
            let source_ext = PathBuf::from(path)
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            // Extracting audio changes the extension, so the plain name is
            // already unambiguous; a container swap needs the hint.
            if source_ext == request.format.ext() {
                format!("{base}-converted")
            } else if request.format.is_audio_only() {
                base
            } else {
                format!("{base}-converted")
            }
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
        None => Ok(filesystem::unique_path(output_dir, stem, request.format.ext())),
    }
}

/// The filename SHIFT would choose, used to prefill the Save panel. Naming
/// rules stay here so the frontend never has to reimplement them.
pub fn suggested_filename(request: &ExportRequest, source_title: &str) -> String {
    let clip = request
        .clip
        .as_ref()
        .and_then(|c| validation::validate_clip(&c.start, &c.end, None).ok());

    // For a local file the stem comes from the path, exactly as the job itself
    // derives it — the caller's title still carries the extension. Only a URL
    // needs the title passed in, since re-fetching it here would be wasteful.
    let title = match &request.input {
        InputSpec::Local { path } => PathBuf::from(path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| source_title.to_string()),
        InputSpec::Url { .. } => source_title.to_string(),
    };

    let stem = output_stem(request, &title, clip);
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
            output_dir: None,
            compression: None,
            loop_size: None,
            destination_path: None,
        }
    }

    #[test]
    fn a_local_suggestion_drops_the_source_extension() {
        // The UI passes the display name, which still has ".HEIC" on it.
        let r = request("/photos/IMG_7397.HEIC", OutputFormat::Jpg);
        assert_eq!(suggested_filename(&r, "IMG_7397.HEIC"), "IMG_7397.jpg");
    }

    #[test]
    fn a_compressed_image_is_marked_in_the_name() {
        let mut r = request("/photos/IMG_7397.HEIC", OutputFormat::Jpg);
        r.compression = Some(Compression::Balanced);
        assert_eq!(suggested_filename(&r, "IMG_7397.HEIC"), "IMG_7397-compressed.jpg");
    }

    #[test]
    fn a_trimmed_local_file_is_marked_in_the_name() {
        let mut r = request("/clips/ScreenRecording.mov", OutputFormat::Mp4);
        r.clip = Some(ClipSpec { start: "00:02.000".into(), end: "00:05.000".into() });
        assert_eq!(suggested_filename(&r, "ScreenRecording.mov"), "ScreenRecording-trimmed.mp4");
    }

    #[test]
    fn a_url_clip_carries_its_range() {
        let r = ExportRequest {
            input: InputSpec::Url { url: "https://example.com/x".into(), quality: None },
            format: OutputFormat::Mp3,
            clip: Some(ClipSpec { start: "02:52.000".into(), end: "02:56.000".into() }),
            output_dir: None,
            compression: None,
            loop_size: None,
            destination_path: None,
        };
        assert_eq!(suggested_filename(&r, "The Sopranos"), "The-Sopranos-02m52s-02m56s.mp3");
    }
}

/// Run one export to completion. Called on a worker thread.
pub fn run(app: AppHandle, job_id: String, request: ExportRequest, cancel: Arc<CancelToken>) {
    let settings = app.state::<SettingsStore>();

    let mut reporter: Option<Reporter> = None;
    let result = execute(&app, &job_id, &request, &cancel, settings.inner(), &mut reporter);

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
            state: if error.code == "cancelled" { JobState::Cancelled } else { JobState::Failed },
            stage_label: String::new(),
            stage_index: 0,
            stage_count: 1,
            progress: None,
            output_filename: String::new(),
            output: None,
            error: if error.code == "cancelled" { None } else { Some(error) },
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
    if let InputSpec::Local { path } = &request.input {
        if image_input(path) {
            return execute_image(app, job_id, request, cancel, settings, slot, temp, &output_dir);
        }
    }

    // ---- Stage 1: understand the source -----------------------------------
    // Clip bounds can only be validated once the real duration is known, so the
    // pipeline is planned after analysis.
    let (source_title, duration, local_input): (String, Option<f64>, Option<PathBuf>) =
        match &request.input {
            InputSpec::Url { url, .. } => {
                let parsed = validation::validate_url(url)?;
                let provider = providers::for_url(&parsed)
                    .ok_or_else(|| ShiftError::new("no_provider", "SHIFT can't handle this link."))?;
                let cache = temp.sub("meta")?;
                let media = provider.analyze(&parsed, &cache, cancel)?;
                (media.title, media.duration, None)
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
    let stem = output_stem(request, &source_title, clip);
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
        Some(spec) => Some(validation::validate_clip(&spec.start, &spec.end, probe.duration)?),
        None => None,
    };

    let work_dir = temp.sub("out")?;
    let temp_output = work_dir.join(format!("output.{}", request.format.ext()));
    let plan = profiles::build_plan(
        &source_path,
        &probe,
        request.format,
        clip,
        request.loop_size.unwrap_or_default(),
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

/// True when the path looks like one of the V1.1 image inputs.
fn image_input(path: &str) -> bool {
    PathBuf::from(path)
        .extension()
        .map(|e| image::is_image_ext(&e.to_string_lossy()))
        .unwrap_or(false)
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
    let InputSpec::Local { path } = &request.input else {
        return Err(ShiftError::new("no_image_url", "SHIFT can't fetch images from a link yet.")
            .hint("Drop the image in instead."));
    };

    let resolved = validation::validate_input_path(path)?;
    let probe = image::probe(&resolved, cancel)?;
    let compression = request.compression.unwrap_or(Compression::None);

    let stem_source = resolved
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".into());
    let stem = output_stem(request, &stem_source, None);
    let destination = resolve_destination(request, output_dir, &stem)?;

    let work_dir = temp.sub("out")?;
    let temp_output = work_dir.join(format!("output.{}", request.format.ext()));
    let plan = image::build_plan(
        &resolved,
        &probe.format,
        request.format,
        compression,
        probe.has_alpha,
        &work_dir,
        &temp_output,
    )?;

    // The stage list mirrors the plan: a second pass only appears when one is
    // genuinely run.
    let mut actions = vec![ActionSpec::Analyze, ActionSpec::ConvertImage { format: request.format }];
    let mut stages: Vec<String> = vec!["Reading image…".into(), "Converting…".into()];
    if plan.steps.len() > 1 {
        actions.push(ActionSpec::CompressImage { level: compression });
        stages.push(if plan.lossless { "Optimizing…".into() } else { "Compressing…".into() });
    }
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
            return Err(ShiftError::new("image_failed", "SHIFT couldn't convert this image.")
                .hint("The file may be damaged or in an unexpected format.")
                .technical(out.log()));
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
