//! Output profiles — the single place that decides what FFmpeg is told to do.
//!
//! Nothing else in SHIFT builds codec arguments. Adding a future action means
//! extending this module, not scattering flags through the codebase.

use crate::errors::{Result, ShiftError};
use crate::media::ffprobe::MediaProbe;
use crate::validation::ClipRange;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OutputFormat {
    Mp4,
    Mov,
    Webm,
    Gif,
    Mp3,
    Wav,
    M4a,
    Aac,
    Flac,
    Jpg,
    Png,
    Webp,
    Avif,
}

impl OutputFormat {
    pub fn ext(self) -> &'static str {
        match self {
            OutputFormat::Mp4 => "mp4",
            OutputFormat::Mov => "mov",
            OutputFormat::Webm => "webm",
            OutputFormat::Gif => "gif",
            OutputFormat::Mp3 => "mp3",
            OutputFormat::Wav => "wav",
            OutputFormat::M4a => "m4a",
            OutputFormat::Aac => "aac",
            OutputFormat::Flac => "flac",
            OutputFormat::Jpg => "jpg",
            OutputFormat::Png => "png",
            OutputFormat::Webp => "webp",
            OutputFormat::Avif => "avif",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            OutputFormat::Mp4 => "MP4",
            OutputFormat::Mov => "MOV",
            OutputFormat::Webm => "WEBM",
            OutputFormat::Gif => "GIF",
            OutputFormat::Mp3 => "MP3",
            OutputFormat::Wav => "WAV",
            OutputFormat::M4a => "M4A",
            OutputFormat::Aac => "AAC",
            OutputFormat::Flac => "FLAC",
            OutputFormat::Jpg => "JPG",
            OutputFormat::Png => "PNG",
            OutputFormat::Webp => "WEBP",
            OutputFormat::Avif => "AVIF",
        }
    }

    pub fn is_audio_only(self) -> bool {
        matches!(
            self,
            OutputFormat::Mp3
                | OutputFormat::Wav
                | OutputFormat::M4a
                | OutputFormat::Aac
                | OutputFormat::Flac
        )
    }

    pub fn is_image(self) -> bool {
        matches!(
            self,
            OutputFormat::Jpg | OutputFormat::Png | OutputFormat::Webp | OutputFormat::Avif
        )
    }

    /// The longest a loop in this format may run, or `None` if it is not a
    /// loop format at all.
    pub fn max_loop_seconds(self) -> Option<f64> {
        match self {
            OutputFormat::Gif => Some(MAX_GIF_SECONDS),
            OutputFormat::Webp => Some(MAX_WEBP_LOOP_SECONDS),
            _ => None,
        }
    }

    /// The range to propose when the source is longer than the limit.
    pub fn default_loop_seconds(self) -> Option<f64> {
        match self {
            OutputFormat::Gif => Some(DEFAULT_GIF_SECONDS),
            OutputFormat::Webp => Some(DEFAULT_WEBP_LOOP_SECONDS),
            _ => None,
        }
    }

    /// Formats that carry motion but never sound.
    ///
    /// WEBP is deliberately in both this list and `is_image`: from a still it
    /// is a still, from a video it is an animation. The source decides, which
    /// is why nothing outside `jobs` may ask "is this an animation?" without
    /// also knowing what went in.
    pub fn is_animation(self) -> bool {
        matches!(self, OutputFormat::Gif | OutputFormat::Webp)
    }
}

// Raw ADTS `.aac` is deliberately not an output chip. It is the same codec M4A
// already carries, in a container macOS handles worse, and offering both is
// exactly the codec question a user should never have to answer. The variant
// stays so `.aac` remains a readable *input*.

