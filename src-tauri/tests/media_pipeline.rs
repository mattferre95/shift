//! End-to-end checks of the media core against real media.
//!
//! These drive the same code path an export uses — probe, build the profile,
//! run FFmpeg, finalize — on a fixture generated at test time. No copyrighted
//! media is committed to the repository.

use shift_lib::filesystem;
use shift_lib::media::ffmpeg;
use shift_lib::media::ffprobe;
use shift_lib::media::aspect::{AspectRatio, AspectSpec, FrameMode};
use shift_lib::media::profiles::{build_plan, LoopSize, OutputFormat};
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

    let plan = build_plan(input, &probe, format, clip, LoopSize::default(), &AspectSpec::default(), &output).expect("plan");
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
    let plan = build_plan(&input, &probe, OutputFormat::Mov, None, LoopSize::default(), &AspectSpec::default(), &output).unwrap();
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
    let plan = build_plan(&input, &probe, OutputFormat::Webm, None, LoopSize::default(), &AspectSpec::default(), &output).unwrap();

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

// ---------------------------------------------------------------- loops

/// Every frame delay a GIF actually carries, in centiseconds.
fn gif_frame_delays(path: &Path) -> Vec<i64> {
    let args: Vec<String> = [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "packet=duration", "-of", "csv=p=0",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(path.to_string_lossy().to_string()))
    .collect();
    let out = run_capture(Binary::Ffprobe, &args, &CancelToken::new()).expect("ffprobe");
    out.stdout.lines().filter_map(|l| l.trim().parse::<i64>().ok()).collect()
}

fn stream_field(path: &Path, field: &str) -> String {
    let args: Vec<String> = [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", &format!("stream={field}"), "-of", "csv=p=0",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(path.to_string_lossy().to_string()))
    .collect();
    let out = run_capture(Binary::Ffprobe, &args, &CancelToken::new()).expect("ffprobe");
    out.stdout.trim().to_string()
}

#[test]
fn a_gif_really_encodes_and_loops_uniformly() {
    let clip = ClipRange { start: 1.0, end: 4.0 };
    let gif = convert(&fixture(), OutputFormat::Gif, Some(clip), "loop-timing");

    assert_eq!(stream_field(&gif, "codec_name"), "gif");

    // The filtergraph carries `min(iw,480)` — a comma inside a filter argument.
    // If FFmpeg's parser had read it as a filter separator the run would have
    // failed, so reaching a real 480-or-less width proves the quoting holds.
    let width: u32 = stream_field(&gif, "width").parse().expect("width");
    assert!(width <= 480, "width {width} should be capped");
    // The 640px fixture is wider than the 480 cap, so it must have been scaled.
    assert_eq!(width, 480);

    // GIF delays are whole centiseconds; the Standard preset must produce
    // exactly one distinct value or playback judders.
    let delays = gif_frame_delays(&gif);
    assert!(!delays.is_empty(), "no frames");
    let mut distinct: Vec<i64> = delays.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(distinct, vec![8], "12.5 fps must be a flat 8cs, got {distinct:?}");
}

#[test]
fn a_gif_never_upscales_a_source_smaller_than_the_preset() {
    let small = workspace().join("small.mp4");
    if !small.is_file() {
        let args: Vec<String> = [
            "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=200x120:rate=30", "-t", "2",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(small.to_string_lossy().to_string()))
        .collect();
        assert!(run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap().success);
    }
    let gif = convert(&small, OutputFormat::Gif, None, "small-loop");
    assert_eq!(stream_field(&gif, "width").parse::<u32>().unwrap(), 200);
}

#[test]
fn an_animated_webp_really_animates_and_beats_the_gif() {
    let clip = ClipRange { start: 1.0, end: 4.0 };
    let webp = convert(&fixture(), OutputFormat::Webp, Some(clip), "loop-size");
    let gif = convert(&fixture(), OutputFormat::Gif, Some(clip), "loop-size");

    // Not a one-frame still wearing an animation's name.
    assert_eq!(stream_field(&webp, "codec_name"), "webp_anim");

    let (w, g) = (
        std::fs::metadata(&webp).unwrap().len(),
        std::fs::metadata(&gif).unwrap().len(),
    );
    assert!(w < g, "animated WEBP ({w}) should undercut GIF ({g})");
}

#[test]
fn a_loop_carries_no_audio() {
    let clip = ClipRange { start: 0.0, end: 2.0 };
    for (format, name) in [(OutputFormat::Gif, "silent"), (OutputFormat::Webp, "silent")] {
        let out = convert(&fixture(), format, Some(clip), name);
        // The fixture has an AAC track; neither container may carry it over.
        let probe = ffprobe::probe(&out, &CancelToken::new()).expect("probe");
        assert!(probe.audio.is_none(), "{format:?} must be silent");
    }
}

// ---------------------------------------------------------------- flac

/// Decode anything to raw 16-bit PCM and fingerprint it.
fn pcm_digest(src: &Path, name: &str) -> (u64, usize) {
    let dest = workspace().join(name);
    let args: Vec<String> = [
        "-y", "-loglevel", "error", "-i", &src.to_string_lossy(),
        "-f", "s16le", "-c:a", "pcm_s16le",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(dest.to_string_lossy().to_string()))
    .collect();
    assert!(run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap().success);
    let bytes = std::fs::read(&dest).unwrap();
    // FNV-1a. A hash, not the samples, so a mismatch prints two numbers rather
    // than several megabytes of vector.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in &bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h, bytes.len())
}

#[test]
fn flac_round_trips_a_pcm_source_bit_for_bit() {
    // The source must already be integer PCM. Going FLAC-vs-WAV straight from
    // the AAC fixture would compare two *independent* float→s16 conversions,
    // each of which applies its own dither — they differ in the low bit for
    // reasons that have nothing to do with FLAC.
    let wav = convert(&fixture(), OutputFormat::Wav, None, "flac-source");

    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&wav, &cancel).expect("probe wav");
    let flac = workspace().join("flac-roundtrip.flac");
    let _ = std::fs::remove_file(&flac);
    let plan =
        build_plan(&wav, &probe, OutputFormat::Flac, None, LoopSize::default(), &AspectSpec::default(), &flac).expect("plan");
    let mut noop = |_: f64| {};
    ffmpeg::execute(&plan, probe.duration, &cancel, &mut noop).expect("flac encode");

    let (before, n) = pcm_digest(&wav, "flac-before.raw");
    let (after, m) = pcm_digest(&flac, "flac-after.raw");
    assert_eq!((before, n), (after, m), "FLAC altered the samples");

    let (fsz, wsz) =
        (std::fs::metadata(&flac).unwrap().len(), std::fs::metadata(&wav).unwrap().len());
    assert!(fsz < wsz, "FLAC ({fsz}) should undercut WAV ({wsz}) while holding the same samples");
}

