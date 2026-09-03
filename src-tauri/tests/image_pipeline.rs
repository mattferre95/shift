//! The V1.1 image workflow against real files.
//!
//! Fixtures are generated at test time — a PNG from FFmpeg, converted to HEIC
//! by macOS itself — so no personal photos are needed or committed.

use shift_lib::media::image::{self, Compression, ImageStep};
use shift_lib::media::aspect::{AspectRatio, AspectSpec, FrameMode};
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
        image::build_plan(input, &probe.format, format, compression, probe.has_alpha, (probe.width, probe.height), &AspectSpec::default(), &work, &output).expect("plan");
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
        (probe.width, probe.height),
        &AspectSpec::default(),
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

// --------------------------------------------------------------- aspect

fn framed(
    input: &Path,
    format: OutputFormat,
    spec: &AspectSpec,
    name: &str,
) -> (u32, u32, bool) {
    let cancel = CancelToken::new();
    let probe = image::probe(input, &cancel).expect("probe");
    let work = workspace().join(format!("work-{name}"));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let output = work.join(format!("out.{}", format.ext()));

    let plan = image::build_plan(
        input,
        &probe.format,
        format,
        Compression::Balanced,
        probe.has_alpha,
        (probe.width, probe.height),
        spec,
        &work,
        &output,
    )
    .expect("plan");
    assert_eq!(plan.steps.len(), plan.labels.len(), "every step needs a label");

    for step in &plan.steps {
        let (bin, args) = match step {
            ImageStep::Sips(a) => (Binary::Sips, a),
            ImageStep::Ffmpeg(a) => (Binary::Ffmpeg, a),
        };
        let out = run_capture(bin, args, &cancel).unwrap();
        assert!(out.success, "{name}: step failed: {}", out.log());
    }
    assert!(output.is_file() && std::fs::metadata(&output).unwrap().len() > 0, "{name}: empty");

    let result = image::probe(&output, &cancel).expect("probe output");
    (result.width, result.height, result.has_alpha)
}

fn spec(ratio: AspectRatio, frame: FrameMode) -> AspectSpec {
    AspectSpec { ratio, frame, width: None, height: None }
}

#[test]
fn images_reframe_to_every_ratio() {
    // The shared fixture is 1200x800 — 3:2.
    let (_, jpg, _) = fixtures();
    let cases = [
        (AspectRatio::R1x1, FrameMode::Fill, (800, 800)),
        (AspectRatio::R9x16, FrameMode::Fill, (450, 800)),
        (AspectRatio::R16x9, FrameMode::Fill, (1200, 674)),
        (AspectRatio::R4x5, FrameMode::Fill, (640, 800)),
        (AspectRatio::R4x3, FrameMode::Fill, (1066, 800)),
    ];
    for (ratio, mode, want) in cases {
        let name = format!("img-{ratio:?}");
        let (w, h, _) = framed(&jpg, OutputFormat::Jpg, &spec(ratio, mode), &name);
        assert_eq!((w, h), want, "{ratio:?} {mode:?}");
    }
}

#[test]
fn image_fit_pads_instead_of_cropping() {
    let (_, jpg, _) = fixtures();
    let (w, h, _) = framed(&jpg, OutputFormat::Jpg, &spec(AspectRatio::R1x1, FrameMode::Fit), "img-fit");
    // A 1:1 fit of 1200x800 is a 1200x1200 canvas with the picture untouched.
    assert_eq!((w, h), (1200, 1200));
}

#[test]
fn image_original_is_untouched() {
    let (_, jpg, _) = fixtures();
    let (w, h, _) = framed(&jpg, OutputFormat::Jpg, &AspectSpec::default(), "img-orig");
    assert_eq!((w, h), (1200, 800));
}

#[test]
fn a_reframe_works_from_heic_through_the_same_pipeline() {
    let (heic, _, _) = fixtures();
    for format in [OutputFormat::Jpg, OutputFormat::Png, OutputFormat::Webp, OutputFormat::Avif] {
        let name = format!("heic-{}", format.ext());
        let (w, h, _) = framed(&heic, format, &spec(AspectRatio::R1x1, FrameMode::Fill), &name);
        assert_eq!((w, h), (800, 800), "{format:?}");
    }
}

#[test]
fn a_reframed_png_keeps_its_transparency() {
    let src = transparent_png();
    let cancel = CancelToken::new();
    assert!(image::probe(&src, &cancel).unwrap().has_alpha, "fixture precondition");

    // Fill crops, so only original pixels survive — alpha included.
    let (w, h, alpha) =
        framed(&src, OutputFormat::Png, &spec(AspectRatio::R9x16, FrameMode::Fill), "alpha-fill");
    assert_eq!((w, h), (224, 400));
    assert!(alpha, "a reframe must not flatten a PNG's transparency");

    // Fit adds black bars, but the source's own alpha still has to survive.
    let (_, _, alpha) =
        framed(&src, OutputFormat::Png, &spec(AspectRatio::R9x16, FrameMode::Fit), "alpha-fit");
    assert!(alpha, "padding must not flatten the picture's own transparency");
}

