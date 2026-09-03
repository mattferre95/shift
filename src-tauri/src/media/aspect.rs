//! Aspect ratio and framing.
//!
//! One place decides what shape a visual export ends up, for video, loops and
//! stills alike. The pipelines below ask this module for a `Reframe` and turn it
//! into filter arguments; none of them do the arithmetic themselves.
//!
//! Two rules shape everything here:
//!
//! **Nothing is ever stretched.** A ratio change is a crop or a pad, never a
//! non-uniform scale. There is deliberately no "stretch" mode to select.
//!
//! **Nothing is upscaled unless the user typed a number asking for it.** The
//! preset ratios are derived from the source's own pixels, so they can only ever
//! keep or discard detail. Freeform can upscale, because the user named an exact
//! size — but it reports that it is doing so, and the UI says as much.

use crate::errors::{Result, ShiftError};
use serde::{Deserialize, Serialize};

/// Smallest freeform edge worth producing.
pub const MIN_DIMENSION: u32 = 16;
/// Largest freeform edge. Well inside what libx264 and libaom will accept, and
/// far past anything an everyday export needs.
pub const MAX_DIMENSION: u32 = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AspectRatio {
    #[serde(rename = "original")]
    Original,
    #[serde(rename = "freeform")]
    Freeform,
    #[serde(rename = "16:9")]
    R16x9,
    #[serde(rename = "9:16")]
    R9x16,
    #[serde(rename = "1:1")]
    R1x1,
    #[serde(rename = "4:5")]
    R4x5,
    #[serde(rename = "4:3")]
    R4x3,
}

impl AspectRatio {
    /// The ratio as a (width, height) pair, or `None` for the two modes that
    /// are not a fixed ratio.
    pub fn parts(self) -> Option<(u32, u32)> {
        match self {
            AspectRatio::R16x9 => Some((16, 9)),
            AspectRatio::R9x16 => Some((9, 16)),
            AspectRatio::R1x1 => Some((1, 1)),
            AspectRatio::R4x5 => Some((4, 5)),
            AspectRatio::R4x3 => Some((4, 3)),
            AspectRatio::Original | AspectRatio::Freeform => None,
        }
    }
}

/// How the source is made to meet a canvas it does not already match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameMode {
    /// Crop away whatever does not fit, filling the canvas completely.
    Fill,
    /// Keep every pixel and letterbox or pillarbox the rest.
    Fit,
}

impl Default for FrameMode {
    fn default() -> Self {
        FrameMode::Fill
    }
}

/// What the frontend submits. Structured intent, as everywhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AspectSpec {
    pub ratio: AspectRatio,
    #[serde(default)]
    pub frame: FrameMode,
    /// Freeform only.
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

impl Default for AspectSpec {
    fn default() -> Self {
        AspectSpec {
            ratio: AspectRatio::Original,
            frame: FrameMode::Fill,
            width: None,
            height: None,
        }
    }
}

impl AspectSpec {
    pub fn is_original(&self) -> bool {
        self.ratio == AspectRatio::Original
    }
}

/// What Fit fills the empty area with.
///
/// Black is right for video and for any still whose format cannot carry an
/// alpha channel. Where the format *can*, transparent bars are the more useful
/// answer — a padded PNG stays compositable instead of acquiring a black
/// rectangle nobody asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PadColor {
    Black,
    Transparent,
}

impl PadColor {
    fn as_ffmpeg(self) -> &'static str {
        match self {
            PadColor::Black => "black",
            // Verified: without an alpha-capable pixel format ahead of it,
            // `black@0` is silently written as opaque black. See `filters_with`.
            PadColor::Transparent => "black@0",
        }
    }
}

/// A resolved transform: resample to `scale` (when set), then crop or pad to
/// `canvas`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reframe {
    pub source: (u32, u32),
    /// The size the source is resampled to before framing. `None` means the
    /// pixels are untouched — the common case for a preset ratio.
    pub scale: Option<(u32, u32)>,
    pub canvas: (u32, u32),
    /// A final resize applied *after* framing. Used when a size cap can be met
    /// by cropping first and shrinking second, which is strictly cheaper than
    /// shrinking pixels that are about to be cropped away.
    pub post: Option<(u32, u32)>,
    pub mode: FrameMode,
    /// True when the source had to be enlarged to satisfy the request. Only
    /// reachable from Freeform, and surfaced to the user.
    pub upscales: bool,
}

