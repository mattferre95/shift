//! Controlled changing tones prove both the length and the selected section.
use shift_lib::{
    filesystem::TempDir,
    media::{
        aspect::AspectSpec,
        ffmpeg, ffprobe,
        profiles::{build_plan, LoopSize, OutputFormat},
    },
    process::{resolve, run_capture, Binary, CancelToken},
    validation::validate_clip,
};
use std::{path::Path, process::Command};
fn generate(args: &[&str], out: &Path) {
    let args: Vec<String> = ["-v", "error", "-nostdin", "-y"]
        .into_iter()
        .chain(args.iter().copied())
        .map(String::from)
        .chain(Some(out.to_string_lossy().into_owned()))
        .collect();
    let result = run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap();
    assert!(result.success, "{}", result.log());
}
fn frequency(path: &Path) -> f64 {
    let bytes = Command::new(resolve(Binary::Ffmpeg).unwrap())
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-ss", "0.1", "-t", "0.5", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(bytes.status.success());
    let pcm: Vec<f32> = bytes
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    pcm.windows(2).filter(|s| s[0] <= 0.0 && s[1] > 0.0).count() as f64
        / (pcm.len() as f64 / 48000.0)
}
#[test]
fn audio_trim_selects_the_requested_tone_across_formats() {
    let dir = TempDir::create(&uuid::Uuid::new_v4().to_string()).unwrap();
    let wav = dir.path().join("tones.wav");
    generate(
        &[
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.3*sin(2*PI*(220+220*floor(t/2))*t):s=48000:d=8",
        ],
        &wav,
    );
    for (source, target) in [
        ("mp3", OutputFormat::Mp3),
        ("mp3", OutputFormat::M4a),
        ("wav", OutputFormat::Flac),
        ("m4a", OutputFormat::M4a),
        ("flac", OutputFormat::Wav),
    ] {
        let input = dir.path().join(format!("tones.{source}"));
        if input != wav {
            generate(&["-i", wav.to_str().unwrap()], &input);
        }
        let cancel = CancelToken::new();
        let probe = ffprobe::probe(&input, &cancel).unwrap();
        for (start, end, hz) in [(2.25, 3.75, 440.0), (6.75, 7.95, 880.0)] {
            let clip = validate_clip(&start.to_string(), &end.to_string(), probe.duration).unwrap();
            let output = dir.path().join(format!("out-{}.{}", start, target.ext()));
            let plan = build_plan(
                &input,
                &probe,
                target,
                Some(clip),
                LoopSize::default(),
                &AspectSpec::default(),
                &output,
            )
            .unwrap();
            assert!(!plan.remuxed);
            ffmpeg::execute(&plan, Some(clip.duration()), &cancel, &mut |_| {}).unwrap();
            let result = ffprobe::probe(&output, &cancel).unwrap();
            assert!(result.audio.is_some());
            assert!(result.video.is_none());
            assert!(
                (result.duration.unwrap() - clip.duration()).abs() < 0.06,
                "{source} → {target:?}: {:?}",
                result.duration
            );
            assert!(
                (frequency(&output) - hz).abs() < 5.0,
                "wrong section: {source} → {target:?}"
            );
        }
    }
}
#[test]
fn trim_rejects_ranges_that_cannot_be_exported() {
    for (start, end) in [(2.0, 2.0), (3.0, 2.0), (8.0, 9.0), (7.0, 8.4)] {
        assert!(
            validate_clip(&start.to_string(), &end.to_string(), Some(8.0)).is_err(),
            "accepted {start} → {end}"
        );
    }
}