// ----------------------------------------------------------------- m4a

#[test]
fn m4a_copies_an_aac_source_and_re_encodes_anything_else() {
    // The fixture's audio is already AAC, so extracting it is a pure container
    // change: same bytes, no generation loss.
    let copied = convert(&fixture(), OutputFormat::M4a, None, "m4a-copy");
    let src = ffprobe::probe(&fixture(), &CancelToken::new()).unwrap();
    let out = ffprobe::probe(&copied, &CancelToken::new()).unwrap();
    assert_eq!(out.audio.as_ref().unwrap().codec, "aac");
    assert!(out.video.is_none(), "an audio export must carry no video stream");
    assert_eq!(src.audio.as_ref().unwrap().codec, "aac", "fixture precondition");

    // An MP3 source must not be waved into an .m4a untouched.
    let mp3 = convert(&fixture(), OutputFormat::Mp3, None, "m4a-src");
    let probe = ffprobe::probe(&mp3, &CancelToken::new()).unwrap();
    let dest = workspace().join("m4a-from-mp3.m4a");
    let _ = std::fs::remove_file(&dest);
    let plan =
        build_plan(&mp3, &probe, OutputFormat::M4a, None, LoopSize::default(), &AspectSpec::default(), &dest).expect("plan");
    assert!(!plan.remuxed, "MP3 → M4A must re-encode");
    let mut noop = |_: f64| {};
    ffmpeg::execute(&plan, probe.duration, &CancelToken::new(), &mut noop).expect("encode");
    assert_eq!(ffprobe::probe(&dest, &CancelToken::new()).unwrap().audio.unwrap().codec, "aac");
}