/// Round to an even number, because yuv420p chroma is subsampled by two and
/// several encoders simply refuse odd dimensions.
fn even(v: f64) -> u32 {
    let r = v.round().max(2.0) as u32;
    if r % 2 == 1 {
        r - 1
    } else {
        r
    }
}

/// A transform that changes nothing, as a starting point for callers that want
/// to apply only a size cap.
pub fn identity(source: (u32, u32)) -> Reframe {
    Reframe {
        source,
        scale: None,
        canvas: source,
        post: None,
        mode: FrameMode::Fill,
        upscales: false,
    }
}

impl Reframe {

    /// Whether this transform would actually change anything.
    ///
    /// Not the same as "no scale was set": asking for 16:9 from a source that
    /// is already 16:9 produces a scale to its own size and a canvas of the
    /// same shape, which is a no-op that would otherwise reach FFmpeg as an
    /// empty filter graph and fail.
    pub fn is_identity(&self) -> bool {
        self.filters().is_empty()
    }

    /// The size the finished frame actually is.
    pub fn final_size(&self) -> (u32, u32) {
        self.post.unwrap_or(self.canvas)
    }

    /// The size the frame actually has when it reaches the framing step.
    fn incoming(&self) -> (u32, u32) {
        self.scale.unwrap_or(self.source)
    }

    /// Shrink the whole transform so the canvas's longest edge is at most
    /// `longest`. Never enlarges.
    ///
    /// This is what lets a loop preset stay meaningful after a reframe: a 9:16
    /// GIF is capped on its long edge like any other, instead of becoming three
    /// times the pixels because only width was considered.
    pub fn capped(&self, longest: u32) -> Reframe {
        let current = self.final_size().0.max(self.final_size().1);
        if current <= longest {
            return *self;
        }
        let f = longest as f64 / current as f64;
        let mut out = *self;

        if self.scale.is_none() && self.mode == FrameMode::Fill {
            // A pure crop. Cropping at full resolution and shrinking the result
            // is cheaper than shrinking the whole frame and then throwing part
            // of it away, and the output is identical.
            out.post = Some((even(self.canvas.0 as f64 * f), even(self.canvas.1 as f64 * f)));
        } else {
            // There is already a resample in the chain, so fold the cap into it
            // rather than adding a second one.
            out.canvas = (even(self.canvas.0 as f64 * f), even(self.canvas.1 as f64 * f));
            let incoming = self.incoming();
            out.scale = Some((even(incoming.0 as f64 * f), even(incoming.1 as f64 * f)));
            out.post = self.post.map(|(w, h)| (even(w as f64 * f), even(h as f64 * f)));
            out.fix_up();
        }
        out
    }

    /// Keep the invariant the filters depend on: Fill must feed the crop
    /// something at least as large as the canvas, Fit must feed the pad
    /// something no larger. Rounding to even can put either out by a pixel.
    fn fix_up(&mut self) {
        let Some((mut w, mut h)) = self.scale else { return };
        match self.mode {
            FrameMode::Fill => {
                w = w.max(self.canvas.0);
                h = h.max(self.canvas.1);
            }
            FrameMode::Fit => {
                w = w.min(self.canvas.0);
                h = h.min(self.canvas.1);
            }
        }
        self.scale = Some((w, h));
    }

    /// The FFmpeg filter chain with black padding — video, and anything that
    /// cannot hold an alpha channel.
    pub fn filters(&self) -> Vec<String> {
        self.filters_with(PadColor::Black)
    }

