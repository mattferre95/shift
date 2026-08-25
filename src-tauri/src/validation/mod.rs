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
        return Err(ShiftError::validation("Enter a timestamp such as 02:52.000."));
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
        // Allow a small tolerance: probed durations are approximate.
        if d > 0.0 && start >= d {
            return Err(ShiftError::validation("IN is past the end of this media."));
        }
        if d > 0.0 && end > d + 0.5 {
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
    let canonical = p
        .canonicalize()
        .map_err(|e| ShiftError::new("missing_file", "SHIFT can't find that file.").technical(format!("{raw}: {e}")))?;
    if !canonical.is_file() {
        return Err(ShiftError::new("not_a_file", "That isn't a file SHIFT can open."));
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
        return Err(ShiftError::new("not_a_dir", "That destination isn't a folder."));
    }
    Ok(canonical)
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
        for bad in ["", "abc", "1:2:3:4", "-5", "02::52", "02:99", "01:75:00", "1:2:3.5:4"] {
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
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "", "not a url", "ftp://x/y"] {
            assert!(validate_url(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn formats_round_trip() {
        assert_eq!(format_timestamp(172.0), "02:52.000");
        assert_eq!(timestamp_tag(172.0), "02m52s");
        assert_eq!(format_timestamp(3661.5), "01:01:01.500");
    }
}
