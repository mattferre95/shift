//! Image analysis and conversion.
//!
//! HEIC is decoded by macOS itself through `sips`, which is part of the OS and
//! already understands every input format in V1.1 — no extra decoder is
//! bundled. `sips` writes JPEG and PNG but *not* WEBP, so WEBP output goes
//! through the FFmpeg that SHIFT already ships, with `sips` decoding to a
//! lossless intermediate first when the source is HEIC/HEIF.
//!
//! As everywhere else in SHIFT, arguments are explicit arrays; no shell string
//! is ever built from user input.

use crate::errors::{Result, ShiftError};
use crate::media::profiles::OutputFormat;
use crate::process::{run_capture, Binary, CancelToken};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Local image inputs. AVIF is included so SHIFT can read back what it writes.
pub const IMAGE_EXTS: [&str; 7] = ["heic", "heif", "jpg", "jpeg", "png", "webp", "avif"];

pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str())
}

/// Only what the user benefits from seeing. No EXIF, no colour-profile trivia.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProbe {
    pub width: u32,
    pub height: u32,
    /// As reported by macOS, e.g. `heic`, `jpeg`, `png`.
    pub format: String,
    pub size_bytes: u64,
    /// Whether the source carries transparency. Decides whether AVIF may be
    /// offered at all — see `profiles::image_options`.
    pub has_alpha: bool,
}

/// How hard to compress. PNG is lossless, so it uses `Optimize` instead of the
/// lossy rungs — see `quality_for`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Compression {
    None,
    Light,
    Balanced,
    Strong,
    /// PNG only: recompress losslessly, never touching pixels.
    Optimize,
}

impl Compression {
    /// Encoder quality for the lossy formats. Verified against real output:
    /// on a 1200×800 test image these produce 152 KB / 98 KB / 87 KB / 72 KB.
    fn quality(self) -> u8 {
        match self {
            Compression::None | Compression::Optimize => 100,
            Compression::Light => 90,
            Compression::Balanced => 80,
            Compression::Strong => 65,
        }
    }

    /// AV1 runs on a constant-quality scale where lower is better, so the
    /// ladder is inverted rather than reused. 18 is visually lossless on
    /// photographic material; AVIF has no truly lossless rung here, which is
    /// why `None` still names a real quality instead of pretending otherwise.
    fn av1_crf(self) -> u8 {
        match self {
            Compression::None | Compression::Optimize => 18,
            Compression::Light => 24,
            Compression::Balanced => 30,
            Compression::Strong => 38,
        }
    }

    fn wants_png_optimization(self) -> bool {
        !matches!(self, Compression::None)
    }
}

/// Which compression chips make sense for a given output format.
pub fn options_for(format: OutputFormat) -> Vec<Compression> {
    match format {
        // Lossless: the only honest choice is whether to spend time shrinking
        // the file without touching a single pixel.
        OutputFormat::Png => vec![Compression::None, Compression::Optimize],
        _ => vec![
            Compression::None,
            Compression::Light,
            Compression::Balanced,
            Compression::Strong,
        ],
    }
}

// ------------------------------------------------------------------- probing

/// Read dimensions and format via `sips`.
///
/// `sips` exits 0 even on a file it cannot decode, reporting `<nil>` for every
/// property, so a missing dimension is treated as an unreadable image rather
/// than trusted as a success.
pub fn probe(path: &Path, cancel: &CancelToken) -> Result<ImageProbe> {
    let args: Vec<String> = vec![
        "-g".into(),
        "pixelWidth".into(),
        "-g".into(),
        "pixelHeight".into(),
        "-g".into(),
        "format".into(),
        "-g".into(),
        "hasAlpha".into(),
        path.to_string_lossy().to_string(),
    ];
    let out = run_capture(Binary::Sips, &args, cancel)?;
    if !out.success {
        return Err(unreadable(out.log()));
    }

    let mut width = None;
    let mut height = None;
    let mut format = None;
    let mut has_alpha = false;
    for line in out.stdout.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match key.trim() {
            "pixelWidth" => width = value.parse::<u32>().ok(),
            "pixelHeight" => height = value.parse::<u32>().ok(),
            "format" => format = Some(value.to_string()),
            "hasAlpha" => has_alpha = value.eq_ignore_ascii_case("yes"),
            _ => {}
        }
    }

    match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Ok(ImageProbe {
            width: w,
            height: h,
            format: format.unwrap_or_else(|| "image".into()),
            size_bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            has_alpha,
        }),
        // `<nil>` dimensions: the container extension lied, or the file is damaged.
        _ => Err(unreadable(out.log())),
    }
}

