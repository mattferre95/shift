//! Safe process execution.
//!
//! Two rules hold everywhere in SHIFT:
//!   1. Binaries are resolved by name from a known set — never from user input.
//!   2. Arguments are passed as an explicit array — no shell, no interpolation.
//!
//! Each spawned process is put in its own process group so cancelling a job can
//! terminate the whole tree (yt-dlp itself spawns ffmpeg) — JOB-04.
//!
//! The process group is set with `Command::process_group`, never with a
//! `pre_exec` closure calling `setsid`. `pre_exec` forces the standard library
//! off `posix_spawn` and onto `fork` + `exec`; a `fork` inside this Cocoa app
//! produces a single-threaded child that inherits locks (malloc, the Objective-C
//! runtime) held by other threads, and it deadlocks before it ever reaches
//! `exec`. `process_group` expresses the same intent through a posix_spawn
//! attribute, so no fork happens at all.

use crate::errors::{Result, ShiftError};
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};

/// The only binaries SHIFT will ever spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binary {
    Ffmpeg,
    Ffprobe,
    YtDlp,
    /// macOS' own image tool. Part of the OS, so it is never bundled — it is
    /// the reason SHIFT can read HEIC without shipping another decoder.
    Sips,
}

impl Binary {
    pub fn name(self) -> &'static str {
        match self {
            Binary::Ffmpeg => "ffmpeg",
            Binary::Ffprobe => "ffprobe",
            Binary::YtDlp => "yt-dlp",
            Binary::Sips => "sips",
        }
    }
}

/// Resolve a binary, preferring the copy we ship.
///
/// 1. Next to the running executable — where Tauri places `externalBin`
///    sidecars inside `SHIFT.app/Contents/MacOS/`.
/// 2. `src-tauri/binaries/` in a development checkout (with or without the
///    Rust target-triple suffix the bundler expects).
/// 3. `PATH`, so a dev machine with Homebrew tools works before sidecars are
///    fetched. A packaged build should never reach this arm.
pub fn resolve(bin: Binary) -> Result<PathBuf> {
    let name = bin.name();
    let triple = env!("SHIFT_TARGET_TRIPLE");

    // Where a bundled copy could live, most specific first.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf()); // Contents/MacOS — externalBin sidecars
            roots.push(dir.join("..").join("Resources")); // bundled resources
        }
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries")); // dev checkout

    // sips ships with macOS; there is no bundled copy to look for.
    if bin == Binary::Sips {
        let system = PathBuf::from("/usr/bin/sips");
        if system.is_file() {
            return Ok(system);
        }
        return which_on_path("sips").ok_or_else(|| ShiftError::missing_binary("sips"));
    }

    let relatives: Vec<String> = match bin {
        // yt-dlp ships as a directory build; see scripts/fetch-sidecars.sh for
        // why the single-file variant is not used.
        Binary::YtDlp => vec![
            "ytdlp/yt-dlp_macos".into(),
            name.into(),
            format!("{name}-{triple}"),
        ],
        _ => vec![name.into(), format!("{name}-{triple}")],
    };

    for root in &roots {
        for rel in &relatives {
            let candidate = root.join(rel);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    // Last resort: a development machine with the tools already installed.
    // A packaged build should never reach this arm.
    which_on_path(name).ok_or_else(|| ShiftError::missing_binary(name))
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    // Homebrew paths are appended because a GUI app launched from Finder
    // inherits a minimal PATH that omits them.
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|c| c.is_file())
}

/// Shared cancellation handle owned by one job.
#[derive(Debug, Default)]
pub struct CancelToken {
    cancelled: AtomicBool,
    /// Process group id of the currently running child, 0 when none.
    active_pgid: AtomicI32,
}

impl CancelToken {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Flag the job and tear down whatever it is currently running.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.kill_active();
    }

    fn kill_active(&self) {
        let pgid = self.active_pgid.load(Ordering::SeqCst);
        if pgid > 0 {
            unsafe {
                // Negative pid targets the whole group: yt-dlp and its ffmpeg child.
                libc::kill(-pgid, libc::SIGTERM);
            }
        }
    }

    fn set_active(&self, pgid: i32) {
        self.active_pgid.store(pgid, Ordering::SeqCst);
    }

    fn clear_active(&self) {
        self.active_pgid.store(0, Ordering::SeqCst);
    }
}