    /// The FFmpeg filter chain, in the order it must run.
    pub fn filters_with(&self, pad: PadColor) -> Vec<String> {
        let mut out = Vec::new();
        if let Some((w, h)) = self.scale {
            if (w, h) != self.source {
                out.push(format!("scale={w}:{h}:flags=lanczos"));
                // `scale` rewrites the sample aspect ratio to preserve the
                // display aspect it thinks it is changing, which leaves
                // non-square pixels a player then stretches back — a fraction
                // of a percent, but a stretch, and this module promises none.
                out.push("setsar=1".into());
            }
        }
        let incoming = self.incoming();
        if incoming != self.canvas {
            let (w, h) = self.canvas;
            match self.mode {
                // Centred: what the eye expects, and the only choice that does
                // not need a UI to explain it.
                FrameMode::Fill => {
                    out.push(format!("crop={w}:{h}:(in_w-out_w)/2:(in_h-out_h)/2"));
                }
                FrameMode::Fit => {
                    // The format conversion is not decoration. Asked to pad
                    // with `black@0` on a frame that has no alpha channel,
                    // FFmpeg drops the transparency and writes opaque black
                    // without complaint; this is what makes the request real.
                    if pad == PadColor::Transparent {
                        out.push("format=rgba".into());
                    }
                    out.push(format!("pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:{}", pad.as_ffmpeg()));
                }
            }
        }
        if let Some((w, h)) = self.post {
            if (w, h) != self.canvas {
                out.push(format!("scale={w}:{h}:flags=lanczos"));
            }
        }
        out
    }
}

/// Work out what a request means for a source of a given size.
///
/// Returns `None` when there is nothing to do, so callers can keep their
/// stream-copy fast paths.
pub fn resolve(source: (u32, u32), spec: &AspectSpec) -> Result<Option<Reframe>> {
    // Checked inside the arms, not before them: Original is defined without
    // reference to the source's size, so an unreadable size must not stop it.
    match spec.ratio {
        AspectRatio::Original => Ok(None),
        AspectRatio::Freeform => {
            measurable(source)?;
            let (w, h) = (
                spec.width.ok_or_else(|| missing_dimension())?,
                spec.height.ok_or_else(|| missing_dimension())?,
            );
            Ok(non_trivial(freeform(source, w, h, spec.frame)?))
        }
        _ => {
            measurable(source)?;
            let (rw, rh) = spec.ratio.parts().expect("a fixed ratio");
            Ok(non_trivial(preset(source, rw, rh, spec.frame)))
        }
    }
}

/// Drop a transform that would not change anything, so callers keep their
/// stream-copy fast paths and FFmpeg is never handed an empty filter graph.
fn non_trivial(r: Reframe) -> Option<Reframe> {
    if r.is_identity() {
        None
    } else {
        Some(r)
    }
}

/// Every mode but Original needs to know how big the source is.
fn measurable(source: (u32, u32)) -> Result<()> {
    if source.0 == 0 || source.1 == 0 {
        return Err(ShiftError::new("unknown_dimensions", "SHIFT couldn't read this file's size.")
            .hint("Choose Original, which needs no measurements."));
    }
    Ok(())
}

fn missing_dimension() -> ShiftError {
    ShiftError::new("invalid_dimensions", "Enter a width and a height.")
        .hint("Both are needed for a custom size.")
}

/// A preset ratio, derived entirely from the source's own pixels so it can
/// never enlarge anything.
fn preset(source: (u32, u32), rw: u32, rh: u32, mode: FrameMode) -> Reframe {
    let (sw, sh) = source;
    let (sw_f, sh_f) = (sw as f64, sh as f64);
    let target = rw as f64 / rh as f64;
    let source_ratio = sw_f / sh_f;

    match mode {
        // The largest rectangle of the target ratio that fits inside the
        // source. Pure crop: not a single pixel is resampled.
        FrameMode::Fill => {
            let (w, h) = if source_ratio >= target {
                (sh_f * target, sh_f)
            } else {
                (sw_f, sw_f / target)
            };
            let canvas = (even(w).min(even(sw_f)), even(h).min(even(sh_f)));
            Reframe { source, scale: None, canvas, post: None, mode, upscales: false }
        }
        // A canvas of the target ratio whose longest edge matches the source's
        // longest edge, with the source scaled down to sit inside it. Padding
        // alone would give a technically correct but absurd canvas — a 16:9
        // 1920x1080 letterboxed to 9:16 would be 1920x3413 — so the canvas is
        // held to the source's own scale and the picture shrinks to suit.
        FrameMode::Fit => {
            let cap = sw_f.max(sh_f);
            let (cw, ch) = if target >= 1.0 { (cap, cap / target) } else { (cap * target, cap) };
            let f = (cw / sw_f).min(ch / sh_f);
            let mut r = Reframe {
                source,
                scale: Some((even(sw_f * f), even(sh_f * f))),
                canvas: (even(cw), even(ch)),
                post: None,
                mode,
                upscales: false,
            };
            r.fix_up();
            r
        }
    }
}

