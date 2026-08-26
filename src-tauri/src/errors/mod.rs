//! Normalized errors.
//!
//! Every failure that can reach the UI carries a short human sentence, an
//! optional next step, and a technical blob that stays collapsed until the user
//! opens "Technical details" (JOB-05).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftError {
    /// Stable machine code, e.g. `fetch_failed`. Also shown in technical details.
    pub code: String,
    /// One short sentence. No stack traces, no tool names.
    pub message: String,
    /// What the user can do about it, when there is something useful to say.
    pub hint: Option<String>,
    /// Raw stderr/stdout/context. Never rendered unless the user expands it.
    pub technical: Option<String>,
}

impl ShiftError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), hint: None, technical: None }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn technical(mut self, technical: impl Into<String>) -> Self {
        let t: String = technical.into();
        let t = t.trim();
        if !t.is_empty() {
            // Keep the log useful but bounded; tails carry the actual failure.
            self.technical = Some(tail(t, 8_000));
        }
        self
    }

    // ---- Shared constructors, so the same failure always reads the same way.

    pub fn invalid_url() -> Self {
        Self::new("invalid_url", "That doesn't look like a media link.")
            .hint("SHIFT accepts http:// and https:// addresses.")
    }

    pub fn fetch_failed(technical: impl Into<String>) -> Self {
        Self::new("fetch_failed", "Couldn't fetch this link.")
            .hint("The source may be unsupported or temporarily unavailable.")
            .technical(technical)
    }

    pub fn download_failed(technical: impl Into<String>) -> Self {
        Self::new("download_failed", "The download didn't finish.")
            .hint("Check your connection and try again.")
            .technical(technical)
    }

    pub fn unsupported_file() -> Self {
        Self::new("unsupported_file", "SHIFT can't read this file.")
            .hint("SHIFT supports MP4, MOV, WEBM video, MP3, WAV, M4A, AAC audio, and HEIC, HEIF, JPG, PNG, WEBP images.")
    }

    pub fn probe_failed(technical: impl Into<String>) -> Self {
        Self::new("probe_failed", "SHIFT couldn't read this file's media information.")
            .hint("The file may be incomplete or in an unsupported format.")
            .technical(technical)
    }

    pub fn process_failed(technical: impl Into<String>) -> Self {
        Self::new("process_failed", "The conversion failed.")
            .hint("The source media may use a combination SHIFT can't handle yet.")
            .technical(technical)
    }

    pub fn missing_binary(name: &str) -> Self {
        Self::new("missing_binary", format!("SHIFT is missing its {name} component."))
            .hint("Reinstall SHIFT, or run scripts/fetch-sidecars.sh in a development checkout.")
            .technical(format!("could not resolve bundled or system binary: {name}"))
    }

    pub fn io(context: &str, e: std::io::Error) -> Self {
        Self::new("io_error", "SHIFT couldn't write the output file.")
            .hint("Check that the destination folder exists and is writable.")
            .technical(format!("{context}: {e}"))
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("validation", message)
    }

    pub fn cancelled() -> Self {
        Self::new("cancelled", "Cancelled.")
    }
}

impl std::fmt::Display for ShiftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ShiftError {}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let start = s.len() - max;
    let start = (start..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
    format!("…\n{}", &s[start..])
}

pub type Result<T> = std::result::Result<T, ShiftError>;