/// Output chips for an image source. HEIC is an input, not an output.
///
/// AVIF is withheld when the source carries transparency: the bundled
/// libaom-av1 advertises no alpha pixel format at all, so an AVIF export would
/// silently flatten it. Not offering the chip is better than offering one that
/// quietly loses data — `image::build_plan` refuses the same case as a
/// backstop, in case a request ever arrives without passing through here.
pub fn image_options(has_alpha: bool) -> Vec<OutputFormat> {
    let mut out = vec![OutputFormat::Jpg, OutputFormat::Png, OutputFormat::Webp];
    if !has_alpha {
        out.push(OutputFormat::Avif);
    }
    out
}

/// Which output chips make sense for a probed local file (LOC-03/04/05).
pub fn options_for(probe: &MediaProbe) -> Vec<OutputFormat> {
    if probe.has_video() {
        vec![
            OutputFormat::Mp4,
            OutputFormat::Mov,
            OutputFormat::Webm,
            OutputFormat::Gif,
            OutputFormat::Webp,
            OutputFormat::Mp3,
            OutputFormat::M4a,
            OutputFormat::Wav,
            OutputFormat::Flac,
        ]
    } else {
        vec![
            OutputFormat::Mp3,
            OutputFormat::M4a,
            OutputFormat::Wav,
            OutputFormat::Flac,
        ]
    }
}

// ------------------------------------------------------------------- loops

/// Loop length limits, per format, because the two formats do not cost the
/// same thing per second.
///
/// Measured at the Standard preset on full-frame motion:
///
/// | length | GIF | animated WEBP |
/// | --- | --- | --- |
/// | 10s | 1.8 MB | 0.7 MB |
/// | 15s | 2.7 MB | 1.1 MB |
/// | 30s | 5.5 MB | 2.1 MB |
///
/// GIF has no interframe compression — every frame is a fresh palettised image
/// — so length turns straight into megabytes. It is a short-loop format and is
/// treated as one. Animated WebP does compress between frames: at a full 30
/// seconds it is still smaller than a 15-second GIF, so holding it to GIF's
/// limit would be an arbitrary penalty.
pub const MAX_GIF_SECONDS: f64 = 15.0;
pub const MAX_WEBP_LOOP_SECONDS: f64 = 30.0;

/// The range proposed when a loop is chosen on a source too long for it.
pub const DEFAULT_GIF_SECONDS: f64 = 10.0;
pub const DEFAULT_WEBP_LOOP_SECONDS: f64 = 15.0;

/// How large and how smooth a loop should be.
///
/// The frame rates are not arbitrary. GIF stores each frame's delay in
/// hundredths of a second, so only rates that divide 100 evenly survive the
/// round trip: 10 fps is 10cs, 12.5 fps is 8cs, 20 fps is 5cs. A "sensible"
/// 12 or 15 fps encodes as alternating 8/9cs or 7/6cs delays, which is visible
/// as micro-judder and makes the real rate something other than the one asked
/// for. Verified against the bundled FFmpeg: these three produce exactly one
/// distinct delay value each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoopSize {
    Small,
    Standard,
    Large,
}

impl Default for LoopSize {
    fn default() -> Self {
        LoopSize::Standard
    }
}

impl LoopSize {
    /// Longest edge in pixels. A smaller source is never scaled up.
    pub fn width(self) -> u32 {
        match self {
            LoopSize::Small => 320,
            LoopSize::Standard => 480,
            LoopSize::Large => 640,
        }
    }

    /// Kept as text so `12.5` reaches FFmpeg exactly, with no float formatting
    /// in between.
    pub fn fps(self) -> &'static str {
        match self {
            LoopSize::Small => "10",
            LoopSize::Standard => "12.5",
            LoopSize::Large => "20",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            LoopSize::Small => "Small",
            LoopSize::Standard => "Standard",
            LoopSize::Large => "Large",
        }
    }
}

pub fn loop_options() -> Vec<LoopSize> {
    vec![LoopSize::Small, LoopSize::Standard, LoopSize::Large]
}

// -------------------------------------------------------- container fitness

