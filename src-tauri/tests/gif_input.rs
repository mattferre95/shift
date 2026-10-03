//! Animated GIF as a source.
//!
//! Fixtures are written byte for byte by `write_gif` below rather than through
//! FFmpeg's GIF muxer, which snaps frame delays to its own grid: asked for
//! 10/50/20/100/30/7 centiseconds it wrote 12/48/20/100/32/4/4. A timing test is
//! only worth something if the delays it asserts are the ones in the file.

use shift_lib::jobs::InputSpec;
use shift_lib::media::aspect::{self, AspectRatio, AspectSpec, FrameMode};
use shift_lib::media::playback::PlaybackRegistry;
use shift_lib::media::profiles::{build_plan, options_for, LoopSize, OutputFormat};
use shift_lib::media::{ffmpeg, ffprobe, image};
use shift_lib::process::{run_capture, Binary, CancelToken};
use shift_lib::validation::ClipRange;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const PALETTE: [[u8; 3]; 8] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
    [0, 0, 0],
];
const RED: usize = 0;
const GREEN: usize = 1;
const BLUE: usize = 2;
const YELLOW: usize = 3;
const BLACK: usize = 7;

/// Six solid frames, deliberately uneven: 0.10 0.50 0.20 1.00 0.30 0.07s.
const DELAYS: [u16; 6] = [10, 50, 20, 100, 30, 7];
const TOTAL: f64 = 2.17;

struct Frame {
    delay: u16,
    transparent: bool,
    pixel: Box<dyn Fn(u16, u16) -> u8>,
}