#[test]
fn a_reframed_webp_keeps_its_transparency() {
    let (_, _, alpha) = framed(
        &transparent_png(),
        OutputFormat::Webp,
        &spec(AspectRatio::R1x1, FrameMode::Fill),
        "alpha-webp",
    );
    assert!(alpha, "WEBP carries alpha and must keep it through a reframe");
}

#[test]
fn reframing_does_not_weaken_the_avif_transparency_safeguard() {
    // The reframe pass must not become a back door that launders a transparent
    // source into a format which cannot hold its alpha.
    let src = transparent_png();
    let probe = image::probe(&src, &CancelToken::new()).unwrap();
    let work = workspace().join("work-avif-guard");
    std::fs::create_dir_all(&work).unwrap();
    let err = image::build_plan(
        &src,
        &probe.format,
        OutputFormat::Avif,
        Compression::Balanced,
        probe.has_alpha,
        (probe.width, probe.height),
        &spec(AspectRatio::R1x1, FrameMode::Fill),
        &work,
        &work.join("o.avif"),
    )
    .unwrap_err();
    assert_eq!(err.code, "avif_alpha");
}

#[test]
fn a_freeform_image_size_is_exact_and_reports_an_upscale() {
    let (_, jpg, _) = fixtures();
    let down = AspectSpec {
        ratio: AspectRatio::Freeform,
        frame: FrameMode::Fill,
        width: Some(300),
        height: Some(300),
    };
    let (w, h, _) = framed(&jpg, OutputFormat::Png, &down, "img-free");
    assert_eq!((w, h), (300, 300));

    let up = AspectSpec { width: Some(2400), height: Some(1600), ..down };
    let r = shift_lib::media::aspect::resolve((1200, 800), &up).unwrap().unwrap();
    assert!(r.upscales, "asking for twice the pixels must be reported");
    let (w, h, _) = framed(&jpg, OutputFormat::Png, &up, "img-up");
    assert_eq!((w, h), (2400, 1600), "and still honoured, because it was typed");
}

