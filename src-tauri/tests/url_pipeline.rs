//! The URL vertical slice against a live network source.
//!
//! Ignored by default: it needs the network, and a test suite should not depend
//! on a remote host. Run explicitly with:
//!     cargo test --test url_pipeline -- --ignored --nocapture
//!
//! The fixture is a publicly published sample file, so nothing here depends on
//! media anyone would need permission to fetch.

use shift_lib::media::ffmpeg;
use shift_lib::media::ffprobe;
use shift_lib::media::profiles::{build_plan, OutputFormat};
use shift_lib::process::CancelToken;
use shift_lib::providers::{self, DownloadKind};
use shift_lib::validation::{validate_url, ClipRange};

/// A 5-second published sample file. Exercises yt-dlp's generic extractor,
/// where site metadata carries no duration — so SHIFT has to get the real one
/// from its own probe of the downloaded bytes.
const SAMPLE: &str = "https://download.samplelib.com/mp4/sample-5s.mp4";

/// A real site extractor rather than the generic one, so the provider path is
/// tested the way it will actually be used.
const SITE_SAMPLE: &str = "https://archive.org/details/BigBuckBunny_124";

fn workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("shift-url-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
#[ignore = "requires network"]
fn analyzes_a_real_url() {
    let url = validate_url(SAMPLE).unwrap();
    let provider = providers::for_url(&url).expect("a provider handles http(s)");
    let media = provider.analyze(&url, &workspace("meta"), &CancelToken::new()).unwrap();

    println!("title={} domain={} duration={:?}", media.title, media.domain, media.duration);
    assert_eq!(media.provider, "ytdlp");
    assert!(!media.title.is_empty());
    // The generic extractor reports no codec detail; a plain .mp4 must still
    // offer MP4 rather than being mistaken for an audio-only source.
    assert!(media.has_video);
    // With no separate renditions there is exactly one honest choice.
    assert_eq!(media.qualities.len(), 1);
    // It reports no duration either; SHIFT must not invent one.
    assert!(media.duration.is_none() || media.duration.unwrap() > 0.0);
}

#[test]
#[ignore = "requires network"]
fn analyzes_a_site_a_real_extractor_handles() {
    let url = validate_url(SITE_SAMPLE).unwrap();
    let provider = providers::for_url(&url).unwrap();
    let media = provider.analyze(&url, &workspace("site"), &CancelToken::new()).unwrap();

    println!(
        "title={} domain={} duration={:?} qualities={:?} thumb={:?}",
        media.title, media.domain, media.duration, media.qualities, media.thumbnail_path
    );
    assert_eq!(media.domain, "archive.org");
    assert!(media.duration.unwrap() > 0.0);
    // The thumbnail is fetched through the backend, never by the webview.
    if let Some(thumb) = &media.thumbnail_path {
        assert!(std::path::Path::new(thumb).is_file());
    }
}

#[test]
#[ignore = "requires network"]
fn rejects_a_link_no_provider_can_read() {
    let url = validate_url("https://example.com/definitely-not-media").unwrap();
    let provider = providers::for_url(&url).unwrap();
    let err = provider
        .analyze(&url, &workspace("bad"), &CancelToken::new())
        .expect_err("a page with no media must fail");
    // The user sees a sentence, not a stack trace.
    assert_eq!(err.code, "fetch_failed");
    assert_eq!(err.message, "Couldn't fetch this link.");
    assert!(err.technical.is_some(), "the raw log must be kept for the details panel");
    println!("user sees: {} / {:?}", err.message, err.hint);
}

#[test]
#[ignore = "requires network"]
fn downloads_then_clips_to_mp3() {
    let url = validate_url(SAMPLE).unwrap();
    let provider = providers::for_url(&url).unwrap();
    let cancel = CancelToken::new();
    let dir = workspace("clip");

    let mut samples: Vec<Option<f64>> = Vec::new();
    let mut on_progress = |f: Option<f64>| samples.push(f);
    let downloaded = provider
        .download(&url, DownloadKind::Audio, "best", &dir, &cancel, &mut on_progress)
        .unwrap();
    assert!(downloaded.is_file());
    assert!(!samples.is_empty(), "no download progress was reported");

    let probe = ffprobe::probe(&downloaded, &cancel).unwrap();
    // Bounds the site could not have validated — only the probe of the real
    // file can, which is exactly what the job runner does before encoding.
    let clip = ClipRange { start: 1.0, end: 4.0 };
    let out = dir.join("clip.mp3");
    let plan = build_plan(&downloaded, &probe, OutputFormat::Mp3, Some(clip), &out).unwrap();
    ffmpeg::execute(&plan, Some(clip.duration()), &cancel, &mut |_| {}).unwrap();

    let result = ffprobe::probe(&out, &cancel).unwrap();
    assert!(result.video.is_none());
    let secs = result.duration.unwrap();
    assert!((secs - 3.0).abs() < 0.2, "expected a 3s clip, got {secs:.3}s");
    println!("produced {} ({:.2}s)", out.display(), secs);
}

#[test]
#[ignore = "requires network"]
fn cancelling_a_download_kills_the_process_tree() {
    let url = validate_url(SAMPLE).unwrap();
    let provider = providers::for_url(&url).unwrap();
    let cancel = CancelToken::new();
    let dir = workspace("cancel");

    let token = std::sync::Arc::clone(&cancel);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(900));
        token.cancel();
    });

    let started = std::time::Instant::now();
    let err = provider
        .download(&url, DownloadKind::Video, "best", &dir, &cancel, &mut |_| {})
        .expect_err("a cancelled download must not report success");
    assert_eq!(err.code, "cancelled");
    assert!(started.elapsed().as_secs() < 15, "cancel was not prompt");
}
