use super::{http_url, safe_name, WebsiteImage, WebsitePage, IMAGE_LIMIT};
use dom_query::{Document, Selection};
use percent_encoding::percent_decode_str;
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

struct Candidate {
    src: String,
    label: String,
    group: Option<String>,
    number: Option<usize>,
}

impl Candidate {
    fn plain(src: &str, label: &str) -> Self {
        Self {
            src: src.into(),
            label: label.trim().into(),
            group: None,
            number: None,
        }
    }
}

fn srcset(value: &str) -> Option<(String, u32)> {
    let mut best = None;
    // Read URL tokens before splitting descriptors. CDN URLs often contain
    // commas, including Wix's transform arguments.
    let mut rest = value;
    while !rest.is_empty() {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        if rest.is_empty() {
            break;
        }
        let url_end = rest
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let (url, remaining) = rest.split_at(url_end);
        let (descriptor, next) = if url.ends_with(',') {
            ("", remaining)
        } else {
            remaining.split_once(',').unwrap_or((remaining, ""))
        };
        rest = next;
        let score = descriptor
            .split_ascii_whitespace()
            .next()
            .and_then(|v| {
                v.strip_suffix('w')
                    .and_then(|n| n.parse().ok())
                    .or_else(|| {
                        v.strip_suffix('x')
                            .and_then(|n| n.parse::<f32>().ok())
                            .map(|n| (n * 100.0) as u32)
                    })
            })
            .unwrap_or(1);
        if !url.starts_with("data:") && best.as_ref().map_or(true, |(_, old)| score > *old) {
            best = Some((url.trim_end_matches(',').to_string(), score));
        }
    }
    best
}

fn best_srcset(element: &Selection<'_>) -> Option<(String, u32)> {
    ["data-srcset", "data-lazy-srcset", "srcset"]
        .into_iter()
        .find_map(|attr| element.attr(attr).and_then(|value| srcset(&value)))
}

fn image_source(element: &Selection<'_>) -> Option<String> {
    let attribute = |names: &[&str]| {
        names
            .iter()
            .filter_map(|name| element.attr(name))
            .find(|value| !value.trim().is_empty() && !value.starts_with("data:"))
            .map(|value| value.to_string())
    };
    attribute(&["data-original", "data-full-src"])
        .or_else(|| {
            let parent = element.parent();
            let own = best_srcset(element);
            let picture = if parent.is("picture") {
                parent
                    .select("source")
                    .iter()
                    .filter_map(|source| best_srcset(&source))
                    .max_by_key(|(_, size)| *size)
            } else {
                None
            };
            own.into_iter()
                .chain(picture)
                .max_by_key(|(_, size)| *size)
                .map(|(src, _)| src)
        })
        .or_else(|| attribute(&["data-src", "data-lazy-src", "src"]))
}

fn wix_products(value: &Value, images: &mut Vec<Candidate>) {
    if let Some((slug, gallery)) = value["urlPart"].as_str().zip(value["media"].as_array()) {
        let label = value["name"].as_str().unwrap_or(slug).trim();
        for (index, item) in gallery.iter().enumerate() {
            if let Some(src) = item["fullUrl"].as_str() {
                images.push(Candidate {
                    src: src.into(),
                    label: label.into(),
                    group: Some(slug.into()),
                    number: Some(index + 1),
                });
            }
        }
    } else if let Some(object) = value.as_object() {
        for child in object.values() {
            wix_products(child, images);
        }
    } else if let Some(array) = value.as_array() {
        for child in array {
            wix_products(child, images);
        }
    }
}

fn json_ld_products(value: &Value, images: &mut Vec<Candidate>) {
    if value["@type"] == "Product" {
        if let Some(name) = value["name"].as_str() {
            let image = &value["image"];
            let gallery = image
                .as_array()
                .map_or(std::slice::from_ref(image), Vec::as_slice);
            for (index, item) in gallery.iter().enumerate() {
                if let Some(src) = item
                    .as_str()
                    .or_else(|| item["contentUrl"].as_str())
                    .or_else(|| item["url"].as_str())
                {
                    images.push(Candidate {
                        src: src.into(),
                        label: name.into(),
                        group: Some(name.into()),
                        number: Some(index + 1),
                    });
                }
            }
        }
    } else if let Some(object) = value.as_object() {
        for child in object.values() {
            json_ld_products(child, images);
        }
    } else if let Some(array) = value.as_array() {
        for child in array {
            json_ld_products(child, images);
        }
    }
}