/// Can this video codec live in the target container untouched?
fn video_codec_fits(container: OutputFormat, codec: &str) -> bool {
    let c = codec.to_ascii_lowercase();
    match container {
        OutputFormat::Mp4 => matches!(c.as_str(), "h264" | "hevc" | "mpeg4" | "av1"),
        OutputFormat::Mov => matches!(c.as_str(), "h264" | "hevc" | "mpeg4" | "prores" | "dnxhd"),
        OutputFormat::Webm => matches!(c.as_str(), "vp8" | "vp9" | "av1"),
        _ => false,
    }
}

/// Can an audio-only export copy the source stream instead of re-encoding it?
///
/// Stricter than `audio_codec_fits` on purpose. That function answers "is this
/// legal in the container", which is the right question when muxing a video.
/// Here the question is "does the file the user asked for mean the same thing
/// as the one they have", and the two differ: MP3 inside an `.m4a` is legal but
/// nobody wants it, and ALAC inside an `.m4a` is Apple Lossless — a different
/// product from the AAC the M4A chip promises, and many times the size. Both
/// re-encode.
fn audio_copy_is_faithful(format: OutputFormat, codec: &str) -> bool {
    let c = codec.to_ascii_lowercase();
    match format {
        OutputFormat::Mp3 => c == "mp3",
        OutputFormat::M4a | OutputFormat::Aac => c == "aac",
        OutputFormat::Flac => c == "flac",
        // WAV re-encodes so the output is predictably 16-bit PCM.
        _ => false,
    }
}

/// Can this audio codec live in the target container untouched?
fn audio_codec_fits(container: OutputFormat, codec: &str) -> bool {
    let c = codec.to_ascii_lowercase();
    match container {
        OutputFormat::Mp4 | OutputFormat::M4a => matches!(c.as_str(), "aac" | "mp3" | "alac"),
        OutputFormat::Mov => matches!(c.as_str(), "aac" | "alac" | "pcm_s16le" | "pcm_s24le" | "mp3"),
        OutputFormat::Webm => matches!(c.as_str(), "opus" | "vorbis"),
        OutputFormat::Mp3 => c == "mp3",
        OutputFormat::Aac => c == "aac",
        OutputFormat::Wav => c.starts_with("pcm_"),
        OutputFormat::Flac => c == "flac",
        // Still images and silent loops never carry an audio stream.
        OutputFormat::Gif
        | OutputFormat::Jpg
        | OutputFormat::Png
        | OutputFormat::Webp
        | OutputFormat::Avif => false,
    }
}

// --------------------------------------------------------------- the plan

#[derive(Debug, Clone)]
pub struct EncodePlan {
    pub args: Vec<String>,
    /// True when every stream is copied — no quality loss, near-instant.
    pub remuxed: bool,
}

