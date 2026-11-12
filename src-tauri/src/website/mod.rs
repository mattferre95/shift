//! Discover and download public website images without running page scripts.

mod discovery;

use crate::errors::{Result, ShiftError};
use crate::filesystem::{self, TempDir};
use crate::media::preview;
use crate::process::{run_capture, Binary, CancelToken};
use crate::validation;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

const IMAGE_LIMIT: usize = 500;
const PAGE_BYTES: u64 = 12 * 1024 * 1024;
const IMAGE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsitePage {
    pub title: String,
    pub url: String,
    pub folder: String,
    pub images: Vec<WebsiteImage>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteImage {
    pub url: String,
    pub preview_url: String,
    pub label: String,
    pub stem: String,
    pub group: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteDownloadRequest {
    pub job_id: String,
    pub page_url: String,
    pub folder: String,
    pub destination_dir: String,
    pub images: Vec<WebsiteImage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteDownloadResult {
    pub folder: Option<String>,
    pub saved: usize,
    pub failed: Vec<WebsiteDownloadFailure>,
    pub cancelled: bool,
}

#[derive(Debug, Serialize)]
pub struct WebsiteDownloadFailure {
    pub name: String,
    pub reason: String,
}

fn work_dir() -> Result<TempDir> {
    TempDir::create(&format!("website-{}", uuid::Uuid::new_v4()))
}

fn http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn parse_url(raw: &str) -> Result<Url> {
    let mut url = validation::validate_url(raw)?;
    if !http_url(&url) {
        return Err(ShiftError::validation(
            "Use a public website URL without credentials.",
        ));
    }
    url.set_fragment(None);
    Ok(url)
}

struct Response {
    url: Url,
    content_type: String,
}

fn fetch(
    mut url: Url,
    referer: Option<&Url>,
    dest: &Path,
    max_bytes: u64,
    cancel: &CancelToken,
) -> Result<Response> {
    for _ in 0..=5 {
        if cancel.is_cancelled() {
            return Err(ShiftError::cancelled());
        }
        let mut args = vec![
            "--silent".into(),
            "--show-error".into(),
            "--globoff".into(),
            "--proto".into(),
            "=http,https".into(),
            "--connect-timeout".into(),
            "6".into(),
            "--max-time".into(),
            "18".into(),
            "--max-filesize".into(),
            max_bytes.to_string(),
            "--output".into(),
            dest.to_string_lossy().into_owned(),
            "--write-out".into(),
            "%{http_code}\n%{content_type}\n%{redirect_url}".into(),
            "--user-agent".into(),
            concat!(
                "SHIFT/",
                env!("CARGO_PKG_VERSION"),
                " (Website image downloader)"
            )
            .into(),
        ];
        if let Some(referer) = referer {
            args.extend([
                "--referer".into(),
                format!("{}/", referer.origin().ascii_serialization()),
            ]);
        }
        args.extend(["--".into(), url.to_string()]);
        let out = run_capture(Binary::Curl, &args, cancel)?;
        if !out.success {
            if out.code == Some(63) {
                return Err(ShiftError::new(
                    "website_size",
                    "The website response exceeds SHIFT's size limit.",
                ));
            }
            return Err(ShiftError::fetch_failed(out.stderr));
        }
        let mut lines = out.stdout.lines();
        let status = lines.next().unwrap_or_default();
        let content_type = lines
            .next()
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if matches!(status, "301" | "302" | "303" | "307" | "308") {
            url = lines
                .next()
                .ok_or_else(|| ShiftError::fetch_failed("Missing redirect location"))
                .and_then(parse_url)?;
            continue;
        }
        if !status.starts_with('2') {
            return Err(ShiftError::new(
                "website_http",
                format!("The website returned HTTP {status}."),
            ));
        }
        let size = fs::metadata(dest)
            .map_err(|e| ShiftError::io("read website response", e))?
            .len();
        if size == 0 || size > max_bytes {
            return Err(ShiftError::new(
                "website_size",
                "The website returned an empty or oversized file.",
            ));
        }
        return Ok(Response { url, content_type });
    }
    Err(ShiftError::fetch_failed("Too many redirects"))
}

pub fn scrape(raw: &str) -> Result<WebsitePage> {
    let url = parse_url(raw)?;
    let temp = work_dir()?;
    let path = temp.path().join("page");
    let response = fetch(url, None, &path, PAGE_BYTES, &CancelToken::new())?;
    let html = fs::read(&path).map_err(|e| ShiftError::io("read website", e))?;
    let page = discovery::discover(&response.url, &String::from_utf8_lossy(&html));
    if page.images.is_empty() {
        return Err(ShiftError::new(
            "website_empty",
            "No downloadable images were found on this page.",
        )
        .hint("Try the direct product or gallery page."));
    }
    Ok(page)
}

fn image_format(path: &Path, content_type: &str) -> Result<(&'static str, &'static str)> {
    if let Some(kind) =
        infer::get_from_path(path).map_err(|e| ShiftError::io("read downloaded image", e))?
    {
        if kind.matcher_type() == infer::MatcherType::Image {
            return Ok((kind.extension(), kind.mime_type()));
        }
    }
    if content_type == "image/svg+xml" {
        // SVG is displayed only in an img element, where scripts are disabled.
        use std::io::Read;
        let mut header = Vec::new();
        fs::File::open(path)
            .and_then(|file| file.take(4096).read_to_end(&mut header))
            .map_err(|e| ShiftError::io("read SVG", e))?;
        if String::from_utf8_lossy(&header).contains("<svg") {
            return Ok(("svg", "image/svg+xml"));
        }
    }
    Err(ShiftError::new(
        "website_image",
        "This address didn't return a supported image.",
    ))
}

pub fn thumbnail(page_url: &str, source: &str) -> Result<String> {
    let page = parse_url(page_url)?;
    let temp = work_dir()?;
    let path = temp.path().join("image");
    let cancel = CancelToken::new();
    let response = fetch(parse_url(source)?, Some(&page), &path, IMAGE_BYTES, &cancel)?;
    let (ext, mime) = image_format(&path, &response.content_type)?;
    let size = fs::metadata(&path)
        .map_err(|e| ShiftError::io("read image size", e))?
        .len();
    if ext == "svg"
        || (size <= 256 * 1024
            && matches!(ext, "jpg" | "png" | "gif" | "webp" | "avif" | "ico" | "bmp"))
    {
        if size > 1024 * 1024 {
            return Err(ShiftError::new(
                "website_preview",
                "This image is too large to preview.",
            ));
        }
        let bytes = fs::read(&path).map_err(|e| ShiftError::io("read image preview", e))?;
        return Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
    }
    let typed_path = path.with_extension(ext);
    fs::rename(&path, &typed_path).map_err(|e| ShiftError::io("prepare image preview", e))?;
    preview::data_uri(&preview::derive(&typed_path, None, temp.path(), &cancel)?)
}

fn safe_name(raw: &str, fallback: &str) -> String {
    let mut clean = filesystem::sanitize_stem(raw).to_lowercase();
    if clean == "shift-output" {
        return fallback.to_string();
    }
    if let Some((index, _)) = clean.char_indices().find(|(index, _)| *index >= 148) {
        clean.truncate(index);
    }
    clean
}

fn create_folder(parent: &Path, name: &str) -> Result<PathBuf> {
    for n in 1..10_000 {
        let folder = if n == 1 {
            parent.join(name)
        } else {
            parent.join(format!("{name}-{n}"))
        };
        match fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(ShiftError::io("create website image folder", e)),
        }
    }
    Err(ShiftError::validation(
        "Too many folders already use that website name.",
    ))
}

fn save_image(source: &Path, folder: &Path, image: &WebsiteImage, ext: &str) -> Result<()> {
    let dir = image.group.as_ref().map_or_else(
        || folder.to_path_buf(),
        |group| folder.join(safe_name(group, "product")),
    );
    let stem = safe_name(&image.stem, "image");
    let output = filesystem::unique_path(&dir, &stem, ext);
    if let Err(error) = filesystem::finalize(source, &output) {
        let _ = fs::remove_file(&output);
        if dir != folder {
            let _ = fs::remove_dir(dir);
        }
        return Err(error);
    }
    Ok(())
}

pub fn download(
    request: WebsiteDownloadRequest,
    cancel: &CancelToken,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<WebsiteDownloadResult> {
    if request.images.is_empty() || request.images.len() > IMAGE_LIMIT {
        return Err(ShiftError::validation(format!(
            "Choose between 1 and {IMAGE_LIMIT} images."
        )));
    }
    let page = parse_url(&request.page_url)?;
    let parent = validation::validate_output_dir(&request.destination_dir)?;
    let name = safe_name(&request.folder, "website-images");
    let temp = work_dir()?;
    let path = temp.path().join("image");
    let mut folder = None;
    let mut saved = 0;
    let mut failed = Vec::new();
    let total = request.images.len();
    for (index, image) in request.images.into_iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        on_progress(index + 1, total);
        let result = (|| {
            let _ = fs::remove_file(&path);
            let response = fetch(
                parse_url(&image.url)?,
                Some(&page),
                &path,
                IMAGE_BYTES,
                cancel,
            )?;
            let (ext, _) = image_format(&path, &response.content_type)?;
            Ok(ext)
        })();
        if cancel.is_cancelled() {
            break;
        }
        let result = match result {
            Ok(ext) => {
                if folder.is_none() {
                    folder = Some(create_folder(&parent, &name)?);
                }
                save_image(&path, folder.as_deref().unwrap(), &image, ext)
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => saved += 1,
            Err(error) => failed.push(WebsiteDownloadFailure {
                name: image.stem,
                reason: error.message,
            }),
        }
    }
    if saved == 0 {
        if let Some(folder) = folder.take() {
            let _ = fs::remove_dir(folder);
        }
    }
    Ok(WebsiteDownloadResult {
        folder: folder.map(|path| path.to_string_lossy().into_owned()),
        saved,
        failed,
        cancelled: cancel.is_cancelled(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrape_rejects_a_loopback_address() {
        let error = scrape("http://127.0.0.1/").unwrap_err();
        assert_eq!(error.code, "fetch_failed");
        assert!(parse_url("https://user:password@example.com").is_err());
        assert!(parse_url("file:///etc/hosts").is_err());
    }

    #[test]
    fn creates_a_fresh_folder_and_preserves_duplicate_file_names() {
        let temp = work_dir().unwrap();
        let folder = create_folder(temp.path(), "example-com-shop").unwrap();
        assert!(create_folder(temp.path(), "example-com-shop")
            .unwrap()
            .ends_with("example-com-shop-2"));
        let path = temp.path().join("image");
        let image = WebsiteImage {
            url: String::new(),
            preview_url: String::new(),
            label: "Jacket".into(),
            stem: "../Jacket 01".into(),
            group: Some("../Jacket".into()),
        };
        for bytes in [b"first", b"other"] {
            fs::write(&path, bytes).unwrap();
            save_image(&path, &folder, &image, "jpg").unwrap();
        }
        assert_eq!(
            fs::read(folder.join("jacket/jacket-01.jpg")).unwrap(),
            b"first"
        );
        assert_eq!(
            fs::read(folder.join("jacket/jacket-01-2.jpg")).unwrap(),
            b"other"
        );
    }

    #[test]
    #[ignore = "requires the live public shop and CDN"]
    fn live_abyss_shop() {
        let page = scrape("https://www.abyssvision.com/shop-1").unwrap();
        let groups: std::collections::HashSet<_> = page
            .images
            .iter()
            .filter_map(|image| image.group.as_deref())
            .collect();
        eprintln!(
            "Found {} images across {} product groups.",
            page.images.len(),
            groups.len()
        );
        assert!(page.images.len() > 12);
        let image = page
            .images
            .into_iter()
            .find(|img| img.stem == "heritage-jacket-01")
            .unwrap();
        assert!(thumbnail(&page.url, &image.preview_url)
            .unwrap()
            .starts_with("data:image/"));
        let temp = work_dir().unwrap();
        let result = download(
            WebsiteDownloadRequest {
                job_id: String::new(),
                page_url: page.url,
                folder: page.folder,
                destination_dir: temp.path().to_string_lossy().into_owned(),
                images: vec![image],
            },
            &CancelToken::new(),
            |_, _| {},
        )
        .unwrap();
        assert_eq!(result.saved, 1, "{:?}", result.failed);
        let output =
            PathBuf::from(result.folder.unwrap()).join("heritage-jacket/heritage-jacket-01.jpg");
        assert!(fs::metadata(output).unwrap().len() > 0);
    }
}
