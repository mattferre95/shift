use shift_lib::{
    errors::Result,
    filesystem::TempDir,
    jobs::InputSpec,
    media::{
        aspect::AspectSpec,
        ffmpeg, ffprobe,
        playback::PlaybackRegistry,
        profiles::{build_plan, LoopSize, OutputFormat},
    },
    process::{run_capture, Binary, CancelToken},
    providers::{DownloadKind, PostMedia, PostMediaType, UrlMedia, UrlProvider},
};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
fn fixture(dir: &Path, video: bool) -> PathBuf {
    let out = dir.join(if video { "source.mkv" } else { "source.flac" });
    let mut args: Vec<String> = [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:duration=3",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if video {
        args.extend(
            [
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=25",
                "-t",
                "3",
                "-c:v",
                "ffv1",
            ]
            .into_iter()
            .map(String::from),
        );
    }
    args.push(out.to_string_lossy().into_owned());
    let r = run_capture(Binary::Ffmpeg, &args, &CancelToken::new()).unwrap();
    assert!(r.success, "{}", r.log());
    out
}
struct Provider {
    source: PathBuf,
    analyses: AtomicUsize,
    downloads: AtomicUsize,
}
impl UrlProvider for Provider {
    fn id(&self) -> &'static str {
        "fixture"
    }
    fn handles(&self, _: &url::Url) -> bool {
        true
    }
    fn analyze(&self, url: &url::Url, _: &Path, _: &CancelToken) -> Result<UrlMedia> {
        self.analyses.fetch_add(1, Ordering::SeqCst);
        let video = self.source.extension().unwrap() == "mkv";
        Ok(UrlMedia {
            provider: self.id().into(),
            url: url.to_string(),
            title: "Controlled tones".into(),
            author: None,
            platform: "fixture".into(),
            domain: "example.test".into(),
            media_items: vec![PostMedia {
                id: "one".into(),
                media_type: if video { PostMediaType::Video } else { PostMediaType::Audio },
                duration: Some(3.0),
                thumbnail_path: None,
                qualities: vec![],
                source: url.to_string(),
                filename_hint: Some("controlled".into()),
                width: video.then_some(320),
                height: video.then_some(180),
            }],
        })
    }
    fn download(
        &self,
        _: &url::Url,
        _: DownloadKind,
        _: &str,
        dest: &Path,
        _: &CancelToken,
        _: &mut dyn FnMut(Option<f64>),
    ) -> Result<PathBuf> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        let out = dest.join(self.source.file_name().unwrap());
        std::fs::copy(&self.source, &out).unwrap();
        Ok(out)
    }
}
#[test]
fn proxies_decode_and_url_source_is_reused_for_audio_exports() {
    for video in [false, true] {
        let dir = TempDir::create(&uuid::Uuid::new_v4().to_string()).unwrap();
        let provider = Provider {
            source: fixture(dir.path(), video),
            analyses: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
        };
        let registry = PlaybackRegistry::default();
        let input = InputSpec::Url {
            url: "https://example.test/media".into(),
            quality: Some("best".into()),
        };
        let known = provider
            .analyze(
                &url::Url::parse("https://example.test/media").unwrap(),
                dir.path(),
                &CancelToken::new(),
            )
            .unwrap();
        let id = registry.create_known(input.clone(), known.media_items.first().cloned());
        let asset = registry
            .prepare_with_provider(&id, false, Some(&provider))
            .unwrap();
        assert!(asset.proxy);
        assert_ne!(asset.source, asset.playable);
        let p = ffprobe::probe(&asset.playable, &CancelToken::new()).unwrap();
        assert_eq!(p.audio.as_ref().unwrap().codec, "aac");
        assert_eq!(p.has_video(), video);
        if video {
            assert_eq!(p.video.unwrap().codec, "h264");
        }
        let same = registry.prepare(&id, false).unwrap();
        assert!(Arc::ptr_eq(&same, &asset));
        drop(same);
        for format in [OutputFormat::Mp3, OutputFormat::Wav] {
            let lease = registry.cached(&input, true).unwrap();
            let output = dir.path().join(format!("trim.{}", format.ext()));
            let clip =
                shift_lib::validation::validate_clip("1", "2.5", lease.probe.duration).unwrap();
            let plan = build_plan(
                &lease.source,
                &lease.probe,
                format,
                Some(clip),
                LoopSize::default(),
                &AspectSpec::default(),
                &output,
            )
            .unwrap();
            ffmpeg::execute(&plan, Some(1.5), &CancelToken::new(), &mut |_| {}).unwrap();
            let out = ffprobe::probe(&output, &CancelToken::new()).unwrap();
            assert!(out.audio.is_some());
            assert!(!out.has_video());
            assert!((out.duration.unwrap() - 1.5).abs() < 0.06);
        }
        assert_eq!(provider.downloads.load(Ordering::SeqCst), 1);
        assert_eq!(
            provider.analyses.load(Ordering::SeqCst),
            1,
            "preview must reuse detected metadata"
        );
        let source = asset.source.clone();
        let preview = asset.playable.clone();
        registry.release(&id);
        assert!(source.exists(), "lease protects in-flight exports");
        drop(asset);
        assert!(!source.exists());
        assert!(!preview.exists());
        assert!(registry.cached(&input, true).is_none());
    }
}
#[test]
fn local_source_survives_reset_and_cancelled_sessions_cannot_restart() {
    let dir = TempDir::create(&uuid::Uuid::new_v4().to_string()).unwrap();
    let source = fixture(dir.path(), false);
    let registry = PlaybackRegistry::default();
    let id = registry.create(InputSpec::Local {
        path: source.to_string_lossy().into_owned(),
    });
    let asset = registry.prepare(&id, false).unwrap();
    let preview = asset.playable.clone();
    drop(asset);
    registry.clear();
    assert!(source.exists());
    assert!(!preview.exists());
    assert!(registry.prepare(&id, false).is_err());
    let id = registry.create(InputSpec::Local {
        path: "/missing/fixture.wav".into(),
    });
    assert!(registry.prepare(&id, false).is_err());
    registry.release(&id);
}