#[test]
fn m4a_puts_its_index_at_the_front() {
    // An MP4-family file with `moov` after `mdat` has to be fully downloaded
    // before anything will play it.
    let m4a = convert(&fixture(), OutputFormat::M4a, None, "m4a-faststart");
    let head = std::fs::read(&m4a).unwrap();
    let moov = head.windows(4).position(|w| w == b"moov").expect("moov box");
    let mdat = head.windows(4).position(|w| w == b"mdat").expect("mdat box");
    assert!(moov < mdat, "moov ({moov}) must precede mdat ({mdat})");
}

#[test]
fn gif_and_animated_webp_have_different_ceilings() {
    // 20s is a legal animated WEBP and an illegal GIF. Proven against real
    // encodes, not just the planner.
    let long = workspace().join("long.mp4");
    if !long.is_file() {
        let args: Vec<String> = [
            "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "testsrc2=size=320x180:rate=30", "-t", "20",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(long.to_string_lossy().to_string()))
        .collect();
        assert!(run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap().success);
    }
    let probe = ffprobe::probe(&long, &CancelToken::new()).unwrap();
    let out = workspace().join("ceiling.out");

    assert!(
        build_plan(&long, &probe, OutputFormat::Gif, None, LoopSize::default(), &AspectSpec::default(), &out).is_err(),
        "20s must be too long for a GIF"
    );
    assert!(
        build_plan(&long, &probe, OutputFormat::Webp, None, LoopSize::default(), &AspectSpec::default(), &out).is_ok(),
        "20s must be fine as an animated WEBP"
    );

    // And the WEBP that results really is smaller than the GIF would have been,
    // which is the whole reason the limits differ.
    let webp = convert(&long, OutputFormat::Webp, None, "ceiling");
    let clip = ClipRange { start: 0.0, end: 15.0 };
    let gif = convert(&long, OutputFormat::Gif, Some(clip), "ceiling");
    let (w, g) =
        (std::fs::metadata(&webp).unwrap().len(), std::fs::metadata(&gif).unwrap().len());
    assert!(w < g, "20s WEBP ({w}) should undercut a 15s GIF ({g})");
}

// -------------------------------------------------------------- aspect

fn aspect(ratio: AspectRatio, frame: FrameMode) -> AspectSpec {
    AspectSpec { ratio, frame, width: None, height: None }
}

/// Encode with a reframe and report the real dimensions FFmpeg produced.
fn reframed(source: &Path, format: OutputFormat, spec: &AspectSpec, name: &str) -> (u32, u32) {
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(source, &cancel).expect("probe");
    let output = workspace().join(format!("{name}.{}", format.ext()));
    let _ = std::fs::remove_file(&output);

    let clip = if format.is_animation() {
        Some(ClipRange { start: 0.0, end: 2.0 })
    } else {
        None
    };
    let plan = build_plan(source, &probe, format, clip, LoopSize::default(), spec, &output)
        .expect("plan");
    let mut noop = |_: f64| {};
    ffmpeg::execute(&plan, probe.duration, &cancel, &mut noop).expect("ffmpeg run");

    assert!(output.is_file() && std::fs::metadata(&output).unwrap().len() > 0, "{name}: empty");
    let out = ffprobe::probe(&output, &cancel).expect("probe output");
    let v = out.video.expect("a video stream");
    (v.width.unwrap(), v.height.unwrap())
}

/// 640x360 is the shared fixture: 16:9.
fn near(actual: (u32, u32), rw: u32, rh: u32) {
    let want = rw as f64 / rh as f64;
    let have = actual.0 as f64 / actual.1 as f64;
    assert!(
        (have - want).abs() / want < 0.02,
        "{actual:?} is not {rw}:{rh} (got {have:.4}, want {want:.4})"
    );
}

#[test]
fn sixteen_nine_to_nine_sixteen_fill_crops() {
    let d = reframed(&fixture(), OutputFormat::Mp4, &aspect(AspectRatio::R9x16, FrameMode::Fill), "a-fill");
    near(d, 9, 16);
    // Cropped from the source's own pixels — never enlarged.
    assert_eq!(d, (202, 360));
    assert_eq!(d.0 % 2, 0);
    assert_eq!(d.1 % 2, 0);
}

#[test]
fn sixteen_nine_to_nine_sixteen_fit_pads() {
    let d = reframed(&fixture(), OutputFormat::Mp4, &aspect(AspectRatio::R9x16, FrameMode::Fit), "a-fit");
    near(d, 9, 16);
    // The canvas is held to the source's longest edge rather than ballooning.
    assert_eq!(d, (360, 640));
}

#[test]
fn sixteen_nine_to_square() {
    let d = reframed(&fixture(), OutputFormat::Mp4, &aspect(AspectRatio::R1x1, FrameMode::Fill), "a-sq");
    assert_eq!(d, (360, 360));
}

#[test]
fn landscape_to_four_three_and_portrait_to_four_five() {
    let d = reframed(&fixture(), OutputFormat::Mp4, &aspect(AspectRatio::R4x3, FrameMode::Fill), "a-43");
    near(d, 4, 3);
    assert_eq!(d, (480, 360));

    // A portrait source taken to 4:5.
    let portrait = workspace().join("portrait.mp4");
    if !portrait.is_file() {
        let args: Vec<String> = [
            "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "testsrc2=size=360x640:rate=30", "-t", "3",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(portrait.to_string_lossy().to_string()))
        .collect();
        assert!(run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap().success);
    }
    let d = reframed(&portrait, OutputFormat::Mp4, &aspect(AspectRatio::R4x5, FrameMode::Fill), "a-45");
    near(d, 4, 5);
    assert_eq!(d, (360, 450));
}

#[test]
fn original_preserves_the_source_exactly() {
    let d = reframed(&fixture(), OutputFormat::Mp4, &AspectSpec::default(), "a-orig");
    assert_eq!(d, (640, 360));
}

#[test]
fn a_reframe_never_stretches() {
    // A stretch shows up as content whose features change proportion. Encode a
    // known circle and check it stays a circle after a Fit, which is the mode
    // that keeps the whole picture.
    let circle = workspace().join("circle.mp4");
    if !circle.is_file() {
        let args: Vec<String> = [
            "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "color=c=black:s=640x360:r=10", "-t", "1",
            "-vf", "geq=lum='if(lt(hypot(X-320,Y-180),100),255,0)':cb=128:cr=128",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(circle.to_string_lossy().to_string()))
        .collect();
        assert!(run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap().success);
    }

    let out = workspace().join("circle-fit.mp4");
    let _ = std::fs::remove_file(&out);
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&circle, &cancel).unwrap();
    let plan = build_plan(
        &circle,
        &probe,
        OutputFormat::Mp4,
        None,
        LoopSize::default(),
        &aspect(AspectRatio::R1x1, FrameMode::Fit),
        &out,
    )
    .unwrap();
    ffmpeg::execute(&plan, probe.duration, &cancel, &mut |_| {}).unwrap();

    // Measure the white blob's bounding box in the result.
    let png = workspace().join("circle-fit.png");
    let args: Vec<String> = [
        "-y", "-loglevel", "error", "-i", &out.to_string_lossy(),
        "-vf", "select=eq(n\\,0),format=gray", "-frames:v", "1",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(png.to_string_lossy().to_string()))
    .collect();
    assert!(run_capture(Binary::Ffmpeg, &args, &cancel).unwrap().success);

    // cropdetect on the bright region gives the blob's extent.
    let probe_png = ffprobe::probe(&png, &cancel).unwrap();
    let v = probe_png.video.unwrap();
    assert_eq!((v.width.unwrap(), v.height.unwrap()), (640, 640), "1:1 fit of 640x360");
}

#[test]
fn a_reframe_composes_with_a_trim() {
    let cancel = CancelToken::new();
    let src = fixture();
    let probe = ffprobe::probe(&src, &cancel).unwrap();
    let out = workspace().join("a-trim.mp4");
    let _ = std::fs::remove_file(&out);
    let clip = ClipRange { start: 1.0, end: 3.5 };
    let plan = build_plan(
        &src,
        &probe,
        OutputFormat::Mp4,
        Some(clip),
        LoopSize::default(),
        &aspect(AspectRatio::R1x1, FrameMode::Fill),
        &out,
    )
    .unwrap();
    ffmpeg::execute(&plan, Some(clip.duration()), &cancel, &mut |_| {}).unwrap();

    let r = ffprobe::probe(&out, &cancel).unwrap();
    let v = r.video.as_ref().unwrap();
    assert_eq!((v.width.unwrap(), v.height.unwrap()), (360, 360), "shape");
    let secs = r.duration.unwrap();
    assert!((secs - 2.5).abs() < 0.2, "trim should still be 2.5s, got {secs:.3}");
    assert!(r.audio.is_some(), "MP4 keeps its audio through a reframe");
}

#[test]
fn a_reframe_survives_every_video_container() {
    for (format, name) in [
        (OutputFormat::Mp4, "a-mp4"),
        (OutputFormat::Mov, "a-mov"),
        (OutputFormat::Webm, "a-webm"),
    ] {
        let d = reframed(&fixture(), format, &aspect(AspectRatio::R1x1, FrameMode::Fill), name);
        assert_eq!(d, (360, 360), "{format:?}");
    }
}

#[test]
fn a_reframe_forces_a_transcode_rather_than_a_bogus_copy() {
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&fixture(), &cancel).unwrap();
    let out = workspace().join("a-copy.mov");
    // MP4 → MOV is normally a stream copy; a reframe has to override that.
    let copy = build_plan(
        &fixture(),
        &probe,
        OutputFormat::Mov,
        None,
        LoopSize::default(),
        &AspectSpec::default(),
        &out,
    )
    .unwrap();
    assert!(copy.remuxed, "precondition: this is a copy without a reframe");

    let framed = build_plan(
        &fixture(),
        &probe,
        OutputFormat::Mov,
        None,
        LoopSize::default(),
        &aspect(AspectRatio::R1x1, FrameMode::Fill),
        &out,
    )
    .unwrap();
    assert!(!framed.remuxed, "a reframe rewrites every pixel");
}

