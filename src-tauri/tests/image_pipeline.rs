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
        image::build_plan(input, &probe.format, format, compression, probe.has_alpha, &work, &output).expect("plan");
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

// ----------------------------------------------------------------- avif

/// A PNG with a genuinely transparent region, for the alpha rules.
fn transparent_png() -> PathBuf {
    static P: OnceLock<PathBuf> = OnceLock::new();
    P.get_or_init(|| {
        let path = workspace().join("alpha.png");
        if !path.is_file() {
            let args: Vec<String> = [
                "-y", "-loglevel", "error", "-f", "lavfi",
                "-i", "color=c=red:s=400x400,format=rgba,geq=r='r(X,Y)':a='if(lt(hypot(X-200,Y-200),150),255,0)'",
                "-frames:v", "1",
            ]
            .iter()
            .map(|s| s.to_string())
            .chain(std::iter::once(path.to_string_lossy().to_string()))
            .collect();
            let out = run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap();
            assert!(out.success, "could not build alpha fixture: {}", out.log());
        }
        path
    })
    .clone()
}

#[test]
fn avif_is_produced_from_every_supported_source() {
    let (heic, jpg, png) = fixtures();
    for (src, name) in [(&heic, "avif-heic"), (&jpg, "avif-jpg"), (&png, "avif-png")] {
        let out = convert(src, OutputFormat::Avif, Compression::Balanced, name);
        // Not merely a file with the right extension.
        let sniff = std::fs::read(&out).unwrap();
        assert!(
            sniff.windows(4).any(|w| w == b"avif" || w == b"ftyp"),
            "{name}: not an ISO/AVIF container"
        );
    }
}

#[test]
fn avif_undercuts_webp_and_jpeg_at_the_same_rung() {
    let (_, jpg, _) = fixtures();
    let avif = convert(&jpg, OutputFormat::Avif, Compression::Balanced, "cmp-avif");
    let webp = convert(&jpg, OutputFormat::Webp, Compression::Balanced, "cmp-webp");

    let (a, w) = (
        std::fs::metadata(&avif).unwrap().len(),
        std::fs::metadata(&webp).unwrap().len(),
    );
    assert!(a < w, "AVIF ({a}) should undercut WEBP ({w}); that is the reason it exists");
}

#[test]
fn avif_encodes_a_large_photo_fast_enough_to_stay_interactive() {
    // libaom's default effort takes ~20s on a 12 MP image, which would make the
    // app look hung. `-cpu-used 6` is what keeps this honest, so it is worth a
    // regression test rather than a comment.
    let big = workspace().join("big.png");
    if !big.is_file() {
        let args: Vec<String> = [
            "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "testsrc2=size=4032x3024", "-frames:v", "1",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(big.to_string_lossy().to_string()))
        .collect();
        assert!(run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap().success);
    }
    let started = std::time::Instant::now();
    convert(&big, OutputFormat::Avif, Compression::Balanced, "avif-big");
    let elapsed = started.elapsed();
    assert!(elapsed.as_secs() < 12, "12 MP AVIF took {elapsed:?}; the speed preset has regressed");
}

#[test]
fn a_transparent_source_keeps_its_alpha_or_is_refused() {
    let src = transparent_png();
    let probe = image::probe(&src, &CancelToken::new()).expect("probe");
    assert!(probe.has_alpha, "sips should report transparency on this fixture");

    // AVIF cannot carry it, so it must not be offered...
    let offered = shift_lib::media::profiles::image_options(probe.has_alpha);
    assert!(!offered.contains(&OutputFormat::Avif), "AVIF must be withheld for a transparent source");
    // ...and must refuse it even if asked directly.
    let work = workspace().join("work-alpha");
    std::fs::create_dir_all(&work).unwrap();
    assert!(image::build_plan(
        &src,
        &probe.format,
        OutputFormat::Avif,
        Compression::Balanced,
        probe.has_alpha,
        &work,
        &work.join("o.avif"),
    )
    .is_err());

    // WEBP does carry it, and must actually preserve it end to end.
    let webp = convert(&src, OutputFormat::Webp, Compression::Balanced, "alpha-webp");
    let out = run_capture(
        Binary::Ffprobe,
        &[
            "-v".into(), "error".into(), "-select_streams".into(), "v:0".into(),
            "-show_entries".into(), "stream=pix_fmt".into(), "-of".into(), "csv=p=0".into(),
            webp.to_string_lossy().to_string(),
        ],
        &CancelToken::new(),
    )
    .unwrap();
    assert!(out.stdout.trim().contains("yuva"), "WEBP dropped alpha: {}", out.stdout.trim());
}
