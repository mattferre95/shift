//! Temp directories, output naming, and the final move.
//!
//! Output is always written inside a per-job temp directory and only moved to
//! the destination once it exists and is non-empty (PRD §7).

use crate::errors::{Result, ShiftError};
use std::path::{Path, PathBuf};

/// Temp directories older than this are considered abandoned by a crashed run.
const STALE_AFTER_SECS: u64 = 24 * 60 * 60;

fn root() -> PathBuf {
    std::env::temp_dir().join("SHIFT")
}

/// A private working directory for exactly one job. Dropped on completion,
/// failure, or cancellation.
#[derive(Debug)]
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn create(job_id: &str) -> Result<Self> {
        let path = root().join(job_id);
        std::fs::create_dir_all(&path).map_err(|e| ShiftError::io("create temp dir", e))?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A subdirectory, so a download and its converted output never collide.
    pub fn sub(&self, name: &str) -> Result<PathBuf> {
        let p = self.path().join(name);
        std::fs::create_dir_all(&p).map_err(|e| ShiftError::io("create temp subdir", e))?;
        Ok(p)
    }

    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        self.cleanup();
    }
}

/// Remove leftovers from a previous crash or force quit. Runs once at launch.
pub fn prune_stale_temp_dirs() {
    let Ok(entries) = std::fs::read_dir(root()) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if age > STALE_AFTER_SECS {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

// ------------------------------------------------------------- output naming

/// Turn any source title into something safe for a macOS filename (EXP-02).
///
/// Strips path separators and control characters, collapses whitespace to
/// single hyphens, and keeps the result short enough to survive suffixes.
pub fn sanitize_stem(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars() {
        let mapped = match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '(' | ')' | '[' | ']' => Some(ch),
            ' ' | '-' | '\t' => Some('-'),
            _ if ch.is_alphanumeric() => Some(ch),
            _ => None,
        };
        match mapped {
            Some('-') => {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            }
            Some(c) => {
                out.push(c);
                last_dash = false;
            }
            None => {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            }
        }
    }
    let trimmed = out.trim_matches(|c| c == '-' || c == '.').to_string();
    let trimmed = if trimmed.chars().count() > 80 {
        trimmed.chars().take(80).collect::<String>().trim_end_matches('-').to_string()
    } else {
        trimmed
    };
    if trimmed.is_empty() {
        "shift-output".to_string()
    } else {
        trimmed
    }
}

/// Pick a name that does not exist yet: `file.mp4`, then `file-2.mp4` (EXP-03).
///
/// Never overwrites. The caller passes an already-sanitized stem.
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 2..10_000u32 {
        let candidate = dir.join(format!("{stem}-{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Practically unreachable; keeps the signature total.
    dir.join(format!("{stem}-{}.{ext}", std::process::id()))
}

/// Move the finished file into place, falling back to copy across volumes.
pub fn finalize(temp_output: &Path, destination: &Path) -> Result<u64> {
    let meta = std::fs::metadata(temp_output)
        .map_err(|e| ShiftError::io("read finished output", e))?;
    if meta.len() == 0 {
        return Err(ShiftError::process_failed("the conversion produced an empty file"));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ShiftError::io("create destination", e))?;
    }
    match std::fs::rename(temp_output, destination) {
        Ok(()) => Ok(meta.len()),
        // Renames fail across devices; the temp dir is on the system volume.
        Err(_) => {
            std::fs::copy(temp_output, destination)
                .map_err(|e| ShiftError::io("copy output to destination", e))?;
            let _ = std::fs::remove_file(temp_output);
            Ok(meta.len())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_titles_into_filenames() {
        assert_eq!(sanitize_stem("The Sopranos"), "The-Sopranos");
        assert_eq!(sanitize_stem("a/b/../c"), "a-b-c");
        assert_eq!(sanitize_stem("  ..hello.. "), "hello");
        assert_eq!(sanitize_stem(""), "shift-output");
        assert_eq!(sanitize_stem("///"), "shift-output");
        assert!(sanitize_stem(&"x".repeat(300)).chars().count() <= 80);
    }

    #[test]
    fn never_reuses_an_existing_name() {
        let dir = std::env::temp_dir().join(format!("shift-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = unique_path(&dir, "clip", "mp4");
        assert!(a.ends_with("clip.mp4"));
        std::fs::write(&a, b"x").unwrap();
        let b = unique_path(&dir, "clip", "mp4");
        assert!(b.ends_with("clip-2.mp4"));
        std::fs::write(&b, b"x").unwrap();
        assert!(unique_path(&dir, "clip", "mp4").ends_with("clip-3.mp4"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