/// Build the complete FFmpeg argument array for one transformation.
///
/// Trimming always re-encodes video: a stream copy can only cut on keyframes,
/// which would silently give the user a different range than they typed. Correct
/// output beats a faster inaccurate one (PRD §12, "Precise cuts").
pub fn build_plan(
    input: &Path,
    probe: &MediaProbe,
    format: OutputFormat,
    clip: Option<ClipRange>,
    loop_size: LoopSize,
    output: &Path,
) -> Result<EncodePlan> {
    if format.is_audio_only() && probe.audio.is_none() {
        return Err(ShiftError::new("no_audio", "This file has no audio to extract.")
            .hint("Choose a video output format instead."));
    }
    if !format.is_audio_only() && !probe.has_video() {
        return Err(ShiftError::new("no_video", "This is an audio file.")
            .hint("Choose MP3, WAV, M4A, AAC or FLAC."));
    }
    // A moving source asked for a moving silent format: GIF, or WEBP standing
    // in for animated WebP. Checked before `is_image`, because WEBP is both.
    if format.is_animation() {
        return build_loop_plan(input, probe, format, clip, loop_size, output);
    }
    if format.is_image() {
        return Err(ShiftError::new("image_from_av", "That output is an image format.")
            .hint("Choose a video or audio format for this file."));
    }

    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];

    // Input-side seek. Since FFmpeg 2.1 this is frame-accurate when re-encoding
    // and still fast, because the decoder skips ahead before decoding.
    if let Some(range) = clip {
        args.push("-ss".into());
        args.push(format!("{:.3}", range.start));
    }
    args.push("-i".into());
    args.push(input.to_string_lossy().to_string());
    if let Some(range) = clip {
        args.push("-t".into());
        args.push(format!("{:.3}", range.duration()));
    }

    let trimming = clip.is_some();
    let mut remuxed = false;

    if format.is_audio_only() {
        args.push("-vn".into());
        let src = probe.audio.as_ref().map(|a| a.codec.as_str()).unwrap_or("");
        // A straight container change (M4A from an AAC source) can copy.
        if !trimming && audio_copy_is_faithful(format, src) {
            args.push("-c:a".into());
            args.push("copy".into());
            remuxed = true;
        } else {
            args.extend(audio_encoder(format));
        }
        // M4A is an MP4 container, so it wants its index up front too.
        if format == OutputFormat::M4a {
            args.push("-movflags".into());
            args.push("+faststart".into());
        }
    } else {
        let v_src = probe.video.as_ref().map(|v| v.codec.as_str()).unwrap_or("");
        let a_src = probe.audio.as_ref().map(|a| a.codec.as_str()).unwrap_or("");
        let can_copy_video = !trimming && video_codec_fits(format, v_src);
        let can_copy_audio = probe.audio.is_none() || (!trimming && audio_codec_fits(format, a_src));

        if can_copy_video && can_copy_audio {
            args.push("-c".into());
            args.push("copy".into());
            remuxed = true;
        } else {
            args.extend(video_encoder(format));
            if probe.audio.is_some() {
                if can_copy_audio {
                    args.push("-c:a".into());
                    args.push("copy".into());
                } else {
                    args.extend(container_audio_encoder(format));
                }
            } else {
                args.push("-an".into());
            }
        }
        // MP4/MOV need the index up front so the file plays while still on disk.
        if matches!(format, OutputFormat::Mp4 | OutputFormat::Mov) {
            args.push("-movflags".into());
            args.push("+faststart".into());
        }
    }

    args.push("-map_metadata".into());
    args.push("0".into());
    // Machine-readable progress on stdout; the human log stays on stderr.
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().to_string());

    Ok(EncodePlan { args, remuxed })
}