pub struct ProcOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl ProcOutput {
    /// Everything worth putting behind "Technical details".
    pub fn log(&self) -> String {
        let mut s = match self.code {
            Some(c) => format!("exit status {c}\n"),
            None => "terminated by signal\n".to_string(),
        };
        if !self.stderr.trim().is_empty() {
            s.push_str(self.stderr.trim());
        }
        if !self.stdout.trim().is_empty() {
            if !s.is_empty() {
                s.push('\n');
            }
            s.push_str(self.stdout.trim());
        }
        s
    }
}

/// Line callbacks. Returning nothing; parsing lives in the caller.
pub type LineSink<'a> = &'a mut dyn FnMut(&str);

/// Spawn `bin` with an explicit argument array and stream its output.
///
/// `on_stdout` and `on_stderr` see every line as it arrives so progress can be
/// normalized live. Both streams are also buffered for the technical log.
pub fn run(
    bin: Binary,
    args: &[String],
    cancel: &CancelToken,
    mut on_stdout: Option<LineSink<'_>>,
    mut on_stderr: Option<LineSink<'_>>,
) -> Result<ProcOutput> {
    if cancel.is_cancelled() {
        return Err(ShiftError::cancelled());
    }
    let path = resolve(bin)?;

    let mut cmd = Command::new(&path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Deny the child any inherited web/proxy surprises we did not set.
        .env_remove("LD_PRELOAD")
        // Its own process group, so SIGTERM reaches the whole tree on cancel.
        .process_group(0);

    let mut child: Child = cmd.spawn().map_err(|e| {
        ShiftError::new("spawn_failed", "SHIFT couldn't start its media engine.")
            .technical(format!("{}: {e}", path.display()))
    })?;

    let pid = child.id() as i32;
    cancel.set_active(pid);
    // Cancellation may have landed between the check above and the spawn.
    if cancel.is_cancelled() {
        unsafe { libc::kill(-pid, libc::SIGTERM) };
    }

    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    // stderr is drained on a worker thread; stdout is read on this thread so the
    // caller's progress closure needs no synchronization.
    let stderr_handle = {
        let raw = child.stderr.take();
        let buf = Arc::clone(&stderr_buf);
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let joiner = std::thread::spawn(move || {
            if let Some(raw) = raw {
                for line in BufReader::new(raw).split(b'\n').flatten() {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    {
                        let mut b = buf.lock().unwrap();
                        b.push_str(&line);
                        b.push('\n');
                    }
                    let _ = tx.send(line);
                }
            }
        });
        (joiner, rx)
    };

    if let Some(raw) = child.stdout.take() {
        for line in BufReader::new(raw).split(b'\n').flatten() {
            let line = String::from_utf8_lossy(&line).trim_end().to_string();
            {
                let mut b = stdout_buf.lock().unwrap();
                b.push_str(&line);
                b.push('\n');
            }
            if let Some(sink) = on_stdout.as_mut() {
                sink(&line);
            }
            // Drain whatever stderr has produced so far without blocking.
            if let Some(sink) = on_stderr.as_mut() {
                while let Ok(l) = stderr_handle.1.try_recv() {
                    sink(&l);
                }
            }
        }
    }

    let _ = stderr_handle.0.join();
    if let Some(sink) = on_stderr.as_mut() {
        while let Ok(l) = stderr_handle.1.try_recv() {
            sink(&l);
        }
    }

    let status = child.wait().map_err(|e| {
        ShiftError::new("wait_failed", "SHIFT lost track of a running task.").technical(e.to_string())
    })?;
    cancel.clear_active();

    if cancel.is_cancelled() {
        return Err(ShiftError::cancelled());
    }

    let stdout = stdout_buf.lock().unwrap().clone();
    let stderr = stderr_buf.lock().unwrap().clone();
    Ok(ProcOutput { success: status.success(), code: status.code(), stdout, stderr })
}

/// Convenience wrapper for short one-shot commands (ffprobe, `--dump-json`).
pub fn run_capture(bin: Binary, args: &[String], cancel: &CancelToken) -> Result<ProcOutput> {
    run(bin, args, cancel, None, None)
}
