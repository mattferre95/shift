//! FFmpeg execution and progress normalization.

use crate::errors::{Result, ShiftError};
use crate::media::profiles::EncodePlan;
use crate::process::{run, Binary, CancelToken};

/// Run an encode plan, reporting a 0.0–1.0 fraction whenever it is trustworthy.
///
/// FFmpeg's `-progress` stream gives an output timestamp; divided by a known
/// total duration that is a real percentage. Without a duration we report
/// nothing rather than inventing precision (JOB-03).
pub fn execute(
    plan: &EncodePlan,
    total_duration: Option<f64>,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(f64),
) -> Result<()> {
    let mut on_stdout = |line: &str| {
        if let Some(secs) = parse_progress_line(line) {
            if let Some(total) = total_duration {
                if total > 0.0 {
                    on_progress((secs / total).clamp(0.0, 1.0));
                }
            }
        }
    };

    let out = run(Binary::Ffmpeg, &plan.args, cancel, Some(&mut on_stdout), None)?;
    if !out.success {
        return Err(ShiftError::process_failed(out.log()));
    }
    Ok(())
}

/// Pull the output position out of one `key=value` progress line.
fn parse_progress_line(line: &str) -> Option<f64> {
    let (key, value) = line.split_once('=')?;
    match key.trim() {
        // Despite the name, FFmpeg reports both of these in microseconds.
        "out_time_us" | "out_time_ms" => value.trim().parse::<f64>().ok().map(|v| v / 1_000_000.0),
        "out_time" => parse_hms(value.trim()),
        _ => None,
    }
}

fn parse_hms(v: &str) -> Option<f64> {
    let mut total = 0f64;
    for part in v.split(':') {
        total = total * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_microsecond_progress() {
        assert_eq!(parse_progress_line("out_time_us=4000000"), Some(4.0));
        assert_eq!(parse_progress_line("out_time=00:00:04.000000"), Some(4.0));
        assert_eq!(parse_progress_line("progress=continue"), None);
        assert_eq!(parse_progress_line("garbage"), None);
    }
}