fn unreadable(technical: String) -> ShiftError {
    ShiftError::new("unreadable_image", "SHIFT couldn't read this image.")
        .hint("The file may be damaged or not the format its name suggests.")
        .technical(technical)
}

// -------------------------------------------------------------------- plan

/// One process in an image pipeline.
#[derive(Debug, Clone)]
pub enum ImageStep {
    Sips(Vec<String>),
    Ffmpeg(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct ImagePlan {
    pub steps: Vec<ImageStep>,
    /// True when no pixel data is discarded.
    pub lossless: bool,
}

/// Build the pipeline for one image conversion.
///
/// `work_dir` holds the lossless intermediate when two passes are needed; it is
/// inside the job's own temp directory and disappears with it.
pub fn build_plan(
    input: &Path,
    source_format: &str,
    format: OutputFormat,
    compression: Compression,
    has_alpha: bool,
    work_dir: &Path,
    output: &Path,
) -> Result<ImagePlan> {
    if !format.is_image() {
        return Err(ShiftError::new("not_an_image_format", "That output isn't an image format.")
            .hint("Choose JPG, PNG, WEBP or AVIF."));
    }
    // The chip is already withheld for a transparent source, so reaching this
    // means something bypassed `profiles::image_options`. Refuse rather than
    // flatten: the bundled libaom-av1 offers no alpha pixel format, so the
    // transparency would be silently replaced with whatever sat behind it.
    if format == OutputFormat::Avif && has_alpha {
        return Err(ShiftError::new("avif_alpha", "AVIF can't keep this image's transparency.")
            .hint("Choose PNG or WEBP to keep it."));
    }

    let src = source_format.to_ascii_lowercase();
    // FFmpeg cannot decode HEIC/HEIF, so those always pass through sips first.
    let needs_decode = src.starts_with("heic") || src.starts_with("heif");
    let quality = compression.quality();

    let steps = match format {
        // ---- JPEG: one sips pass; quality is the compression. --------------
        OutputFormat::Jpg => vec![ImageStep::Sips(sips_args(
            input,
            "jpeg",
            Some(quality),
            output,
        ))],

        // ---- PNG: lossless. Optional second pass recompresses only. --------
        OutputFormat::Png => {
            if !compression.wants_png_optimization() {
                vec![ImageStep::Sips(sips_args(input, "png", None, output))]
            } else if src == "png" {
                // Already PNG: skip the decode and just recompress.
                vec![ImageStep::Ffmpeg(png_optimize_args(input, output))]
            } else {
                let intermediate = work_dir.join("decoded.png");
                vec![
                    ImageStep::Sips(sips_args(input, "png", None, &intermediate)),
                    ImageStep::Ffmpeg(png_optimize_args(&intermediate, output)),
                ]
            }
        }

        // ---- WEBP: sips cannot write it, so FFmpeg does. -------------------
        OutputFormat::Webp => {
            if needs_decode {
                let intermediate = work_dir.join("decoded.png");
                vec![
                    ImageStep::Sips(sips_args(input, "png", None, &intermediate)),
                    ImageStep::Ffmpeg(webp_args(&intermediate, quality, output)),
                ]
            } else {
                vec![ImageStep::Ffmpeg(webp_args(input, quality, output))]
            }
        }

        // ---- AVIF: FFmpeg only, same two-step decode as WEBP for HEIC. -----
        OutputFormat::Avif => {
            if needs_decode {
                let intermediate = work_dir.join("decoded.png");
                vec![
                    ImageStep::Sips(sips_args(input, "png", None, &intermediate)),
                    ImageStep::Ffmpeg(avif_args(&intermediate, compression.av1_crf(), output)),
                ]
            } else {
                vec![ImageStep::Ffmpeg(avif_args(input, compression.av1_crf(), output))]
            }
        }

        _ => unreachable!("guarded by is_image above"),
    };

    let lossless = matches!(format, OutputFormat::Png);
    Ok(ImagePlan { steps, lossless })
}

fn sips_args(input: &Path, format: &str, quality: Option<u8>, output: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec!["-s".into(), "format".into(), format.into()];
    if let Some(q) = quality {
        args.push("-s".into());
        args.push("formatOptions".into());
        args.push(q.to_string());
    }
    args.push(input.to_string_lossy().to_string());
    args.push("--out".into());
    args.push(output.to_string_lossy().to_string());
    args
}

fn webp_args(input: &Path, quality: u8, output: &Path) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        input.to_string_lossy().to_string(),
        "-c:v".into(),
        "libwebp".into(),
        "-quality".into(),
        quality.to_string(),
        "-preset".into(),
        "picture".into(),
        output.to_string_lossy().to_string(),
    ]
}