/// Build the plan for a silent looping export.
///
/// GIF has no interframe compression and only 256 colours per frame, so the
/// quality of the result is decided almost entirely by the palette. A single
/// pass lets FFmpeg pick a fixed heuristic palette and the output bands badly;
/// `palettegen` + `paletteuse` builds one from the actual footage in the same
/// graph, which is why the filter chain looks the way it does rather than being
/// a plain `-vf`.
///
/// `stats_mode=full` and `dither=sierra2_4a` are FFmpeg's own defaults, written
/// out so the choice is visible and cannot drift if a future FFmpeg changes
/// them. Measured against the alternatives on both flat UI capture and smooth
/// gradients, they were the best or joint-best on size and SSIM; bayer dithering
/// was consistently larger *and* worse.
fn build_loop_plan(
    input: &Path,
    probe: &MediaProbe,
    format: OutputFormat,
    clip: Option<ClipRange>,
    loop_size: LoopSize,
    output: &Path,
) -> Result<EncodePlan> {
    let limit = format.max_loop_seconds().unwrap_or(MAX_GIF_SECONDS);
    let seconds = clip.map(|c| c.duration()).or(probe.duration);
    if let Some(secs) = seconds {
        // A hair of tolerance: a clip typed as exactly the limit can probe a
        // millisecond over and should not be refused for it.
        if secs > limit + 0.05 {
            return Err(ShiftError::new(
                "loop_too_long",
                format!("{} is limited to {:.0} seconds.", format.label(), limit),
            )
            .hint("Turn on Trim and pick a shorter range."));
        }
    }

    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    if let Some(range) = clip {
        args.push("-ss".into());
        args.push(format!("{:.3}", range.start));
    }
    args.push("-i".into());
    args.push(input.to_string_lossy().to_string());
    if let Some(range) = clip {
        args.push("-t".into());
        args.push(format!("{:.3}", range.duration()));
    }

    // Neither container can hold sound, so the stream is dropped rather than
    // left for FFmpeg to discard with a warning.
    args.push("-an".into());

    // `min(iw,W)` caps the width without ever scaling a small source up, and
    // `-2` keeps the height even, which the WebP encoder requires. The single
    // quotes are for FFmpeg's own filtergraph parser: without them the comma
    // inside `min()` would read as the end of the filter. No shell is involved
    // — this whole array is passed to `execvp` as-is.
    let chain = format!(
        "fps={},scale=w='min(iw,{})':h=-2:flags=lanczos",
        loop_size.fps(),
        loop_size.width()
    );

    match format {
        OutputFormat::Gif => {
            args.push("-filter_complex".into());
            args.push(format!(
                "{chain},split[a][b];[a]palettegen=stats_mode=full[p];\
                 [b][p]paletteuse=dither=sierra2_4a[out]"
            ));
            args.push("-map".into());
            args.push("[out]".into());
        }
        OutputFormat::Webp => {
            args.push("-vf".into());
            args.push(chain);
            // libwebp_anim is the animated sibling of the libwebp used for
            // stills. Named explicitly so a still-image encoder can never be
            // chosen for a moving source.
            args.push("-c:v".into());
            args.push("libwebp_anim".into());
            args.push("-lossless".into());
            args.push("0".into());
            args.push("-quality".into());
            args.push("75".into());
            args.push("-compression_level".into());
            args.push("4".into());
        }
        _ => unreachable!("guarded by is_animation"),
    }

    // 0 means loop forever, which is what everyone means by a GIF.
    args.push("-loop".into());
    args.push("0".into());
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().to_string());

    Ok(EncodePlan { args, remuxed: false })
}