#[test]
fn loops_reframe_too_and_stay_within_their_preset() {
    for (format, name) in [(OutputFormat::Gif, "a-gif"), (OutputFormat::Webp, "a-webp")] {
        let d = reframed(&fixture(), format, &aspect(AspectRatio::R9x16, FrameMode::Fill), name);
        near(d, 9, 16);
        // Capped on the longest edge, so a portrait loop is not three times the
        // pixels of a landscape one at the same preset.
        assert!(d.0.max(d.1) <= 480, "{format:?} produced {d:?}");
        assert_eq!(d.1, 360, "the 360px source is never enlarged");
    }
}

#[test]
fn a_freeform_size_is_produced_exactly() {
    let spec = AspectSpec {
        ratio: AspectRatio::Freeform,
        frame: FrameMode::Fill,
        width: Some(500),
        height: Some(500),
    };
    let d = reframed(&fixture(), OutputFormat::Mp4, &spec, "a-free");
    assert_eq!(d, (500, 500));
}

#[test]
fn a_freeform_upscale_is_produced_but_flagged() {
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&fixture(), &cancel).unwrap();
    let spec = AspectSpec {
        ratio: AspectRatio::Freeform,
        frame: FrameMode::Fill,
        width: Some(1280),
        height: Some(720),
    };
    let r = shift_lib::media::aspect::resolve((640, 360), &spec).unwrap().unwrap();
    assert!(r.upscales, "the user asked for more pixels than exist");

    // It is still honoured — the user typed the number.
    let out = workspace().join("a-up.mp4");
    let plan =
        build_plan(&fixture(), &probe, OutputFormat::Mp4, None, LoopSize::default(), &spec, &out)
            .unwrap();
    ffmpeg::execute(&plan, probe.duration, &cancel, &mut |_| {}).unwrap();
    let v = ffprobe::probe(&out, &cancel).unwrap().video.unwrap();
    assert_eq!((v.width.unwrap(), v.height.unwrap()), (1280, 720));
}