#[test]
fn a_tiny_image_still_reframes_cleanly() {
    let tiny = workspace().join("tiny.png");
    if !tiny.is_file() {
        let args: Vec<String> = [
            "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "testsrc2=size=20x12", "-frames:v", "1",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(tiny.to_string_lossy().to_string()))
        .collect();
        assert!(run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap().success);
    }
    for mode in [FrameMode::Fill, FrameMode::Fit] {
        let name = format!("tiny-{mode:?}");
        let (w, h, _) = framed(&tiny, OutputFormat::Png, &spec(AspectRatio::R1x1, mode), &name);
        assert!(w >= 2 && h >= 2, "collapsed to {w}x{h}");
        assert_eq!(w, h, "1:1 should be square");
    }
}

#[test]
fn an_image_reframe_reuses_the_existing_conversion_rather_than_a_second_path() {
    // The reframe is a lossless pre-pass; the format's own encoder still does
    // the encoding, with the quality ladder it already had.
    let (_, jpg, _) = fixtures();
    let probe = image::probe(&jpg, &CancelToken::new()).unwrap();
    let work = workspace().join("work-compose");
    std::fs::create_dir_all(&work).unwrap();
    let plan = image::build_plan(
        &jpg,
        &probe.format,
        OutputFormat::Jpg,
        Compression::Strong,
        false,
        (probe.width, probe.height),
        &spec(AspectRatio::R1x1, FrameMode::Fill),
        &work,
        &work.join("o.jpg"),
    )
    .unwrap();

    // Reframe first, then the ordinary sips conversion carrying the quality.
    assert_eq!(plan.steps.len(), 2, "{:?}", plan.labels);
    assert!(matches!(plan.steps[0], ImageStep::Ffmpeg(_)), "the reframe pass");
    let ImageStep::Sips(args) = &plan.steps[1] else { panic!("expected the usual sips convert") };
    assert!(args.iter().any(|a| a == "65"), "Strong's quality must still be applied");
}

// -------------------------------------------------- fit padding colour

/// The RGBA of a corner pixel — the padded region for any Fit that pads.
fn corner_rgba(path: &Path) -> [u8; 4] {
    let raw = workspace().join(format!(
        "corner-{}.raw",
        path.file_name().unwrap().to_string_lossy().replace('.', "-")
    ));
    let args: Vec<String> = [
        "-y", "-loglevel", "error", "-i", &path.to_string_lossy(),
        "-vf", "format=rgba,crop=1:1:0:0", "-pix_fmt", "rgba", "-f", "rawvideo",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(raw.to_string_lossy().to_string()))
    .collect();
    let out = run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap();
    assert!(out.success, "could not read corner: {}", out.log());
    let bytes = std::fs::read(&raw).unwrap();
    [bytes[0], bytes[1], bytes[2], bytes[3]]
}

/// Run a plan and hand back the finished file, rather than only its size.
fn produce(input: &Path, format: OutputFormat, spec: &AspectSpec, name: &str) -> PathBuf {
    let cancel = CancelToken::new();
    let probe = image::probe(input, &cancel).expect("probe");
    let work = workspace().join(format!("work-{name}"));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let output = work.join(format!("out.{}", format.ext()));

    let plan = image::build_plan(
        input,
        &probe.format,
        format,
        Compression::None,
        probe.has_alpha,
        (probe.width, probe.height),
        spec,
        &work,
        &output,
    )
    .expect("plan");
    for step in &plan.steps {
        let (bin, args) = match step {
            ImageStep::Sips(a) => (Binary::Sips, a),
            ImageStep::Ffmpeg(a) => (Binary::Ffmpeg, a),
        };
        let out = run_capture(bin, args, &cancel).unwrap();
        assert!(out.success, "{name}: {}", out.log());
    }
    output
}

/// An opaque source, so any transparency in the result can only be padding.
fn opaque_wide() -> PathBuf {
    static P: OnceLock<PathBuf> = OnceLock::new();
    P.get_or_init(|| {
        let path = workspace().join("opaque.png");
        if !path.is_file() {
            let args: Vec<String> = [
                "-y", "-loglevel", "error", "-f", "lavfi",
                "-i", "color=c=red:s=400x200", "-frames:v", "1",
            ]
            .iter()
            .map(|s| s.to_string())
            .chain(std::iter::once(path.to_string_lossy().to_string()))
            .collect();
            assert!(run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap().success);
        }
        path
    })
    .clone()
}

#[test]
fn fit_pads_a_png_transparently() {
    let out = produce(&opaque_wide(), OutputFormat::Png, &spec(AspectRatio::R1x1, FrameMode::Fit), "pad-png");
    let c = corner_rgba(&out);
    assert_eq!(c[3], 0, "PNG padding should be transparent, got {c:?}");
    assert!(image::probe(&out, &CancelToken::new()).unwrap().has_alpha);
}

#[test]
fn fit_pads_a_webp_transparently() {
    let out = produce(&opaque_wide(), OutputFormat::Webp, &spec(AspectRatio::R1x1, FrameMode::Fit), "pad-webp");
    let c = corner_rgba(&out);
    assert_eq!(c[3], 0, "WEBP padding should be transparent, got {c:?}");
}

#[test]
fn fit_pads_a_jpg_with_opaque_black() {
    // JPEG has no alpha channel, so the only honest padding is a colour.
    let out = produce(&opaque_wide(), OutputFormat::Jpg, &spec(AspectRatio::R1x1, FrameMode::Fit), "pad-jpg");
    let c = corner_rgba(&out);
    assert_eq!(c[3], 255, "JPEG cannot be transparent");
    assert!(c[0] < 24 && c[1] < 24 && c[2] < 24, "padding should be black, got {c:?}");
}

#[test]
fn fit_pads_an_avif_opaquely() {
    // AVIF's canvas is opaque here for the same reason a transparent source is
    // refused: the bundled libaom-av1 has no alpha pixel format.
    let out = produce(&opaque_wide(), OutputFormat::Avif, &spec(AspectRatio::R1x1, FrameMode::Fit), "pad-avif");
    let c = corner_rgba(&out);
    assert_eq!(c[3], 255, "AVIF padding must be opaque");
    assert!(c[0] < 24 && c[1] < 24 && c[2] < 24, "padding should be black, got {c:?}");
}

#[test]
fn a_transparent_source_keeps_its_own_alpha_through_a_padded_fit() {
    // The picture's transparency and the padding are separate things: padding a
    // transparent PNG must not flatten the parts that were already see-through.
    let src = transparent_png();
    let out = produce(&src, OutputFormat::Png, &spec(AspectRatio::R9x16, FrameMode::Fit), "pad-alpha");
    assert!(image::probe(&out, &CancelToken::new()).unwrap().has_alpha);
    assert_eq!(corner_rgba(&out)[3], 0);
}

#[test]
fn the_avif_alpha_safeguard_still_refuses_a_transparent_source_when_padding() {
    let src = transparent_png();
    let probe = image::probe(&src, &CancelToken::new()).unwrap();
    let work = workspace().join("work-avif-pad-guard");
    std::fs::create_dir_all(&work).unwrap();
    for mode in [FrameMode::Fill, FrameMode::Fit] {
        let err = image::build_plan(
            &src,
            &probe.format,
            OutputFormat::Avif,
            Compression::Balanced,
            probe.has_alpha,
            (probe.width, probe.height),
            &spec(AspectRatio::R1x1, mode),
            &work,
            &work.join("o.avif"),
        )
        .unwrap_err();
        assert_eq!(err.code, "avif_alpha", "{mode:?}");
    }
}

#[test]
fn only_the_formats_that_can_hold_alpha_are_padded_transparently() {
    assert!(image::keeps_alpha(OutputFormat::Png));
    assert!(image::keeps_alpha(OutputFormat::Webp));
    assert!(!image::keeps_alpha(OutputFormat::Jpg));
    assert!(!image::keeps_alpha(OutputFormat::Avif));
}