/// An exact size the user typed.
fn freeform(source: (u32, u32), w: u32, h: u32, mode: FrameMode) -> Result<Reframe> {
    for v in [w, h] {
        if v < MIN_DIMENSION || v > MAX_DIMENSION {
            return Err(ShiftError::new(
                "invalid_dimensions",
                format!("Width and height must be between {MIN_DIMENSION} and {MAX_DIMENSION}."),
            )
            .hint("Enter a size in pixels."));
        }
    }

    let (sw, sh) = source;
    let canvas = (even(w as f64), even(h as f64));
    let (cw, ch) = (canvas.0 as f64, canvas.1 as f64);
    let (sw_f, sh_f) = (sw as f64, sh as f64);

    // Fill covers the canvas and crops the overflow; Fit sits inside it and
    // pads the rest. Either way both axes move by the same factor, which is
    // what keeps this a reframe rather than a stretch.
    let f = match mode {
        FrameMode::Fill => (cw / sw_f).max(ch / sh_f),
        FrameMode::Fit => (cw / sw_f).min(ch / sh_f),
    };

    let mut r = Reframe {
        source,
        scale: Some((even(sw_f * f), even(sh_f * f))),
        canvas,
        post: None,
        mode,
        // Strictly greater: a factor of exactly 1 is a crop or a pad, not an
        // enlargement.
        upscales: f > 1.0,
    };
    r.fix_up();
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANDSCAPE: (u32, u32) = (1920, 1080);
    const PORTRAIT: (u32, u32) = (1080, 1920);

    fn spec(ratio: AspectRatio, frame: FrameMode) -> AspectSpec {
        AspectSpec { ratio, frame, width: None, height: None }
    }

    fn got(source: (u32, u32), ratio: AspectRatio, frame: FrameMode) -> Reframe {
        resolve(source, &spec(ratio, frame)).unwrap().expect("a transform")
    }

    /// How far the canvas is from the ratio it claims, as a fraction.
    fn ratio_error(r: &Reframe, rw: u32, rh: u32) -> f64 {
        let want = rw as f64 / rh as f64;
        let have = r.canvas.0 as f64 / r.canvas.1 as f64;
        (have - want).abs() / want
    }

    #[test]
    fn original_changes_nothing() {
        assert!(resolve(LANDSCAPE, &AspectSpec::default()).unwrap().is_none());
        assert!(resolve(PORTRAIT, &spec(AspectRatio::Original, FrameMode::Fit)).unwrap().is_none());
    }

    #[test]
    fn a_ratio_the_source_already_has_is_a_no_op() {
        // 1920x1080 is already 16:9 — asking for it must not produce a pass.
        // Fit is the case that used to slip through: it sets a scale to the
        // source's own size, which is not None but is still nothing to do, and
        // reached FFmpeg as an empty filter graph.
        for mode in [FrameMode::Fill, FrameMode::Fit] {
            assert!(
                resolve(LANDSCAPE, &spec(AspectRatio::R16x9, mode)).unwrap().is_none(),
                "16:9 {mode:?} on a 16:9 source"
            );
        }
        // Same for a freeform size that happens to be the source's own.
        let same = AspectSpec {
            ratio: AspectRatio::Freeform,
            frame: FrameMode::Fit,
            width: Some(1920),
            height: Some(1080),
        };
        assert!(resolve(LANDSCAPE, &same).unwrap().is_none());
    }

    #[test]
    fn a_resolved_transform_always_has_something_to_do() {
        // An empty filter chain is not a harmless no-op: FFmpeg refuses it.
        for src in [LANDSCAPE, PORTRAIT, (640, 360), (1000, 1000), (33, 17)] {
            for ratio in [
                AspectRatio::R16x9,
                AspectRatio::R9x16,
                AspectRatio::R1x1,
                AspectRatio::R4x5,
                AspectRatio::R4x3,
            ] {
                for mode in [FrameMode::Fill, FrameMode::Fit] {
                    if let Some(r) = resolve(src, &spec(ratio, mode)).unwrap() {
                        assert!(
                            !r.filters().is_empty(),
                            "{src:?} {ratio:?} {mode:?} resolved to an empty chain"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn landscape_to_portrait_fill_crops_without_resampling() {
        let r = got(LANDSCAPE, AspectRatio::R9x16, FrameMode::Fill);
        assert_eq!(r.scale, None, "Fill on a preset must not resample");
        assert_eq!(r.canvas, (608, 1080));
        assert!(!r.upscales);
        assert!(ratio_error(&r, 9, 16) < 0.005);
        // Crop only, and it can only ever discard.
        assert!(r.canvas.0 <= LANDSCAPE.0 && r.canvas.1 <= LANDSCAPE.1);
        let f = r.filters();
        assert_eq!(f.len(), 1);
        assert!(f[0].starts_with("crop=608:1080:"), "{f:?}");
    }

    #[test]
    fn landscape_to_portrait_fit_pads_and_keeps_everything() {
        let r = got(LANDSCAPE, AspectRatio::R9x16, FrameMode::Fit);
        assert_eq!(r.canvas, (1080, 1920), "a 9:16 fit of a 1080p source is 1080x1920");
        let (sw, sh) = r.scale.expect("Fit scales the picture down to sit inside the canvas");
        assert_eq!((sw, sh), (1080, 608));
        assert!(!r.upscales);
        // Every source pixel still present, uniformly scaled: no stretch.
        let fx = sw as f64 / LANDSCAPE.0 as f64;
        let fy = sh as f64 / LANDSCAPE.1 as f64;
        assert!((fx - fy).abs() < 0.01, "axes scaled differently: {fx} vs {fy}");
        let f = r.filters();
        assert!(f[0].starts_with("scale=1080:608"), "{f:?}");
        let pad = f.last().unwrap();
        assert!(pad.starts_with("pad=1080:1920:"), "{f:?}");
        assert!(pad.ends_with(":black"), "{f:?}");
    }

    #[test]
    fn landscape_to_square() {
        let fill = got(LANDSCAPE, AspectRatio::R1x1, FrameMode::Fill);
        assert_eq!(fill.canvas, (1080, 1080));
        assert_eq!(fill.scale, None);

        let fit = got(LANDSCAPE, AspectRatio::R1x1, FrameMode::Fit);
        assert_eq!(fit.canvas, (1920, 1920));
        assert_eq!(fit.scale, Some(LANDSCAPE), "a 1:1 fit of 1080p needs no resampling");
    }

    #[test]
    fn portrait_to_four_five() {
        let r = got(PORTRAIT, AspectRatio::R4x5, FrameMode::Fill);
        assert_eq!(r.canvas, (1080, 1350));
        assert!(ratio_error(&r, 4, 5) < 0.005);
        assert!(r.canvas.1 <= PORTRAIT.1);
    }

    #[test]
    fn landscape_to_four_three() {
        let r = got(LANDSCAPE, AspectRatio::R4x3, FrameMode::Fill);
        assert_eq!(r.canvas, (1440, 1080));
        assert!(ratio_error(&r, 4, 3) < 0.005);
    }

    #[test]
    fn every_preset_is_close_to_the_ratio_it_names_and_never_enlarges() {
        let sources = [LANDSCAPE, PORTRAIT, (640, 360), (1000, 1000), (1234, 567)];
        let ratios = [
            (AspectRatio::R16x9, 16, 9),
            (AspectRatio::R9x16, 9, 16),
            (AspectRatio::R1x1, 1, 1),
            (AspectRatio::R4x5, 4, 5),
            (AspectRatio::R4x3, 4, 3),
        ];
        for src in sources {
            for (ratio, rw, rh) in ratios {
                for mode in [FrameMode::Fill, FrameMode::Fit] {
                    let Some(r) = resolve(src, &spec(ratio, mode)).unwrap() else { continue };
                    assert!(
                        ratio_error(&r, rw, rh) < 0.02,
                        "{src:?} → {rw}:{rh} {mode:?} gave {:?}",
                        r.canvas
                    );
                    assert!(!r.upscales, "a preset must never enlarge: {src:?} {rw}:{rh} {mode:?}");
                    // No preset may resample above the source's own resolution.
                    if let Some((w, h)) = r.scale {
                        assert!(w <= src.0 && h <= src.1, "{src:?} scaled up to {w}x{h}");
                    }
                    assert_eq!(r.canvas.0 % 2, 0, "odd width from {src:?} {rw}:{rh} {mode:?}");
                    assert_eq!(r.canvas.1 % 2, 0, "odd height from {src:?} {rw}:{rh} {mode:?}");
                }
            }
        }
    }

    #[test]
    fn nothing_is_ever_stretched() {
        // Every transform either leaves the picture alone or scales both axes
        // by the same factor. A stretch would show up as a mismatch here.
        for src in [LANDSCAPE, PORTRAIT, (800, 600)] {
            for ratio in [
                AspectRatio::R16x9,
                AspectRatio::R9x16,
                AspectRatio::R1x1,
                AspectRatio::R4x5,
                AspectRatio::R4x3,
            ] {
                for mode in [FrameMode::Fill, FrameMode::Fit] {
                    let Some(r) = resolve(src, &spec(ratio, mode)).unwrap() else { continue };
                    let Some((w, h)) = r.scale else { continue };
                    let fx = w as f64 / src.0 as f64;
                    let fy = h as f64 / src.1 as f64;
                    assert!(
                        (fx - fy).abs() / fx.max(fy) < 0.02,
                        "{src:?} {ratio:?} {mode:?} scaled {fx} x {fy}"
                    );
                }
            }
        }
    }

    // ------------------------------------------------------------ freeform

    fn custom(source: (u32, u32), w: u32, h: u32, mode: FrameMode) -> Result<Option<Reframe>> {
        resolve(
            source,
            &AspectSpec {
                ratio: AspectRatio::Freeform,
                frame: mode,
                width: Some(w),
                height: Some(h),
            },
        )
    }

    #[test]
    fn freeform_hits_the_size_asked_for() {
        let r = custom(LANDSCAPE, 800, 800, FrameMode::Fill).unwrap().unwrap();
        assert_eq!(r.canvas, (800, 800));
        assert!(!r.upscales, "800 fits inside 1080, so nothing is enlarged");
        let (w, h) = r.scale.unwrap();
        assert!(w >= 800 && h >= 800, "Fill must cover the canvas before cropping");
    }

    #[test]
    fn freeform_fit_never_crops() {
        let r = custom(LANDSCAPE, 800, 800, FrameMode::Fit).unwrap().unwrap();
        let (w, h) = r.scale.unwrap();
        assert!(w <= 800 && h <= 800, "Fit must sit inside the canvas");
        assert!(r.filters().iter().any(|f| f.starts_with("pad=800:800")));
    }

    #[test]
    fn freeform_reports_an_upscale_rather_than_hiding_it() {
        let up = custom((640, 360), 1920, 1080, FrameMode::Fill).unwrap().unwrap();
        assert!(up.upscales, "asking for more pixels than exist must be reported");

        let down = custom((1920, 1080), 640, 360, FrameMode::Fill).unwrap().unwrap();
        assert!(!down.upscales);

        // Exactly the source size is nothing to do at all, so there is no pass
        // to flag — and no pointless re-encode either.
        assert!(custom((1920, 1080), 1920, 1080, FrameMode::Fill).unwrap().is_none());
    }

    #[test]
    fn freeform_rejects_nonsense_dimensions() {
        for (w, h) in [(0, 100), (100, 0), (8, 100), (100, 9), (9000, 100), (100, 20000)] {
            let err = custom(LANDSCAPE, w, h, FrameMode::Fill).unwrap_err();
            assert_eq!(err.code, "invalid_dimensions", "{w}x{h} should be refused");
        }
        // A missing half is refused too, rather than guessed at.
        let half = resolve(
            LANDSCAPE,
            &AspectSpec {
                ratio: AspectRatio::Freeform,
                frame: FrameMode::Fill,
                width: Some(400),
                height: None,
            },
        );
        assert_eq!(half.unwrap_err().code, "invalid_dimensions");
    }

    #[test]
    fn freeform_dimensions_come_out_even() {
        let r = custom(LANDSCAPE, 401, 777, FrameMode::Fill).unwrap().unwrap();
        assert_eq!(r.canvas.0 % 2, 0);
        assert_eq!(r.canvas.1 % 2, 0);
    }

    // --------------------------------------------------------------- edges

    #[test]
    fn a_very_small_source_still_produces_something_valid() {
        for src in [(16, 16), (32, 18), (2, 2)] {
            for ratio in [AspectRatio::R16x9, AspectRatio::R9x16, AspectRatio::R1x1] {
                for mode in [FrameMode::Fill, FrameMode::Fit] {
                    let Some(r) = resolve(src, &spec(ratio, mode)).unwrap() else { continue };
                    assert!(r.canvas.0 >= 2 && r.canvas.1 >= 2, "{src:?} collapsed to {:?}", r.canvas);
                    assert_eq!(r.canvas.0 % 2, 0);
                    assert_eq!(r.canvas.1 % 2, 0);
                    if let Some((w, h)) = r.scale {
                        assert!(w >= 2 && h >= 2);
                    }
                }
            }
        }
    }

    #[test]
    fn a_source_of_unknown_size_is_refused_rather_than_guessed() {
        assert_eq!(
            resolve((0, 0), &spec(AspectRatio::R1x1, FrameMode::Fill)).unwrap_err().code,
            "unknown_dimensions"
        );
        // Original needs no measurements, so it still works.
        assert!(resolve((0, 0), &AspectSpec::default()).unwrap().is_none());
    }

    #[test]
    fn capping_shrinks_the_whole_transform_together() {
        let r = got(LANDSCAPE, AspectRatio::R9x16, FrameMode::Fit);
        let small = r.capped(480);
        assert_eq!(small.canvas.0.max(small.canvas.1), 480);
        assert!(ratio_error(&small, 9, 16) < 0.02);
        let (w, h) = small.scale.unwrap();
        assert!(w <= small.canvas.0 && h <= small.canvas.1, "Fit must still sit inside");

        // Capping never enlarges.
        let already_small = got((640, 360), AspectRatio::R1x1, FrameMode::Fill);
        assert_eq!(already_small.capped(4000), already_small);
    }

    #[test]
    fn a_capped_fill_still_covers_its_canvas() {
        let r = got(LANDSCAPE, AspectRatio::R1x1, FrameMode::Fill).capped(320);
        let (w, h) = r.scale.unwrap_or(r.source);
        assert!(w >= r.canvas.0 && h >= r.canvas.1, "crop would read outside the frame");
    }
}

#[cfg(test)]
mod ordering_tests {
    use super::*;

    #[test]
    fn a_capped_crop_crops_first_and_shrinks_second() {
        // Shrinking the whole frame and then discarding part of it resamples
        // pixels for nothing. The output is identical either way, so the
        // cheaper order is the right one.
        let r = resolve(
            (1920, 1080),
            &AspectSpec {
                ratio: AspectRatio::R1x1,
                frame: FrameMode::Fill,
                width: None,
                height: None,
            },
        )
        .unwrap()
        .unwrap()
        .capped(480);

        let f = r.filters();
        assert_eq!(f.len(), 2, "{f:?}");
        assert!(f[0].starts_with("crop=1080:1080"), "{f:?}");
        assert!(f[1].starts_with("scale=480:480"), "{f:?}");
        assert_eq!(r.final_size(), (480, 480));
    }

    #[test]
    fn transparent_padding_declares_a_format_that_can_hold_it() {
        let r = resolve(
            (400, 200),
            &AspectSpec {
                ratio: AspectRatio::R1x1,
                frame: FrameMode::Fit,
                width: None,
                height: None,
            },
        )
        .unwrap()
        .unwrap();

        // Verified against the real encoder: `black@0` on a frame with no alpha
        // channel is silently written as opaque black, so the format conversion
        // has to come first or the request is quietly ignored.
        let clear = r.filters_with(PadColor::Transparent);
        let fmt = clear.iter().position(|f| f == "format=rgba").expect("format=rgba");
        let pad = clear.iter().position(|f| f.starts_with("pad=")).expect("pad");
        assert!(fmt < pad, "{clear:?}");
        assert!(clear[pad].ends_with(":black@0"), "{clear:?}");

        // Black padding needs neither, and must not gain an alpha channel.
        let black = r.filters_with(PadColor::Black);
        assert!(!black.iter().any(|f| f == "format=rgba"), "{black:?}");
        assert!(black.last().unwrap().ends_with(":black"), "{black:?}");
        assert!(!black.last().unwrap().ends_with("@0"), "{black:?}");

        // The default is black, which is what video wants.
        assert_eq!(r.filters(), black);
    }

    #[test]
    fn a_resample_pins_the_pixels_square() {
        // Without this, FFmpeg compensates for the resize by changing SAR, and
        // the result is displayed very slightly stretched.
        let r = resolve(
            (1280, 720),
            &AspectSpec {
                ratio: AspectRatio::R9x16,
                frame: FrameMode::Fit,
                width: None,
                height: None,
            },
        )
        .unwrap()
        .unwrap();
        let f = r.filters();
        let scale = f.iter().position(|x| x.starts_with("scale=")).expect("scale");
        assert_eq!(f[scale + 1], "setsar=1", "{f:?}");

        // A pure crop resamples nothing, so it needs no correction.
        let crop = resolve(
            (1920, 1080),
            &AspectSpec {
                ratio: AspectRatio::R1x1,
                frame: FrameMode::Fill,
                width: None,
                height: None,
            },
        )
        .unwrap()
        .unwrap();
        assert!(!crop.filters().iter().any(|x| x == "setsar=1"), "{:?}", crop.filters());
    }

    #[test]
    fn a_crop_never_gains_a_pad_colour() {
        let r = resolve(
            (1920, 1080),
            &AspectSpec {
                ratio: AspectRatio::R1x1,
                frame: FrameMode::Fill,
                width: None,
                height: None,
            },
        )
        .unwrap()
        .unwrap();
        for pad in [PadColor::Black, PadColor::Transparent] {
            let f = r.filters_with(pad);
            assert!(!f.iter().any(|x| x.starts_with("pad=")), "Fill does not pad: {f:?}");
            assert!(!f.iter().any(|x| x == "format=rgba"), "and needs no alpha: {f:?}");
        }
    }

    #[test]
    fn a_capped_pad_folds_the_cap_into_the_one_scale_it_already_has() {
        let r = resolve(
            (1920, 1080),
            &AspectSpec {
                ratio: AspectRatio::R9x16,
                frame: FrameMode::Fit,
                width: None,
                height: None,
            },
        )
        .unwrap()
        .unwrap()
        .capped(480);

        let f = r.filters();
        assert_eq!(
            f.iter().filter(|x| x.starts_with("scale=")).count(),
            1,
            "no second resample should appear: {f:?}"
        );
        assert!(f[0].starts_with("scale="), "{f:?}");
        assert!(f.last().unwrap().starts_with("pad="), "{f:?}");
        assert_eq!(r.final_size().0.max(r.final_size().1), 480);
    }

    #[test]
    fn a_scale_always_precedes_the_frame_it_feeds() {
        // crop reads a window out of what it is given and pad writes around it,
        // so a resample that belongs before them must never be emitted after.
        for mode in [FrameMode::Fill, FrameMode::Fit] {
            for ratio in [AspectRatio::R16x9, AspectRatio::R9x16, AspectRatio::R4x5] {
                for src in [(1920, 1080), (1080, 1920), (640, 480)] {
                    let spec = AspectSpec { ratio, frame: mode, width: None, height: None };
                    let Some(r) = resolve(src, &spec).unwrap() else { continue };
                    let f = r.capped(480).filters();
                    let frame_at = f.iter().position(|x| x.starts_with("crop=") || x.starts_with("pad="));
                    if let (Some(i), Some(_)) = (frame_at, r.scale) {
                        assert!(f[0].starts_with("scale="), "{src:?} {ratio:?} {mode:?}: {f:?}");
                        assert!(i > 0);
                    }
                }
            }
        }
    }
}
