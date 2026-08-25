//! End-to-end checks of the media core against real media.
//!
//! These drive the same code path an export uses — probe, build the profile,
//! run FFmpeg, finalize — on a fixture generated at test time. No copyrighted
//! media is committed to the repository.

use shift_lib::filesystem;
use shift_lib::media::ffmpeg;
use shift_lib::media::ffprobe;
use shift_lib::media::profiles::{build_plan, OutputFormat};
use shift_lib::process::{resolve, run_capture, Binary, CancelToken};
use shift_lib::validation::ClipRange;
use std::path::{Path, PathBuf};

fn workspace() -> PathBuf {
    let dir = std::env::temp_dir().join("shift-pipeline-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A 6-second 640×360 H.264 + AAC clip — small, fast, and license-free.
fn fixture() -> PathBuf {
    let path = workspace().join("fixture.mp4");
    if path.is_file() {
        return path;
    }
    let args: Vec<String> = [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "6",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(path.to_string_lossy().to_string()))
    .collect();

    let out = run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).expect("ffmpeg available");
    assert!(out.success, "could not build fixture: {}", out.log());
    path
}

fn convert(input: &Path, format: OutputFormat, clip: Option<ClipRange>, name: &str) -> PathBuf {
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(input, &cancel).expect("probe");
    let output = workspace().join(format!("{name}.{}", format.ext()));
    let _ = std::fs::remove_file(&output);

    let plan = build_plan(input, &probe, format, clip, &output).expect("plan");
    let expected = clip.map(|c| c.duration()).or(probe.duration);

    let mut seen: Vec<f64> = Vec::new();
    let mut on_progress = |f: f64| seen.push(f);
    ffmpeg::execute(&plan, expected, &cancel, &mut on_progress).expect("ffmpeg run");

    assert!(output.is_file(), "{name}: no output produced");
    assert!(std::fs::metadata(&output).unwrap().len() > 0, "{name}: empty output");
    assert!(!seen.is_empty(), "{name}: no progress was reported");
    output
}

fn duration_of(path: &Path) -> f64 {
    ffprobe::probe(path, &CancelToken::new()).unwrap().duration.unwrap()
}

#[test]
fn binaries_resolve() {
    for bin in [Binary::Ffmpeg, Binary::Ffprobe, Binary::YtDlp] {
        resolve(bin).unwrap_or_else(|e| panic!("{}: {e}", bin.name()));
    }
}

#[test]
fn probes_a_real_file() {
    let probe = ffprobe::probe(&fixture(), &CancelToken::new()).unwrap();
    assert_eq!(probe.video.as_ref().unwrap().codec, "h264");
    assert_eq!(probe.video.as_ref().unwrap().width, Some(640));
    assert_eq!(probe.audio.as_ref().unwrap().codec, "aac");
    assert!((probe.duration.unwrap() - 6.0).abs() < 0.3);
}

#[test]
fn extracts_audio_to_mp3_and_wav() {
    for (format, name) in [(OutputFormat::Mp3, "audio"), (OutputFormat::Wav, "audio")] {
        let out = convert(&fixture(), format, None, name);
        let probe = ffprobe::probe(&out, &CancelToken::new()).unwrap();
        assert!(probe.video.is_none(), "{:?} kept a video stream", format);
        assert!(probe.audio.is_some(), "{:?} has no audio", format);
        assert!((duration_of(&out) - 6.0).abs() < 0.3);
    }
}

#[test]
fn mp4_to_mov_is_a_stream_copy() {
    let input = fixture();
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&input, &cancel).unwrap();
    let output = workspace().join("copy.mov");
    let plan = build_plan(&input, &probe, OutputFormat::Mov, None, &output).unwrap();
    assert!(plan.remuxed, "an H.264/AAC MP4 should remux into MOV");

    let _ = std::fs::remove_file(&output);
    ffmpeg::execute(&plan, probe.duration, &cancel, &mut |_| {}).unwrap();
    let after = ffprobe::probe(&output, &cancel).unwrap();
    // A copy must not touch the codecs.
    assert_eq!(after.video.unwrap().codec, "h264");
    assert_eq!(after.audio.unwrap().codec, "aac");
}

#[test]
fn trims_accurately() {
    // 2.000 → 4.500 is deliberately off any keyframe boundary.
    let clip = ClipRange { start: 2.0, end: 4.5 };
    let out = convert(&fixture(), OutputFormat::Mp4, Some(clip), "trimmed");
    let actual = duration_of(&out);
    assert!(
        (actual - 2.5).abs() < 0.15,
        "expected a 2.5s clip, got {actual:.3}s — the cut is not accurate"
    );
}

#[test]
fn transcodes_to_webm() {
    let clip = ClipRange { start: 0.0, end: 1.0 };
    let out = convert(&fixture(), OutputFormat::Webm, Some(clip), "vp9");
    let probe = ffprobe::probe(&out, &CancelToken::new()).unwrap();
    assert_eq!(probe.video.unwrap().codec, "vp9");
    assert_eq!(probe.audio.unwrap().codec, "opus");
}

#[test]
fn output_names_never_collide() {
    let dir = workspace().join("collide");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut names = Vec::new();
    for _ in 0..3 {
        let p = filesystem::unique_path(&dir, "The-Sopranos-02m52s-02m56s", "mp3");
        std::fs::write(&p, b"x").unwrap();
        names.push(p.file_name().unwrap().to_string_lossy().to_string());
    }
    assert_eq!(
        names,
        [
            "The-Sopranos-02m52s-02m56s.mp3",
            "The-Sopranos-02m52s-02m56s-2.mp3",
            "The-Sopranos-02m52s-02m56s-3.mp3"
        ]
    );
}

#[test]
fn cancellation_stops_the_process() {
    let input = fixture();
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&input, &cancel).unwrap();
    let output = workspace().join("cancelled.webm");
    let _ = std::fs::remove_file(&output);

    // VP9 on a full 6s clip is slow enough to still be running when we pull it.
    let plan = build_plan(&input, &probe, OutputFormat::Webm, None, &output).unwrap();

    let token = std::sync::Arc::clone(&cancel);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        token.cancel();
    });

    let started = std::time::Instant::now();
    let result = ffmpeg::execute(&plan, probe.duration, &cancel, &mut |_| {});
    let elapsed = started.elapsed();

    let err = result.expect_err("a cancelled encode must not report success");
    assert_eq!(err.code, "cancelled");
    assert!(cancel.is_cancelled());
    assert!(elapsed.as_secs() < 10, "cancel did not take effect promptly");
}

#[test]
fn a_finished_file_only_moves_once_it_is_real() {
    let dir = workspace().join("finalize");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let empty = dir.join("empty.mp4");
    std::fs::write(&empty, b"").unwrap();
    assert!(filesystem::finalize(&empty, &dir.join("dest.mp4")).is_err());

    let good = dir.join("good.mp4");
    std::fs::write(&good, b"1234567890").unwrap();
    let size = filesystem::finalize(&good, &dir.join("dest.mp4")).unwrap();
    assert_eq!(size, 10);
    assert!(dir.join("dest.mp4").is_file());
    assert!(!good.exists(), "the temp file should be gone after the move");
}
