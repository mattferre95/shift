//! The job model.
//!
//! Every export is a job with an id, an explicit state, a private temp
//! directory, and exactly one cancellation token that owns its child processes.
//! Actions are data (`ActionSpec`), so a future Crop or Normalize slots into the
//! same pipeline without a new screen flow (PRD §7).

use crate::errors::{Result, ShiftError};
use crate::filesystem::{self, TempDir};
use crate::media::{ffmpeg, ffprobe, profiles::{self, OutputFormat}};
use crate::process::CancelToken;
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

    if let Some(range) = clip {
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
        (InputSpec::Local { .. }, Some(_)) => format!("{base}-trimmed"),
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
    let destination = filesystem::unique_path(&output_dir, &stem, request.format.ext());
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
    let plan = profiles::build_plan(&source_path, &probe, request.format, clip, &temp_output)?;

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

    // Re-check the name: another export may have taken it while this one ran.
    let destination = if destination.exists() {
        filesystem::unique_path(&output_dir, &stem, request.format.ext())
    } else {
        destination
    };
    let size = filesystem::finalize(&temp_output, &destination)?;
    settings.set_output_dir(&output_dir.to_string_lossy());

    let filename = destination
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or(filename);

    reporter.finish(JobOutput {
        path: destination.to_string_lossy().to_string(),
        filename,
        size_bytes: size,
        remuxed: plan.remuxed,
    });

    // `temp` drops here, removing the whole per-job directory.
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
