//! Everything the frontend sends becomes validated, structured data here before
//! it can influence a process argument (IN-04, security §9).

use crate::errors::{Result, ShiftError};
use std::path::{Path, PathBuf};
use url::Url;

/// Accept only real http/https URLs. Rejects file:, data:, javascript:, and junk.
pub fn validate_url(raw: &str) -> Result<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ShiftError::invalid_url());
    }
    let parsed = Url::parse(trimmed).map_err(|_| ShiftError::invalid_url())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err(ShiftError::invalid_url()),
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err(ShiftError::invalid_url());
    }
    Ok(parsed)
}

// ---------------------------------------------------------------- timestamps

/// Parse a millisecond-capable timestamp (URL-04).
///
/// Accepted: `SS`, `SS.mmm`, `MM:SS`, `MM:SS.mmm`, `HH:MM:SS`, `HH:MM:SS.mmm`.
pub fn parse_timestamp(raw: &str) -> Result<f64> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(ShiftError::validation(
            "Enter a timestamp such as 02:52.000.",
        ));
    }
    let bad = || ShiftError::validation(format!("\u{201c}{s}\u{201d} isn't a valid timestamp."));

    let parts: Vec<&str> = s.split(':').collect();
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|p| p.is_empty()) {
        return Err(bad());
    }

    // Only the seconds field may carry a fraction; only the leading field may
    // exceed its usual range (so "90" is a minute and a half, but "02:99" is not
    // a valid MM:SS).
    let seconds: f64 = parts.last().unwrap().parse().map_err(|_| bad())?;
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(bad());
    }
    if parts.len() > 1 && seconds >= 60.0 {
        return Err(bad());
    }

    let mut total = seconds;
    let mut unit = 60.0;
    for (i, part) in parts.iter().enumerate().rev().skip(1) {
        let value: u64 = part.parse().map_err(|_| bad())?;
        if i > 0 && value >= 60 {
            return Err(bad());
        }
        total += value as f64 * unit;
        unit *= 60.0;
    }
    Ok(total)
}

/// A validated IN/OUT range in seconds.
#[derive(Debug, Clone, Copy)]
pub struct ClipRange {
    pub start: f64,
    pub end: f64,
}

impl ClipRange {
    pub fn duration(&self) -> f64 {
        self.end - self.start
    }
}

/// URL-05: 0 <= IN < OUT <= duration when duration is known.
pub fn validate_clip(start_raw: &str, end_raw: &str, duration: Option<f64>) -> Result<ClipRange> {
    let start = parse_timestamp(start_raw)?;
    let end = parse_timestamp(end_raw)?;
    if end <= start {
        return Err(ShiftError::validation("OUT has to come after IN."));
    }
    if let Some(d) = duration {
        // Only tolerate rounding to the UI’s millisecond precision.
        if d > 0.0 && start >= d {
            return Err(ShiftError::validation("IN is past the end of this media."));
        }
        if d > 0.0 && end > d + 0.001 {
            return Err(ShiftError::validation("OUT is past the end of this media."));
        }
    }
    Ok(ClipRange { start, end })
}

/// Render seconds back into the canonical `MM:SS.mmm` / `HH:MM:SS.mmm` form.
pub fn format_timestamp(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0).round().max(0.0) as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let m = (total_s / 60) % 60;
    let h = total_s / 3600;
    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}.{ms:03}")
    } else {
        format!("{m:02}:{s:02}.{ms:03}")
    }
}

/// Compact form used inside generated filenames: `02m52s`.
pub fn timestamp_tag(seconds: f64) -> String {
    let total = seconds.max(0.0).floor() as u64;
    let s = total % 60;
    let m = (total / 60) % 60;
    let h = total / 3600;
    if h > 0 {
        format!("{h}h{m:02}m{s:02}s")
    } else {
        format!("{m:02}m{s:02}s")
    }
}

// --------------------------------------------------------------------- paths

/// Accept only an existing regular file, resolved to a canonical absolute path.
pub fn validate_input_path(raw: &str) -> Result<PathBuf> {
    let p = Path::new(raw);
    let canonical = p.canonicalize().map_err(|e| {
        ShiftError::new("missing_file", "SHIFT can't find that file.")
            .technical(format!("{raw}: {e}"))
    })?;
    if !canonical.is_file() {
        return Err(ShiftError::new(
            "not_a_file",
            "That isn't a file SHIFT can open.",
        ));
    }
    Ok(canonical)
}

/// Accept only an existing, writable-looking directory.
pub fn validate_output_dir(raw: &str) -> Result<PathBuf> {
    let p = Path::new(raw);
    let canonical = p.canonicalize().map_err(|e| {
        ShiftError::new("missing_dir", "That destination folder no longer exists.")
            .hint("Choose another location.")
            .technical(format!("{raw}: {e}"))
    })?;
    if !canonical.is_dir() {
        return Err(ShiftError::new(
            "not_a_dir",
            "That destination isn't a folder.",
        ));
    }
    Ok(canonical)
}