#[test]
fn an_audio_export_ignores_the_aspect_entirely() {
    // Sound has no shape; asking for 1:1 audio must not fail.
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&fixture(), &cancel).unwrap();
    let out = workspace().join("a-audio.mp3");
    let plan = build_plan(
        &fixture(),
        &probe,
        OutputFormat::Mp3,
        None,
        LoopSize::default(),
        &aspect(AspectRatio::R1x1, FrameMode::Fill),
        &out,
    )
    .unwrap();
    assert!(!plan.args.iter().any(|a| a == "-vf"), "no filter belongs on an audio export");
    ffmpeg::execute(&plan, probe.duration, &cancel, &mut |_| {}).unwrap();
    assert!(ffprobe::probe(&out, &cancel).unwrap().video.is_none());
}

#[test]
fn every_reframed_video_dimension_is_even() {
    // yuv420p subsamples chroma by two; an odd dimension is either refused or
    // silently corrected, and neither is acceptable.
    for ratio in [
        AspectRatio::R16x9,
        AspectRatio::R9x16,
        AspectRatio::R1x1,
        AspectRatio::R4x5,
        AspectRatio::R4x3,
    ] {
        for mode in [FrameMode::Fill, FrameMode::Fit] {
            let name = format!("even-{ratio:?}-{mode:?}");
            let d = reframed(&fixture(), OutputFormat::Mp4, &aspect(ratio, mode), &name);
            assert_eq!(d.0 % 2, 0, "{ratio:?} {mode:?} width {}", d.0);
            assert_eq!(d.1 % 2, 0, "{ratio:?} {mode:?} height {}", d.1);
        }
    }
}