fn wix_original(url: &Url) -> Option<(Url, Url)> {
    if url.host_str() != Some("static.wixstatic.com") {
        return None;
    }
    let mut parts = url.path_segments()?;
    if parts.next()? != "media" {
        return None;
    }
    let file = parts.next()?;
    let (_, ext) = file.rsplit_once('.')?;
    if !matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif"
    ) {
        return None;
    }
    let original = Url::parse(&format!("https://static.wixstatic.com/media/{file}")).ok()?;
    let preview = Url::parse(&format!("{original}/v1/fit/w_420,h_420,q_85/file.{ext}")).ok()?;
    Some((original, preview))
}

fn filename_stem(url: &Url) -> Option<String> {
    let file = url.path_segments()?.next_back()?;
    let file = percent_decode_str(file).decode_utf8_lossy();
    let stem = std::path::Path::new(file.as_ref()).file_stem()?.to_str()?;
    (!stem.is_empty()).then(|| stem.to_string())
}

pub(super) fn discover(url: &Url, html: &str) -> WebsitePage {
    let document = Document::from(html);
    let base = document
        .base_uri()
        .and_then(|base| url.join(&base).ok())
        .filter(http_url)
        .unwrap_or_else(|| url.clone());

    let mut candidates = Vec::new();
    if let Ok(catalog) = serde_json::from_str(&document.select_single("#wix-warmup-data").text()) {
        wix_products(&catalog, &mut candidates);
    }
    for script in document.select("script[type='application/ld+json']").iter() {
        if let Ok(data) = serde_json::from_str(&script.text()) {
            json_ld_products(&data, &mut candidates);
        }
    }
    for element in document.select("img, [style*='url(']").iter() {
        if element.is("img") {
            if let Some(src) = image_source(&element) {
                candidates.push(Candidate::plain(
                    &src,
                    &element.attr("alt").unwrap_or_default(),
                ));
            }
        }
        if let Some(style) = element.attr("style") {
            for style_url in style.split("url(").skip(1) {
                if let Some((src, _)) = style_url.split_once(')') {
                    candidates.push(Candidate::plain(
                        src.trim().trim_matches(['\'', '"']),
                        &element.attr("aria-label").unwrap_or_default(),
                    ));
                }
            }
        }
    }
    for meta in document.select("meta[content]").iter() {
        let kind = meta
            .attr("property")
            .or_else(|| meta.attr("name"))
            .unwrap_or_default();
        if matches!(
            &*kind,
            "og:image"
                | "og:image:url"
                | "og:image:secure_url"
                | "twitter:image"
                | "twitter:image:src"
        ) {
            candidates.push(Candidate::plain(
                &meta.attr("content").unwrap_or_default(),
                "",
            ));
        }
    }
    let mut seen = HashSet::new();
    let mut images = Vec::new();
    let mut truncated = false;
    for candidate in candidates {
        if candidate.src.trim().is_empty() {
            continue;
        }
        let Some(mut resolved) = base.join(candidate.src.trim()).ok().filter(http_url) else {
            continue;
        };
        resolved.set_fragment(None);
        let (original, preview) =
            wix_original(&resolved).unwrap_or_else(|| (resolved.clone(), resolved.clone()));
        if !seen.insert(original.clone()) {
            continue;
        }
        if images.len() == IMAGE_LIMIT {
            truncated = true;
            break;
        }

        let group = candidate.group.map(|group| safe_name(&group, "product"));
        let fallback = format!("image-{:03}", images.len() + 1);
        let stem = match (&group, candidate.number) {
            (Some(group), Some(number)) => format!("{group}-{number:02}"),
            _ if !candidate.label.is_empty() => {
                // Strip a filename extension from alt text only when it matches the source.
                let label = candidate
                    .label
                    .rsplit_once('.')
                    .filter(|(_, ext)| {
                        resolved
                            .path()
                            .rsplit_once('.')
                            .is_some_and(|(_, url_ext)| ext.eq_ignore_ascii_case(url_ext))
                    })
                    .map_or(candidate.label.as_str(), |(stem, _)| stem);
                safe_name(label, &fallback)
            }
            _ if original != resolved => safe_name(
                &filename_stem(&resolved)
                    .filter(|name| {
                        !name.contains("~mv2") && !name.contains("_mv2") && name != "file"
                    })
                    .unwrap_or(fallback.clone()),
                &fallback,
            ),
            _ => safe_name(
                &filename_stem(&original).unwrap_or(fallback.clone()),
                &fallback,
            ),
        };
        images.push(WebsiteImage {
            label: if candidate.label.is_empty() {
                stem.clone()
            } else {
                candidate.label
            },
            stem,
            group,
            url: original.into(),
            preview_url: preview.into(),
        });
    }

    let host = url
        .host_str()
        .unwrap_or("website")
        .trim_start_matches("www.");
    let slug = url
        .path_segments()
        .and_then(|parts| parts.filter(|s| !s.is_empty()).next_back());
    let folder = safe_name(
        &match slug {
            Some(slug) => format!("{host}-{}", percent_decode_str(slug).decode_utf8_lossy()),
            None => host.to_string(),
        },
        "website-images",
    );
    let document_title = document.select_single("title").text();
    let title = document_title.trim();
    WebsitePage {
        title: if title.is_empty() {
            host.to_string()
        } else {
            title.chars().take(160).collect()
        },
        folder,
        url: url.to_string(),
        images,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_relative_lazy_picture_and_metadata_images_without_duplicates() {
        let page = discover(
            &Url::parse("https://example.com/shop/").unwrap(),
            r#"
            <title>Images &amp; Art</title>
            <base href="/assets/">
            <script>let ignored = '<img src="fake.jpg">';</script>
            <picture>
              <source srcset="thumb.jpg 200w, full,a.jpg 1600w">
              <img src="thumb.jpg" alt="Look &amp; feel">
            </picture>
            <img src="full,a.jpg#again">
            <img data-src="poster.png" src="data:image/gif;base64,AAA">
            <meta property="og:image" content="//cdn.example.com/share.jpg">
            <div style="background-image:url('back.jpg')"></div>
            <img src="file:///tmp/nope">
        "#,
        );
        assert_eq!(page.title, "Images & Art");
        assert_eq!(page.folder, "example-com-shop");
        assert_eq!(
            page.images
                .iter()
                .map(|image| (image.stem.as_str(), image.url.as_str()))
                .collect::<Vec<_>>(),
            [
                ("look-feel", "https://example.com/assets/full,a.jpg"),
                ("poster", "https://example.com/assets/poster.png"),
                ("back", "https://example.com/assets/back.jpg"),
                ("share", "https://cdn.example.com/share.jpg"),
            ]
        );
    }

    #[test]
    fn wix_catalog_adds_gallery_images_with_product_names_and_original_urls() {
        let page = discover(
            &Url::parse("https://www.example.com/shop-1").unwrap(),
            r#"
            <img src="https://static.wixstatic.com/media/id.jpg/v1/fill/w_100,h_100/id.jpg">
            <script type="application/json" id="wix-warmup-data">
              {"catalog":{"list":[{"name":"Heritage Jacket", "urlPart":"heritage-jacket", "media":[
                {"fullUrl":"https://static.wixstatic.com/media/id.jpg/v1/fit/w_500,h_500/file.jpg"},
                {"fullUrl":"https://static.wixstatic.com/media/back.png/v1/fit/w_500,h_500/file.png"}
              ]}]}}
            </script>
        "#,
        );
        assert_eq!(page.images.len(), 2);
        assert_eq!(page.images[0].label, "Heritage Jacket");
        assert_eq!(page.images[0].group.as_deref(), Some("heritage-jacket"));
        assert_eq!(page.images[1].stem, "heritage-jacket-02");
        assert_eq!(
            page.images[1].url,
            "https://static.wixstatic.com/media/back.png"
        );
        assert!(page.images[1].preview_url.contains("/v1/fit/w_420,h_420"));
    }
}