/// Every extension SHIFT can produce. Used to decide whether a user-typed
/// extension is one we may replace, or an ordinary part of their filename.
const KNOWN_EXTS: [&str; 10] = [
    "mp4", "mov", "webm", "mp3", "wav", "m4a", "aac", "jpg", "png", "webp",
];

/// Validate a destination chosen through the native Save panel and force its
/// extension to match the requested output format.
///
/// SHIFT decides the format; the panel only decides the name and folder. The
/// panel already appends the right extension in the common case, so this is a
/// safety net for a name the user edited by hand.
pub fn normalize_destination(raw: &str, target_ext: &str) -> Result<PathBuf> {
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return Err(ShiftError::validation("That isn't a valid filename."));
    }

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            ShiftError::new(
                "no_destination_dir",
                "SHIFT couldn't work out where to save that.",
            )
            .hint("Choose a folder in the Save panel.")
        })?;
    // Resolve the folder now so a directory removed between choosing and saving
    // is reported before any work starts.
    let parent = validate_output_dir(&parent.to_string_lossy())?;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| ShiftError::validation("That isn't a valid filename."))?;

    let current_ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let target = target_ext.to_ascii_lowercase();

    let final_name = if current_ext == target {
        name
    } else if KNOWN_EXTS.contains(&current_ext.as_str()) {
        // A different SHIFT format: replace it, never let the two disagree.
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or(name);
        format!("{stem}.{target}")
    } else {
        // Not an extension we own (or none at all): keep the name intact and
        // append, so "my.file.name" does not lose its last segment.
        format!("{name}.{target}")
    };

    Ok(parent.join(final_name))
}

/// `~/Documents/Samples` rather than a full home path, for display only.
pub fn abbreviate_home(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    match dirs::home_dir() {
        Some(home) => {
            let home = home.to_string_lossy().to_string();
            if text == home {
                "~".to_string()
            } else if let Some(rest) = text.strip_prefix(&format!("{home}/")) {
                format!("~/{rest}")
            } else {
                text
            }
        }
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamp_forms() {
        assert_eq!(parse_timestamp("12").unwrap(), 12.0);
        assert_eq!(parse_timestamp("02:52.000").unwrap(), 172.0);
        assert!((parse_timestamp("02:52.500").unwrap() - 172.5).abs() < 1e-9);
        assert_eq!(parse_timestamp("01:00:00").unwrap(), 3600.0);
        // A bare leading field may exceed its usual range.
        assert_eq!(parse_timestamp("90").unwrap(), 90.0);
        assert_eq!(parse_timestamp("90:00").unwrap(), 5400.0);
    }

    #[test]
    fn rejects_junk_timestamps() {
        for bad in [
            "",
            "abc",
            "1:2:3:4",
            "-5",
            "02::52",
            "02:99",
            "01:75:00",
            "1:2:3.5:4",
        ] {
            assert!(parse_timestamp(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn clip_bounds_are_enforced() {
        assert!(validate_clip("02:52.000", "02:56.000", Some(762.0)).is_ok());
        assert!(validate_clip("02:56.000", "02:52.000", Some(762.0)).is_err());
        assert!(validate_clip("00:00.000", "20:00.000", Some(762.0)).is_err());
        assert!(validate_clip("00:00.000", "20:00.000", None).is_ok());
    }

    #[test]
    fn rejects_non_http_urls() {
        assert!(validate_url("https://example.com/watch?v=1").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "",
            "not a url",
            "ftp://x/y",
        ] {
            assert!(validate_url(bad).is_err(), "{bad} should be rejected");
        }
    }

    fn dest(name: &str, ext: &str) -> String {
        let dir = std::env::temp_dir();
        normalize_destination(&dir.join(name).to_string_lossy(), ext)
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn destination_extension_always_matches_the_format() {
        assert_eq!(dest("clip.mp3", "mp3"), "clip.mp3");
        // Case differences are not a disagreement.
        assert_eq!(dest("clip.MP3", "mp3"), "clip.MP3");
        // A different SHIFT format is replaced, never left to disagree.
        assert_eq!(dest("photo.png", "jpg"), "photo.jpg");
        assert_eq!(dest("clip.mov", "mp4"), "clip.mp4");
        // No extension at all: append.
        assert_eq!(dest("carmela-sample", "mp3"), "carmela-sample.mp3");
        // A dotted name we do not own keeps every segment.
        assert_eq!(dest("my.file.name", "jpg"), "my.file.name.jpg");
    }

    #[test]
    fn destination_needs_a_real_folder() {
        assert!(normalize_destination("/nope/does/not/exist/x.mp3", "mp3").is_err());
        assert!(normalize_destination("", "mp3").is_err());
    }

    #[test]
    fn formats_round_trip() {
        assert_eq!(format_timestamp(172.0), "02:52.000");
        assert_eq!(timestamp_tag(172.0), "02m52s");
        assert_eq!(format_timestamp(3661.5), "01:01:01.500");
    }
}