/// A GIF89a with an 8-colour table, exactly the delays given, and palette
/// index 7 as the transparent colour when a frame asks for transparency.
fn write_gif(path: &Path, w: u16, h: u16, frames: &[Frame]) {
    let mut out: Vec<u8> = b"GIF89a".to_vec();
    out.extend(w.to_le_bytes());
    out.extend(h.to_le_bytes());
    out.extend([0xF2, BLACK as u8, 0]);
    for c in PALETTE {
        out.extend(c);
    }
    out.extend(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00");
    for f in frames {
        out.extend([0x21, 0xF9, 0x04, (2 << 2) | f.transparent as u8]);
        out.extend(f.delay.to_le_bytes());
        out.extend([BLACK as u8, 0]);
        out.push(0x2C);
        out.extend([0, 0, 0, 0]);
        out.extend(w.to_le_bytes());
        out.extend(h.to_le_bytes());
        out.push(0);
        out.push(3);
        // "Uncompressed" LZW: every pixel a literal 4-bit code, with a clear
        // code every four so the table never grows and the width never changes.
        let mut codes = vec![8u16];
        let mut n = 0usize;
        for y in 0..h {
            for x in 0..w {
                codes.push((f.pixel)(x, y) as u16);
                n += 1;
                if n % 4 == 0 {
                    codes.push(8);
                }
            }
        }
        codes.push(9);
        let (mut acc, mut bits, mut data) = (0u32, 0u32, Vec::new());
        for c in codes {
            acc |= (c as u32) << bits;
            bits += 4;
            while bits >= 8 {
                data.push(acc as u8);
                acc >>= 8;
                bits -= 8;
            }
        }
        if bits > 0 {
            data.push(acc as u8);
        }
        for chunk in data.chunks(255) {
            out.push(chunk.len() as u8);
            out.extend(chunk);
        }
        out.push(0);
    }
    out.push(0x3B);
    std::fs::write(path, out).unwrap();
}

/// A fresh directory per call: these tests run in parallel.
fn scratch(name: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join("shift-gif-tests").join(format!(
        "{name}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 161x121 — odd on purpose, because yuv420p is not.
fn timed_gif(dir: &Path) -> PathBuf {
    let path = dir.join("timed.gif");
    let frames: Vec<Frame> = DELAYS
        .iter()
        .enumerate()
        .map(|(i, &delay)| Frame { delay, transparent: false, pixel: Box::new(move |_, _| i as u8) })
        .collect();
    write_gif(&path, 161, 121, &frames);
    path
}

/// An opaque red square moving across nothing.
fn transparent_gif(dir: &Path) -> PathBuf {
    let path = dir.join("clear.gif");
    let frames: Vec<Frame> = (0..3u16)
        .map(|i| Frame {
            delay: 20,
            transparent: true,
            pixel: Box::new(move |x, y| {
                let left = 20 + i * 30;
                if x >= left && x < left + 40 && (40..80).contains(&y) {
                    RED as u8
                } else {
                    BLACK as u8
                }
            }),
        })
        .collect();
    write_gif(&path, 161, 121, &frames);
    path
}

fn strs(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

fn ffprobe_out(path: &Path, args: &[&str]) -> String {
    let mut a = strs(&["-v", "error"]);
    a.extend(strs(args));
    a.push(path.to_string_lossy().into_owned());
    let out = run_capture(Binary::Ffprobe, &a, &CancelToken::new()).unwrap();
    assert!(out.success, "{}", out.log());
    out.stdout.trim().to_string()
}

fn ffmpeg_ok(args: Vec<String>) {
    let out = run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap();
    assert!(out.success, "{}", out.log());
}

fn nearest(px: &[u8]) -> usize {
    (0..PALETTE.len())
        .min_by_key(|&k| {
            PALETTE[k].iter().zip(px).map(|(a, b)| (*a as i32 - *b as i32).pow(2)).sum::<i32>()
        })
        .unwrap()
}

/// Every frame a file presents: when it starts, and its colour at (x, y).
fn frames_shown(path: &Path, x: u32, y: u32) -> Vec<(f64, usize)> {
    let pts: Vec<f64> = ffprobe_out(
        path,
        &["-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "default=nw=1:nk=1"],
    )
    .lines()
    .filter_map(|l| l.trim().parse().ok())
    .collect();
    let raw = path.with_extension("px.raw");
    let vf = format!("format=rgb24,crop=1:1:{x}:{y}");
    ffmpeg_ok(strs(&[
        "-y", "-v", "error", "-i", &path.to_string_lossy(), "-vf", &vf,
        "-fps_mode", "passthrough", "-f", "rawvideo", &raw.to_string_lossy(),
    ]));
    let colours: Vec<usize> = std::fs::read(&raw).unwrap().chunks(3).map(nearest).collect();
    assert_eq!(pts.len(), colours.len(), "{path:?}: timestamps and frames disagree");
    pts.into_iter().zip(colours).collect()
}

/// The colour actually on screen at `t`: the last frame that has started.
fn shown_at(frames: &[(f64, usize)], t: f64) -> Option<usize> {
    frames.iter().filter(|(p, _)| *p <= t + 1e-6).last().map(|(_, c)| *c)
}

/// The middle of every source frame, and the colour that must be showing there.
fn midpoints() -> Vec<(f64, usize)> {
    let mut start = 0.0;
    DELAYS
        .iter()
        .enumerate()
        .map(|(i, &d)| {
            let mid = start + d as f64 / 200.0;
            start += d as f64 / 100.0;
            (mid, i)
        })
        .collect()
}

/// The container's duration, or — for animated WebP, which has none — where
/// its last frame ends.
fn end_time(path: &Path) -> f64 {
    if let Ok(d) = ffprobe_out(path, &["-show_entries", "format=duration", "-of", "csv=p=0"]).parse() {
        return d;
    }
    ffprobe_out(
        path,
        &["-select_streams", "v:0", "-show_entries", "frame=pts_time,duration_time", "-of", "csv=p=0"],
    )
    .lines()
    .filter_map(|l| {
        let mut f = l.split(',');
        Some(f.next()?.parse::<f64>().ok()? + f.next()?.parse::<f64>().ok()?)
    })
    .fold(0.0, f64::max)
}

fn rgba_at(path: &Path, x: u32, y: u32) -> [u8; 4] {
    let raw = path.with_extension("rgba.raw");
    let vf = format!("format=rgba,crop=1:1:{x}:{y}");
    ffmpeg_ok(strs(&[
        "-y", "-v", "error", "-i", &path.to_string_lossy(), "-vf", &vf,
        "-frames:v", "1", "-f", "rawvideo", &raw.to_string_lossy(),
    ]));
    let b = std::fs::read(&raw).unwrap();
    [b[0], b[1], b[2], b[3]]
}

fn encode(src: &Path, format: OutputFormat, clip: Option<ClipRange>, spec: &AspectSpec, out: &Path) -> PathBuf {
    let cancel = CancelToken::new();
    let probe = ffprobe::probe(src, &cancel).unwrap();
    let plan = build_plan(src, &probe, format, clip, LoopSize::default(), spec, out).expect("plan");
    let expected = clip.map(|c| c.duration()).or(probe.duration);
    ffmpeg::execute(&plan, expected, &cancel, &mut |_| {}).expect("encode");
    assert!(out.is_file() && std::fs::metadata(out).unwrap().len() > 0, "{out:?} is empty");
    out.to_path_buf()
}

fn dims(path: &Path) -> (u32, u32) {
    let v = ffprobe::probe(path, &CancelToken::new()).unwrap().video.expect("a picture");
    (v.width.unwrap(), v.height.unwrap())
}

fn sar(path: &Path) -> String {
    ffprobe_out(path, &["-select_streams", "v:0", "-show_entries", "stream=sample_aspect_ratio", "-of", "csv=p=0"])
}

// -------------------------------------------------------------- detection

#[test]
fn an_animated_gif_is_a_moving_source_with_no_sound() {
    let dir = scratch("detect");
    let gif = timed_gif(&dir);
    let cancel = CancelToken::new();
    assert_eq!(ffprobe::frame_count(&gif, &cancel).unwrap(), 6);
    let probe = ffprobe::probe(&gif, &cancel).unwrap();
    assert!(probe.is_gif() && probe.has_video() && probe.audio.is_none());
    assert_eq!((probe.video.as_ref().unwrap().width, probe.video.as_ref().unwrap().height), (Some(161), Some(121)));
    assert!((probe.duration.unwrap() - TOTAL).abs() < 0.001, "{:?}", probe.duration);
    assert_eq!(
        options_for(&probe),
        vec![OutputFormat::Mp4, OutputFormat::Mov, OutputFormat::Webm, OutputFormat::Gif, OutputFormat::Webp],
        "video and loop outputs only — there is no sound to extract"
    );
}

#[test]
fn a_single_frame_gif_is_a_still() {
    let dir = scratch("still");
    let gif = dir.join("one.gif");
    write_gif(&gif, 20, 20, &[Frame { delay: 0, transparent: false, pixel: Box::new(|_, _| RED as u8) }]);
    assert_eq!(ffprobe::frame_count(&gif, &CancelToken::new()).unwrap(), 1);
    // And the still-image pipeline can read it.
    let still = image::probe(&gif, &CancelToken::new()).unwrap();
    assert_eq!((still.width, still.height), (20, 20));
}

// ---------------------------------------------------------------- GIF → MP4

#[test]
fn gif_to_mp4_is_broadly_playable() {
    let dir = scratch("mp4");
    let out = encode(&timed_gif(&dir), OutputFormat::Mp4, None, &AspectSpec::default(), &dir.join("out.mp4"));
    let probe = ffprobe::probe(&out, &CancelToken::new()).unwrap();
    assert_eq!(probe.video.as_ref().unwrap().codec, "h264");
    assert!(probe.audio.is_none(), "a GIF has no sound to carry");
    assert_eq!(
        ffprobe_out(&out, &["-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0"]),
        "yuv420p"
    );
    assert_eq!(dims(&out), (160, 120), "the odd column and row are cropped, not scaled");
    assert!(matches!(sar(&out).as_str(), "1:1" | "N/A"), "square pixels, got {}", sar(&out));
    let bytes = std::fs::read(&out).unwrap();
    let find = |tag: &[u8]| bytes.windows(4).position(|w| w == tag).unwrap();
    assert!(find(b"moov") < find(b"mdat"), "the index must come first");
}

#[test]
fn gif_to_video_keeps_every_frame_delay() {
    // The container's duration is what a player trusts for when to stop, so it
    // is checked alongside the colour actually showing mid-way through every
    // source frame.
    let dir = scratch("timing");
    let gif = timed_gif(&dir);
    for format in [OutputFormat::Mp4, OutputFormat::Mov, OutputFormat::Webm] {
        let out = encode(&gif, format, None, &AspectSpec::default(), &dir.join(format!("out.{}", format.ext())));
        let end = end_time(&out);
        assert!((end - TOTAL).abs() < 0.02, "{format:?} lasts {end:.3}s, the GIF lasts {TOTAL}s");
        let shown = frames_shown(&out, 40, 40);
        for (t, want) in midpoints() {
            assert_eq!(shown_at(&shown, t), Some(want), "{format:?}: wrong frame on screen at {t:.3}s");
        }
    }
}

#[test]
fn a_trimmed_gif_starts_with_the_frame_on_screen_at_in() {
    // IN falls 0.25s into the green frame, which began at 0.10s. An input seek
    // would drop it for having started early.
    let dir = scratch("trim");
    let gif = timed_gif(&dir);
    let clip = ClipRange { start: 0.35, end: 1.35 };
    let expect = [(0.10, GREEN), (0.30, BLUE), (0.80, YELLOW)];

    let mp4 = encode(&gif, OutputFormat::Mp4, Some(clip), &AspectSpec::default(), &dir.join("cut.mp4"));
    let end = end_time(&mp4);
    assert!((end - 1.0).abs() < 0.02, "trimmed MP4 lasts {end:.3}s, want 1.000s");
    let shown = frames_shown(&mp4, 40, 40);
    for (t, want) in expect {
        assert_eq!(shown_at(&shown, t), Some(want), "MP4: wrong frame at {t:.2}s");
    }

    // The loop path trims the same way, then applies its preset's rate.
    let loop_gif = encode(&gif, OutputFormat::Gif, Some(clip), &AspectSpec::default(), &dir.join("cut.gif"));
    let shown = frames_shown(&loop_gif, 40, 40);
    assert_eq!(shown.first().map(|f| f.1), Some(GREEN), "the loop lost the frame on screen at IN");
    let end = end_time(&loop_gif);
    assert!((end - 1.0).abs() <= 0.08, "trimmed GIF lasts {end:.3}s; one 12.5 fps frame is 0.08s");
}

#[test]
fn a_transparent_gif_lands_on_black_in_video_and_stays_clear_in_loops() {
    let dir = scratch("alpha");
    let gif = transparent_gif(&dir);
    let mp4 = encode(&gif, OutputFormat::Mp4, None, &AspectSpec::default(), &dir.join("out.mp4"));
    let px = rgba_at(&mp4, 2, 2);
    assert!(px[0] < 24 && px[1] < 24 && px[2] < 24 && px[3] == 255, "MP4 background should be opaque black, got {px:?}");
    let square = rgba_at(&mp4, 35, 60);
    assert!(square[0] > 200 && square[1] < 60, "the opaque square is untouched, got {square:?}");

    for format in [OutputFormat::Gif, OutputFormat::Webp] {
        let out = encode(&gif, format, None, &AspectSpec::default(), &dir.join(format!("out.{}", format.ext())));
        assert_eq!(rgba_at(&out, 2, 2)[3], 0, "{format:?} must keep the transparency");
    }
}

// ------------------------------------------------------ GIF → animated WebP

#[test]
fn gif_to_animated_webp_keeps_the_animation() {
    let dir = scratch("webp");
    let out = encode(&timed_gif(&dir), OutputFormat::Webp, None, &AspectSpec::default(), &dir.join("out.webp"));
    assert_eq!(
        ffprobe_out(&out, &["-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"]),
        "webp_anim"
    );
    let end = end_time(&out);
    assert!((end - TOTAL).abs() <= 0.08, "WEBP lasts {end:.3}s; one 12.5 fps frame is 0.08s");
    let shown = frames_shown(&out, 40, 40);
    for (t, want) in midpoints() {
        assert_eq!(shown_at(&shown, t), Some(want), "WEBP: wrong frame at {t:.3}s");
    }
}

// ------------------------------------------------------------------ aspect

#[test]
fn a_gif_reframes_through_the_shared_geometry() {
    let dir = scratch("aspect");
    let gif = timed_gif(&dir);
    let ratio = |r, f| AspectSpec { ratio: r, frame: f, width: None, height: None };

    for (spec, name) in [
        (ratio(AspectRatio::R1x1, FrameMode::Fill), "square"),
        (ratio(AspectRatio::R9x16, FrameMode::Fit), "tall"),
    ] {
        let want = aspect::resolve((161, 121), &spec).unwrap().expect("a reframe").content_box();
        let out = encode(&gif, OutputFormat::Mp4, None, &spec, &dir.join(format!("{name}.mp4")));
        assert_eq!(dims(&out), (want.canvas_width, want.canvas_height), "{name}: not what the preview promised");
        assert_eq!(dims(&out).0 % 2 + dims(&out).1 % 2, 0, "{name}: odd dimensions");
        assert!(matches!(sar(&out).as_str(), "1:1" | "N/A"), "{name}: SAR {}", sar(&out));
        let end = end_time(&out);
        assert!((end - TOTAL).abs() < 0.02, "{name}: reframing changed the timing ({end:.3}s)");
    }

    let free = AspectSpec { ratio: AspectRatio::Freeform, frame: FrameMode::Fit, width: Some(200), height: Some(200) };
    let out = encode(&gif, OutputFormat::Webp, None, &free, &dir.join("free.webp"));
    assert_eq!(dims(&out), (200, 200));
}

// ---------------------------------------------------------------- preview

#[test]
fn a_gif_preview_proxy_plays_seeks_and_is_cleaned_up() {
    let dir = scratch("proxy");
    let gif = timed_gif(&dir);
    let registry = PlaybackRegistry::default();
    let id = registry.create(InputSpec::Local { path: gif.to_string_lossy().into_owned() });
    let asset = registry.prepare(&id, false).expect("prepare");

    // WebKit cannot seek a GIF, so the player is handed a proxy.
    assert!(asset.proxy);
    assert_ne!(asset.playable, asset.source);
    let p = ffprobe::probe(&asset.playable, &CancelToken::new()).unwrap();
    assert_eq!(p.video.as_ref().unwrap().codec, "h264");
    // The element stops at the container's duration, so it has to be right.
    let end = end_time(&asset.playable);
    assert!((end - TOTAL).abs() < 0.02, "proxy lasts {end:.3}s; the player would stop early");
    // Seeking lands on the right frame: the proxy keeps the source's timing.
    let shown = frames_shown(&asset.playable, 40, 40);
    for (t, want) in midpoints() {
        assert_eq!(shown_at(&shown, t), Some(want), "proxy: wrong frame at {t:.3}s");
    }

    // Asking again — as a moved IN or OUT point would — reuses it.
    let again = registry.prepare(&id, false).unwrap();
    assert!(Arc::ptr_eq(&asset, &again), "the proxy must not be rebuilt");

    let (playable, source) = (asset.playable.clone(), asset.source.clone());
    drop(again);
    drop(asset);
    registry.release(&id);
    assert!(!playable.exists(), "the proxy must be deleted with its session");
    assert!(source.exists(), "the user's GIF must never be touched");
}