/// AVIF via libaom-av1.
///
/// `-cpu-used 6` is not a quality compromise, it is the difference between
/// usable and not: on a 12 MP photograph libaom's default effort took 19.6s and
/// produced 1,317,118 bytes, while `-cpu-used 6` took 2.3s and produced
/// 1,312,226 bytes — 8.6x faster and very slightly *smaller*. `-frames:v 1`
/// keeps the muxer to a still image rather than a one-frame video.
fn avif_args(input: &Path, crf: u8, output: &Path) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        input.to_string_lossy().to_string(),
        "-c:v".into(),
        "libaom-av1".into(),
        "-crf".into(),
        crf.to_string(),
        "-cpu-used".into(),
        "6".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-frames:v".into(),
        "1".into(),
        output.to_string_lossy().to_string(),
    ]
}

/// Lossless PNG recompression. `-compression_level 9` is zlib effort only; the
/// pixels are identical. Measured ~12% smaller than the sips default.
fn png_optimize_args(input: &Path, output: &Path) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        input.to_string_lossy().to_string(),
        "-compression_level".into(),
        "9".into(),
        output.to_string_lossy().to_string(),
    ]
}

/// Suffix for the generated filename, so a compressed export is distinguishable.
pub fn name_suffix(compression: Compression, format: OutputFormat) -> Option<&'static str> {
    match (compression, format) {
        (Compression::None, _) => None,
        (Compression::Optimize, _) => None,
        (_, OutputFormat::Png) => None,
        _ => Some("-compressed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(src: &str, format: OutputFormat, c: Compression) -> ImagePlan {
        build_plan(
            Path::new("/in.img"),
            src,
            format,
            c,
            false,
            Path::new("/work"),
            Path::new("/out.img"),
        )
        .unwrap()
    }

    #[test]
    fn heic_to_jpg_is_a_single_sips_pass() {
        let p = plan("heic", OutputFormat::Jpg, Compression::None);
        assert_eq!(p.steps.len(), 1);
        assert!(matches!(p.steps[0], ImageStep::Sips(_)));
    }

    #[test]
    fn jpg_quality_tracks_the_preset() {
        for (c, q) in [
            (Compression::None, "100"),
            (Compression::Light, "90"),
            (Compression::Balanced, "80"),
            (Compression::Strong, "65"),
        ] {
            let p = plan("heic", OutputFormat::Jpg, c);
            let ImageStep::Sips(args) = &p.steps[0] else { panic!("expected sips") };
            assert!(args.iter().any(|a| a == q), "{c:?} should encode at {q}");
        }
    }

    #[test]
    fn heic_to_webp_decodes_before_encoding() {
        let p = plan("heic", OutputFormat::Webp, Compression::Balanced);
        assert_eq!(p.steps.len(), 2, "HEIC needs a sips decode first");
        assert!(matches!(p.steps[0], ImageStep::Sips(_)));
        let ImageStep::Ffmpeg(args) = &p.steps[1] else { panic!("expected ffmpeg") };
        assert!(args.iter().any(|a| a == "libwebp"));
    }

    #[test]
    fn jpg_to_webp_needs_no_decode_pass() {
        let p = plan("jpeg", OutputFormat::Webp, Compression::Balanced);
        assert_eq!(p.steps.len(), 1);
        assert!(matches!(p.steps[0], ImageStep::Ffmpeg(_)));
    }

    #[test]
    fn png_output_is_always_lossless() {
        for c in [Compression::None, Compression::Optimize] {
            let p = plan("heic", OutputFormat::Png, c);
            assert!(p.lossless);
            // No quality flag may ever reach a PNG encode.
            for step in &p.steps {
                let args = match step {
                    ImageStep::Sips(a) | ImageStep::Ffmpeg(a) => a,
                };
                assert!(!args.iter().any(|a| a == "formatOptions" || a == "-quality"));
            }
        }
    }

    #[test]
    fn png_optimization_skips_the_decode_when_already_png() {
        let p = plan("png", OutputFormat::Png, Compression::Optimize);
        assert_eq!(p.steps.len(), 1);
        let ImageStep::Ffmpeg(args) = &p.steps[0] else { panic!("expected ffmpeg") };
        assert!(args.windows(2).any(|w| w == ["-compression_level", "9"]));
    }

    #[test]
    fn png_only_offers_lossless_choices() {
        assert_eq!(options_for(OutputFormat::Png), vec![Compression::None, Compression::Optimize]);
        assert_eq!(options_for(OutputFormat::Jpg).len(), 4);
    }

    #[test]
    fn a_video_container_is_rejected() {
        assert!(build_plan(
            Path::new("/in.heic"),
            "heic",
            OutputFormat::Mp4,
            Compression::None,
            false,
            Path::new("/w"),
            Path::new("/o.mp4")
        )
        .is_err());
    }

    #[test]
    fn jpg_to_avif_is_a_single_ffmpeg_pass_at_usable_speed() {
        let p = plan("jpeg", OutputFormat::Avif, Compression::Balanced);
        assert_eq!(p.steps.len(), 1);
        let ImageStep::Ffmpeg(args) = &p.steps[0] else { panic!("expected ffmpeg") };
        assert!(args.iter().any(|a| a == "libaom-av1"));
        // Without this the encoder is ~8x slower for no size benefit.
        assert!(args.windows(2).any(|w| w == ["-cpu-used", "6"]));
        assert!(args.windows(2).any(|w| w == ["-frames:v", "1"]));
    }

    #[test]
    fn heic_to_avif_decodes_before_encoding() {
        let p = plan("heic", OutputFormat::Avif, Compression::Balanced);
        assert_eq!(p.steps.len(), 2, "HEIC needs a sips decode first");
        assert!(matches!(p.steps[0], ImageStep::Sips(_)));
        assert!(matches!(p.steps[1], ImageStep::Ffmpeg(_)));
    }

    #[test]
    fn avif_quality_ladder_is_inverted() {
        // Lower CRF must mean better quality, or the chips would run backwards.
        let mut last = 0u8;
        for c in [Compression::None, Compression::Light, Compression::Balanced, Compression::Strong]
        {
            let p = plan("jpeg", OutputFormat::Avif, c);
            let ImageStep::Ffmpeg(args) = &p.steps[0] else { panic!("expected ffmpeg") };
            let i = args.iter().position(|a| a == "-crf").expect("crf");
            let crf: u8 = args[i + 1].parse().unwrap();
            assert!(crf > last, "{c:?} should compress harder than the rung before it");
            last = crf;
        }
    }

    #[test]
    fn avif_refuses_a_transparent_source_rather_than_flattening_it() {
        // libaom-av1 in the bundled build advertises no alpha pixel format, so
        // this must fail loudly instead of quietly discarding transparency.
        let err = build_plan(
            Path::new("/in.png"),
            "png",
            OutputFormat::Avif,
            Compression::Balanced,
            true,
            Path::new("/w"),
            Path::new("/o.avif"),
        )
        .unwrap_err();
        assert_eq!(err.code, "avif_alpha");

        // The formats that *can* keep it are still allowed.
        for f in [OutputFormat::Png, OutputFormat::Webp] {
            assert!(build_plan(
                Path::new("/in.png"),
                "png",
                f,
                Compression::Balanced,
                true,
                Path::new("/w"),
                Path::new("/o.img"),
            )
            .is_ok());
        }
    }
}