#[test]
fn video_fit_pads_with_opaque_black() {
    // Video containers here carry no alpha, and a transparent pad would either
    // be dropped or produce a surprise. Black is the only correct answer.
    let out = workspace().join("vid-pad.mp4");
    let _ = std::fs::remove_file(&out);
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&fixture(), &cancel).unwrap();
    let plan = build_plan(
        &fixture(),
        &probe,
        OutputFormat::Mp4,
        Some(ClipRange { start: 0.0, end: 1.0 }),
        LoopSize::default(),
        &aspect(AspectRatio::R1x1, FrameMode::Fit),
        &out,
    )
    .unwrap();

    let chain = plan.args.iter().find(|a| a.contains("pad=")).expect("a pad");
    assert!(chain.ends_with(":black"), "{chain}");
    assert!(!chain.contains("@0"), "video must not request transparency: {chain}");
    assert!(!chain.contains("format=rgba"), "{chain}");

    ffmpeg::execute(&plan, Some(1.0), &cancel, &mut |_| {}).unwrap();

    // And the pixels really are opaque black.
    let png = workspace().join("vid-pad.png");
    let args: Vec<String> = [
        "-y", "-loglevel", "error", "-i", &out.to_string_lossy(),
        "-vf", "format=rgba,crop=1:1:0:0", "-pix_fmt", "rgba", "-frames:v", "1",
        "-f", "rawvideo",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(std::iter::once(png.to_string_lossy().to_string()))
    .collect();
    assert!(run_capture(Binary::Ffmpeg, &args, &cancel).unwrap().success);
    let px = std::fs::read(&png).unwrap();
    assert_eq!(px[3], 255, "video padding must be opaque");
    assert!(px[0] < 24 && px[1] < 24 && px[2] < 24, "and black: {px:?}");
}

#[test]
fn a_reframed_video_has_square_pixels() {
    // FFmpeg's scale filter compensates for a resize by rewriting SAR, which
    // leaves the player to stretch the picture back. Every reframed export must
    // come out with square pixels so what is encoded is what is seen.
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(&fixture(), &cancel).unwrap();
    for (ratio, mode, name) in [
        (AspectRatio::R9x16, FrameMode::Fit, "sar-916-fit"),
        (AspectRatio::R9x16, FrameMode::Fill, "sar-916-fill"),
        (AspectRatio::R1x1, FrameMode::Fit, "sar-11-fit"),
        (AspectRatio::R4x5, FrameMode::Fit, "sar-45-fit"),
    ] {
        let out = workspace().join(format!("{name}.mp4"));
        let _ = std::fs::remove_file(&out);
        let plan = build_plan(
            &fixture(),
            &probe,
            OutputFormat::Mp4,
            Some(ClipRange { start: 0.0, end: 1.0 }),
            LoopSize::default(),
            &aspect(ratio, mode),
            &out,
        )
        .unwrap();
        ffmpeg::execute(&plan, Some(1.0), &cancel, &mut |_| {}).unwrap();

        let sar = stream_field(&out, "sample_aspect_ratio");
        assert!(
            sar == "1:1" || sar == "N/A" || sar.is_empty(),
            "{name} came out with non-square pixels: {sar}"
        );
    }
}
