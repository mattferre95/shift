//! Focused coverage for the video sound preference.

use shift_lib::media::aspect::AspectSpec;
use shift_lib::media::{ffmpeg, ffprobe};
use shift_lib::media::profiles::{build_plan_with_audio, LoopSize, OutputFormat};
use shift_lib::process::{run_capture, Binary, CancelToken};
use shift_lib::validation::ClipRange;
use std::path::{Path, PathBuf};

fn workspace() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("shift-sound-toggle-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fixture() -> PathBuf {
    let path = workspace().join("source.mp4");
    let args: Vec<String> = [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "2", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac",
    ]
    .iter()
    .map(|value| value.to_string())
    .chain(std::iter::once(path.to_string_lossy().into_owned()))
    .collect();
    let output = run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).expect("ffmpeg");
    assert!(output.success, "fixture failed: {}", output.log());
    path
}

fn export(input: &Path, format: OutputFormat, sound_enabled: bool, name: &str) -> PathBuf {
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(input, &cancel).expect("probe source");
    let output = workspace().join(format!("{name}.{}", format.ext()));
    let clip = (name == "muted").then_some(ClipRange { start: 0.25, end: 1.5 });
    let plan = build_plan_with_audio(
        input,
        &probe,
        format,
        clip,
        LoopSize::default(),
        &AspectSpec::default(),
        sound_enabled,
        &output,
    )
    .expect("plan");
    if !sound_enabled && !format.is_audio_only() {
        assert!(plan.args.iter().any(|arg| arg == "-an"));
    }
    ffmpeg::execute(
        &plan,
        clip.map(|range| range.duration()).or(probe.duration),
        &cancel,
        &mut |_| {},
    )
    .expect("export");
    output
}

#[test]
fn video_sound_toggle_controls_streams_without_breaking_audio_extraction() {
    let source = fixture();
    let cancel = CancelToken::new();
    assert!(ffprobe::probe(&source, &cancel).unwrap().audio.is_some());

    let with_sound = export(&source, OutputFormat::Mp4, true, "with-sound");
    assert!(ffprobe::probe(&with_sound, &cancel).unwrap().audio.is_some());

    let muted = export(&source, OutputFormat::Mp4, false, "muted");
    assert!(ffprobe::probe(&muted, &cancel).unwrap().audio.is_none());

    let extracted = export(&source, OutputFormat::Mp3, false, "extracted");
    let probe = ffprobe::probe(&extracted, &cancel).unwrap();
    assert!(probe.video.is_none() && probe.audio.is_some());
}
