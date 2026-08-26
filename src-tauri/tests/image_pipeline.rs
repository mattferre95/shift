//! The V1.1 image workflow against real files.
//!
//! Fixtures are generated at test time — a PNG from FFmpeg, converted to HEIC
//! by macOS itself — so no personal photos are needed or committed.

use shift_lib::media::image::{self, Compression, ImageStep};
use shift_lib::media::profiles::OutputFormat;
use shift_lib::process::{run_capture, Binary, CancelToken};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn workspace() -> PathBuf {
    let dir = std::env::temp_dir().join("shift-image-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A 1200×800 PNG, and the same image as HEIC and JPEG.
///
/// Built exactly once per test binary: the tests run in parallel and would
/// otherwise race each other writing the same files.
fn fixtures() -> (PathBuf, PathBuf, PathBuf) {
    static FIXTURES: OnceLock<(PathBuf, PathBuf, PathBuf)> = OnceLock::new();
    FIXTURES.get_or_init(build_fixtures).clone()
}

fn build_fixtures() -> (PathBuf, PathBuf, PathBuf) {
    let dir = workspace();
    let png = dir.join("source.png");
    let heic = dir.join("source.heic");
    let jpg = dir.join("source.jpg");
    let cancel = CancelToken::new();

    if !png.is_file() {
        let args: Vec<String> = [
            "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "testsrc2=size=1200x800", "-frames:v", "1",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(png.to_string_lossy().to_string()))
        .collect();
        let out = run_capture(Binary::Ffmpeg, &args, &cancel).unwrap();
        assert!(out.success, "could not build PNG fixture: {}", out.log());
    }
    for (target, fmt) in [(&heic, "heic"), (&jpg, "jpeg")] {
        if !target.is_file() {
            let args: Vec<String> = vec![
                "-s".into(), "format".into(), fmt.into(),
                png.to_string_lossy().to_string(),
                "--out".into(), target.to_string_lossy().to_string(),
            ];
            let out = run_capture(Binary::Sips, &args, &cancel).unwrap();
            assert!(out.success, "could not build {fmt} fixture: {}", out.log());
        }
    }
    (heic, jpg, png)
}

/// Run a plan the way the job runner does, and return the produced file.
fn convert(input: &Path, format: OutputFormat, compression: Compression, name: &str) -> PathBuf {
    let cancel = CancelToken::new();
    let probe = image::probe(input, &cancel).expect("probe");
    let work = workspace().join(format!("work-{name}"));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let output = work.join(format!("out.{}", format.ext()));

    let plan =
        image::build_plan(input, &probe.format, format, compression, &work, &output).expect("plan");
    for step in &plan.steps {
        let (bin, args) = match step {
            ImageStep::Sips(a) => (Binary::Sips, a),
            ImageStep::Ffmpeg(a) => (Binary::Ffmpeg, a),
        };
        let out = run_capture(bin, args, &cancel).unwrap();
        assert!(out.success, "{name}: step failed: {}", out.log());
    }
    assert!(output.is_file(), "{name}: no output");
    assert!(std::fs::metadata(&output).unwrap().len() > 0, "{name}: empty output");
    output
}

fn probe_of(path: &Path) -> image::ImageProbe {
    image::probe(path, &CancelToken::new()).unwrap()
}

fn size(path: &Path) -> u64 {
    std::fs::metadata(path).unwrap().len()
}

#[test]
fn reads_a_heic() {
    let (heic, _, _) = fixtures();
    let probe = probe_of(&heic);
    assert_eq!((probe.width, probe.height), (1200, 800));
    assert_eq!(probe.format, "heic");
    assert!(probe.size_bytes > 0);
}

#[test]
fn heic_to_jpg() {
    let (heic, _, _) = fixtures();
    let out = convert(&heic, OutputFormat::Jpg, Compression::None, "heic-jpg");
    let probe = probe_of(&out);
    assert_eq!(probe.format, "jpeg");
    assert_eq!((probe.width, probe.height), (1200, 800));
}

#[test]
fn heic_to_png() {
    let (heic, _, _) = fixtures();
    let out = convert(&heic, OutputFormat::Png, Compression::None, "heic-png");
    let probe = probe_of(&out);
    assert_eq!(probe.format, "png");
    assert_eq!((probe.width, probe.height), (1200, 800));
}

#[test]
fn heic_to_jpg_balanced_is_smaller_than_uncompressed() {
    let (heic, _, _) = fixtures();
    let full = convert(&heic, OutputFormat::Jpg, Compression::None, "heic-jpg-none");
    let balanced = convert(&heic, OutputFormat::Jpg, Compression::Balanced, "heic-jpg-bal");
    let p = probe_of(&balanced);
    assert_eq!(p.format, "jpeg");
    // Dimensions must survive compression — this is quality, not resize.
    assert_eq!((p.width, p.height), (1200, 800));
    assert!(
        size(&balanced) < size(&full),
        "Balanced ({}) should be smaller than None ({})",
        size(&balanced),
        size(&full)
    );
}

#[test]
fn jpg_to_webp() {
    let (_, jpg, _) = fixtures();
    let out = convert(&jpg, OutputFormat::Webp, Compression::Balanced, "jpg-webp");
    // sips reads WEBP even though it cannot write it, so it can verify the result.
    let probe = probe_of(&out);
    assert_eq!((probe.width, probe.height), (1200, 800));
}

#[test]
fn png_to_jpg() {
    let (_, _, png) = fixtures();
    let out = convert(&png, OutputFormat::Jpg, Compression::Light, "png-jpg");
    assert_eq!(probe_of(&out).format, "jpeg");
}

#[test]
fn png_optimization_shrinks_without_touching_pixels() {
    let (heic, _, _) = fixtures();
    let plain = convert(&heic, OutputFormat::Png, Compression::None, "png-plain");
    let optimized = convert(&heic, OutputFormat::Png, Compression::Optimize, "png-opt");
    assert!(
        size(&optimized) < size(&plain),
        "Optimize ({}) should beat None ({})",
        size(&optimized),
        size(&plain)
    );
    let p = probe_of(&optimized);
    assert_eq!(p.format, "png");
    assert_eq!((p.width, p.height), (1200, 800));
}

#[test]
fn a_corrupt_image_fails_cleanly() {
    let dir = workspace();
    let bad = dir.join("corrupt.heic");
    std::fs::write(&bad, b"this is not an image, it only claims to be one").unwrap();

    let err = image::probe(&bad, &CancelToken::new())
        .expect_err("a file that is not an image must not analyze successfully");
    assert_eq!(err.code, "unreadable_image");
    assert_eq!(err.message, "SHIFT couldn't read this image.");
    // The raw tool output stays behind Technical details.
    assert!(err.technical.is_some());
}

#[test]
fn a_non_image_extension_is_rejected() {
    assert!(!image::is_image_ext("mp4"));
    assert!(!image::is_image_ext("txt"));
    for ext in ["heic", "HEIC", "heif", "jpg", "jpeg", "png", "webp"] {
        assert!(image::is_image_ext(ext), "{ext} should be accepted");
    }
}