fn audio_encoder(format: OutputFormat) -> Vec<String> {
    match format {
        OutputFormat::Mp3 => vec!["-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into()],
        OutputFormat::Wav => vec!["-c:a".into(), "pcm_s16le".into()],
        // Level 8 is the archival default and measured no slower than the
        // level-5 default on real material, for ~0.3% less size.
        OutputFormat::Flac => {
            vec!["-c:a".into(), "flac".into(), "-compression_level".into(), "8".into()]
        }
        OutputFormat::M4a | OutputFormat::Aac => {
            vec!["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]
        }
        _ => vec![],
    }
}

fn container_audio_encoder(format: OutputFormat) -> Vec<String> {
    match format {
        OutputFormat::Webm => vec!["-c:a".into(), "libopus".into(), "-b:a".into(), "128k".into()],
        _ => vec!["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()],
    }
}

fn video_encoder(format: OutputFormat) -> Vec<String> {
    match format {
        OutputFormat::Webm => vec![
            "-c:v".into(),
            "libvpx-vp9".into(),
            "-crf".into(),
            "32".into(),
            "-b:v".into(),
            "0".into(),
            "-row-mt".into(),
            "1".into(),
            "-cpu-used".into(),
            "3".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
        _ => vec![
            "-c:v".into(),
            "libx264".into(),
            "-crf".into(),
            "20".into(),
            "-preset".into(),
            "medium".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::ffprobe::StreamInfo;

    fn plan(
        probe: &MediaProbe,
        format: OutputFormat,
        clip: Option<ClipRange>,
    ) -> Result<EncodePlan> {
        build_plan(Path::new("/in.mov"), probe, format, clip, LoopSize::default(), Path::new("/out"))
    }

    fn h264_mov() -> MediaProbe {
        MediaProbe {
            duration: Some(43.0),
            container: "mov".into(),
            size_bytes: 1000,
            video: Some(StreamInfo { codec: "h264".into(), width: Some(1920), height: Some(1080) }),
            audio: Some(StreamInfo { codec: "aac".into(), width: None, height: None }),
        }
    }

    #[test]
    fn h264_mov_to_mp4_is_a_remux() {
        let plan = plan(&h264_mov(), OutputFormat::Mp4, None).unwrap();
        assert!(plan.remuxed);
        assert!(plan.args.windows(2).any(|w| w == ["-c", "copy"]));
    }

    #[test]
    fn h264_to_webm_must_transcode() {
        let plan = plan(&h264_mov(), OutputFormat::Webm, None).unwrap();
        assert!(!plan.remuxed);
        assert!(plan.args.iter().any(|a| a == "libvpx-vp9"));
    }

    #[test]
    fn trimming_forces_a_re_encode_for_accuracy() {
        let clip = ClipRange { start: 172.0, end: 176.0 };
        let plan = plan(&h264_mov(), OutputFormat::Mp4, Some(clip)).unwrap();
        assert!(!plan.remuxed);
        assert!(plan.args.windows(2).any(|w| w == ["-ss", "172.000"]));
        assert!(plan.args.windows(2).any(|w| w == ["-t", "4.000"]));
    }

    #[test]
    fn audio_only_output_drops_the_video_stream() {
        let plan = plan(&h264_mov(), OutputFormat::Wav, None).unwrap();
        assert!(plan.args.iter().any(|a| a == "-vn"));
        assert!(plan.args.iter().any(|a| a == "pcm_s16le"));
    }

    #[test]
    fn audio_source_refuses_a_video_container() {
        let audio = MediaProbe {
            duration: Some(10.0),
            container: "mp3".into(),
            size_bytes: 10,
            video: None,
            audio: Some(StreamInfo { codec: "mp3".into(), width: None, height: None }),
        };
        assert!(plan(&audio, OutputFormat::Mp4, None).is_err());
    }

    // ------------------------------------------------------------- loops

    fn args_of(format: OutputFormat, clip: Option<ClipRange>) -> Vec<String> {
        plan(&h264_mov(), format, clip).unwrap().args
    }

    #[test]
    fn a_gif_is_built_from_a_palette_not_a_plain_filter() {
        // A single-pass GIF uses a fixed heuristic palette and bands badly, so
        // the two-stage graph is the whole point of this path.
        let args = args_of(OutputFormat::Gif, Some(ClipRange { start: 0.0, end: 4.0 }));
        let graph = args.iter().find(|a| a.contains("palettegen")).expect("palette graph");
        assert!(graph.contains("split[a][b]"));
        assert!(graph.contains("[a]palettegen=stats_mode=full[p]"));
        assert!(graph.contains("[b][p]paletteuse=dither=sierra2_4a[out]"));
        // The graph is useless without being mapped to the output.
        assert!(args.windows(2).any(|w| w == ["-map", "[out]"]));
    }

    #[test]
    fn a_loop_is_silent_and_endless() {
        for f in [OutputFormat::Gif, OutputFormat::Webp] {
            let args = args_of(f, Some(ClipRange { start: 0.0, end: 4.0 }));
            assert!(args.iter().any(|a| a == "-an"), "{f:?} must drop audio");
            assert!(args.windows(2).any(|w| w == ["-loop", "0"]), "{f:?} must loop forever");
        }
    }

    #[test]
    fn an_animated_webp_uses_the_animated_encoder() {
        let args = args_of(OutputFormat::Webp, Some(ClipRange { start: 0.0, end: 4.0 }));
        assert!(args.iter().any(|a| a == "libwebp_anim"));
        // The still encoder would silently produce a one-frame file.
        assert!(!args.iter().any(|a| a == "libwebp"));
    }

    #[test]
    fn a_loop_never_upscales_a_small_source() {
        let args = args_of(OutputFormat::Gif, Some(ClipRange { start: 0.0, end: 4.0 }));
        let graph = args.iter().find(|a| a.contains("scale=")).expect("scale");
        assert!(graph.contains("min(iw,480)"), "width must be a cap, not a target: {graph}");
        // -2 keeps the height even, which libwebp_anim requires.
        assert!(graph.contains("h=-2"));
    }

    #[test]
    fn every_loop_rate_divides_a_hundred() {
        // GIF frame delays are whole centiseconds. A rate that does not divide
        // 100 encodes as alternating delays, which reads as judder and makes
        // the real frame rate something other than the one requested.
        for size in loop_options() {
            let fps: f64 = size.fps().parse().expect("numeric fps");
            let cs = 100.0 / fps;
            assert_eq!(cs, cs.round(), "{:?} at {} fps is {cs} centiseconds", size, size.fps());
        }
    }

    #[test]
    fn each_loop_format_is_capped_at_its_own_limit() {
        for (format, limit) in
            [(OutputFormat::Gif, MAX_GIF_SECONDS), (OutputFormat::Webp, MAX_WEBP_LOOP_SECONDS)]
        {
            let long = MediaProbe { duration: Some(limit + 1.0), ..h264_mov() };
            let err = plan(&long, format, None).unwrap_err();
            assert_eq!(err.code, "loop_too_long", "{format:?} should refuse {limit}s + 1");
            assert!(
                err.message.contains(&format!("{limit:.0}")),
                "the message must name the real limit: {}",
                err.message
            );

            // Trimming to exactly the limit is what makes it work.
            let clip = ClipRange { start: 0.0, end: limit };
            assert!(plan(&long, format, Some(clip)).is_ok(), "{format:?} at exactly {limit}s");
        }
    }

    #[test]
    fn gif_is_held_to_a_shorter_limit_than_animated_webp() {
        // GIF has no interframe compression; WEBP does. Holding WEBP to GIF's
        // limit would be an arbitrary penalty — a 30s WEBP is smaller than a
        // 15s GIF.
        assert!(MAX_GIF_SECONDS < MAX_WEBP_LOOP_SECONDS);
        assert!(DEFAULT_GIF_SECONDS < MAX_GIF_SECONDS);
        assert!(DEFAULT_WEBP_LOOP_SECONDS < MAX_WEBP_LOOP_SECONDS);

        // A 20s range is fine as a WEBP and too long as a GIF.
        let long = MediaProbe { duration: Some(60.0), ..h264_mov() };
        let clip = ClipRange { start: 0.0, end: 20.0 };
        assert!(plan(&long, OutputFormat::Webp, Some(clip)).is_ok());
        assert!(plan(&long, OutputFormat::Gif, Some(clip)).is_err());

        // The cap belongs to loops alone — a long MP4 is still fine.
        assert!(plan(&long, OutputFormat::Mp4, None).is_ok());
    }

    #[test]
    fn only_loop_formats_carry_a_limit() {
        for f in [OutputFormat::Mp4, OutputFormat::Mp3, OutputFormat::M4a, OutputFormat::Jpg] {
            assert!(f.max_loop_seconds().is_none(), "{f:?} is not a loop format");
            assert!(f.default_loop_seconds().is_none());
        }
    }

    #[test]
    fn an_audio_source_cannot_become_a_loop() {
        let audio = MediaProbe {
            duration: Some(10.0),
            container: "mp3".into(),
            size_bytes: 10,
            video: None,
            audio: Some(StreamInfo { codec: "mp3".into(), width: None, height: None }),
        };
        assert!(plan(&audio, OutputFormat::Gif, None).is_err());
        assert!(plan(&audio, OutputFormat::Webp, None).is_err());
    }

    // ------------------------------------------------------------- audio

    #[test]
    fn m4a_copies_only_a_genuine_aac_source() {
        let mut probe = h264_mov();
        probe.video = None;

        // AAC in, M4A out, no trim: the same audio, a different wrapper.
        probe.audio = Some(StreamInfo { codec: "aac".into(), width: None, height: None });
        let copied = plan(&probe, OutputFormat::M4a, None).unwrap();
        assert!(copied.remuxed);
        assert!(copied.args.windows(2).any(|w| w == ["-c:a", "copy"]));

        // MP3 inside an .m4a is legal and nobody wants it; ALAC is Apple
        // Lossless, a different product from the AAC the chip promises. Both
        // must re-encode rather than be waved through.
        for codec in ["mp3", "alac", "pcm_s16le", "flac", "vorbis"] {
            probe.audio = Some(StreamInfo { codec: codec.into(), width: None, height: None });
            let p = plan(&probe, OutputFormat::M4a, None).unwrap();
            assert!(!p.remuxed, "{codec} → M4A must re-encode, not copy");
            assert!(p.args.iter().any(|a| a == "aac"), "{codec} → M4A must encode AAC");
        }

        // Trimming always re-encodes, even from AAC.
        probe.audio = Some(StreamInfo { codec: "aac".into(), width: None, height: None });
        let clip = ClipRange { start: 1.0, end: 2.0 };
        assert!(!plan(&probe, OutputFormat::M4a, Some(clip)).unwrap().remuxed);
    }

    #[test]
    fn m4a_is_the_only_aac_chip() {
        // AAC-in-MP4 and raw ADTS are the same codec in different wrappers.
        // Showing both asks the user a codec question; M4A is the answer that
        // works everywhere on macOS.
        let audio = MediaProbe {
            duration: Some(10.0),
            container: "mp3".into(),
            size_bytes: 10,
            video: None,
            audio: Some(StreamInfo { codec: "mp3".into(), width: None, height: None }),
        };
        for outputs in [options_for(&h264_mov()), options_for(&audio)] {
            assert!(!outputs.contains(&OutputFormat::Aac), "raw AAC must not be offered");
            assert!(outputs.contains(&OutputFormat::M4a));
        }
        // It is still a format SHIFT understands, just not one it offers.
        assert_eq!(OutputFormat::Aac.ext(), "aac");
    }

    #[test]
    fn m4a_is_offered_wherever_audio_is() {
        // Extracting audio from a video, and converting an audio file.
        assert!(options_for(&h264_mov()).contains(&OutputFormat::M4a));

        let audio = MediaProbe {
            duration: Some(10.0),
            container: "mp3".into(),
            size_bytes: 10,
            video: None,
            audio: Some(StreamInfo { codec: "mp3".into(), width: None, height: None }),
        };
        assert!(options_for(&audio).contains(&OutputFormat::M4a));
    }

    #[test]
    fn m4a_is_written_for_streaming() {
        // An MP4 container with its index at the end has to be fully downloaded
        // before it will play.
        let plan_ = plan(&h264_mov(), OutputFormat::M4a, None).unwrap();
        assert!(plan_.args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
    }

    #[test]
    fn flac_is_encoded_losslessly_and_can_be_remuxed() {
        let plan_ = plan(&h264_mov(), OutputFormat::Flac, None).unwrap();
        assert!(plan_.args.iter().any(|a| a == "flac"));
        // No bitrate or quality flag may reach a lossless encoder.
        assert!(!plan_.args.iter().any(|a| a == "-b:a" || a == "-q:a"));

        // FLAC in, FLAC out, no trim: nothing to re-encode.
        let mut flac_src = h264_mov();
        flac_src.video = None;
        flac_src.audio = Some(StreamInfo { codec: "flac".into(), width: None, height: None });
        assert!(plan(&flac_src, OutputFormat::Flac, None).unwrap().remuxed);
    }

    #[test]
    fn an_image_output_is_still_refused_for_a_video_source() {
        // WEBP is the exception, because it is also an animation.
        for f in [OutputFormat::Jpg, OutputFormat::Png, OutputFormat::Avif] {
            assert!(plan(&h264_mov(), f, None).is_err(), "{f:?} is not a video output");
        }
        // The 43s fixture is over the loop cap, so WEBP needs a trim to pass —
        // which is itself the point: it took the animation path, not the
        // image one.
        let clip = ClipRange { start: 0.0, end: 4.0 };
        assert!(plan(&h264_mov(), OutputFormat::Webp, Some(clip)).is_ok());
    }
}
