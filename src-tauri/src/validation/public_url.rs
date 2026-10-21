//! Resolve public HTTP redirects before handing a URL to a media extractor.
//! Each request is pinned to an address that was checked for public reachability.

use crate::errors::{Result, ShiftError};
use std::collections::HashSet;
use std::net::{IpAddr, ToSocketAddrs};
use std::process::Command;
use url::Url;

const MAX_REDIRECTS: usize = 8;

pub fn resolve_public_url(url: &Url) -> Result<Url> {
    resolve_with(url, resolve_addresses, probe_head)
}

fn resolve_with(
    url: &Url,
    addresses: impl Fn(&Url) -> Result<Vec<IpAddr>>,
    probe: impl Fn(&Url, IpAddr) -> Result<Option<String>>,
) -> Result<Url> {
    let mut current = url.clone();
    let mut seen = HashSet::new();
    for hop in 0..=MAX_REDIRECTS {
        let ips = validate_public_target(&current, &addresses)?;
        if !seen.insert(current.as_str().to_string()) {
            return Err(resolution_error("The link redirects in a loop."));
        }
        let ip = ips[0];
        let Some(location) = probe(&current, ip)? else {
            return Ok(current);
        };
        if hop == MAX_REDIRECTS {
            return Err(resolution_error("The link redirects too many times."));
        }
        current = current
            .join(&location)
            .map_err(|_| resolution_error("The link has an invalid redirect."))?;
        current.set_fragment(None);
    }
    unreachable!()
}

fn validate_public_target(
    url: &Url,
    addresses: &impl Fn(&Url) -> Result<Vec<IpAddr>>,
) -> Result<Vec<IpAddr>> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ShiftError::invalid_url());
    }
    let ips = addresses(url)?;
    if ips.is_empty() || ips.iter().any(|ip| !public_ip(*ip)) {
        return Err(ShiftError::new(
            "unsafe_url",
            "This link points to a local or private network address.",
        ));
    }
    Ok(ips)
}

pub(crate) fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || a == 169 && b == 254
                || a == 172 && (16..=31).contains(&b)
                || a == 192 && (b == 168 || b == 0)
                || a == 192 && b == 88 && c == 99
                || a == 100 && (64..=127).contains(&b)
                || a == 198 && (b == 18 || b == 19)
                || a == 192 && b == 0 && c == 2
                || a == 198 && b == 51 && c == 100
                || a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(v) => {
            if let Some(mapped) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(mapped));
            }
            let first = v.segments()[0];
            let segments = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                // Global unicast only. Exclude transition/tunnel prefixes
                // that can encode an IPv4 destination inside IPv6.
                || first & 0xe000 != 0x2000
                || first == 0x2002
                || first == 0x2001 && segments[1] == 0
                || first == 0x2001 && segments[1] == 0x0db8
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80
                || first & 0xff00 == 0xff00)
        }
    }
}

fn resolve_addresses(url: &Url) -> Result<Vec<IpAddr>> {
    let host = url.host_str().ok_or_else(ShiftError::invalid_url)?;
    let port = url
        .port_or_known_default()
        .ok_or_else(ShiftError::invalid_url)?;
    (host, port)
        .to_socket_addrs()
        .map(|iter| iter.map(|addr| addr.ip()).collect())
        .map_err(|_| ShiftError::new("network_error", "Couldn't reach this link."))
}

fn probe_head(url: &Url, ip: IpAddr) -> Result<Option<String>> {
    let host = url.host_str().ok_or_else(ShiftError::invalid_url)?;
    let port = url
        .port_or_known_default()
        .ok_or_else(ShiftError::invalid_url)?;
    let pin = match ip {
        IpAddr::V4(ip) => format!("{host}:{port}:{ip}"),
        IpAddr::V6(ip) => format!("{host}:{port}:[{ip}]"),
    };
    let output = Command::new("/usr/bin/curl")
        .args([
            "-q",
            "--silent",
            "--show-error",
            "--head",
            "--max-time",
            "15",
            "--max-redirs",
            "0",
            "--noproxy",
            "*",
            "--proto",
            "=http,https",
            "--resolve",
            &pin,
            url.as_str(),
        ])
        .output()
        .map_err(|_| ShiftError::new("network_error", "Couldn't reach this link."))?;
    if !output.status.success() {
        return Err(ShiftError::new(
            "network_error",
            "Couldn't reach this link.",
        ));
    }
    redirect_from_headers(&String::from_utf8_lossy(&output.stdout))
}

fn redirect_from_headers(headers: &str) -> Result<Option<String>> {
    let status = headers.lines().rev().find_map(|line| {
        line.strip_prefix("HTTP/")?
            .split_whitespace()
            .nth(1)?
            .parse::<u16>()
            .ok()
    });
    if status.is_some_and(|status| (300..400).contains(&status)) {
        return headers
            .lines()
            .rev()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("location")
                    .then(|| value.trim().to_string())
            })
            .ok_or_else(|| resolution_error("The link redirects without a destination."))
            .map(Some);
    }
    // A page can refuse HEAD while still working in yt-dlp. Let its extractor
    // make the authoritative media decision in that case.
    Ok(None)
}

fn resolution_error(detail: &str) -> ShiftError {
    ShiftError::new(
        "short_link_resolution_failed",
        "Couldn't resolve this link.",
    )
    .hint("Check the link and try again.")
    .technical(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn public(_: &Url) -> Result<Vec<IpAddr>> {
        Ok(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])
    }
    #[test]
    fn resolves_short_and_relative_redirects_preserving_queries() {
        let url = Url::parse("https://lnkd.in/p/abc").unwrap();
        let result = resolve_with(&url, public, |url, _| {
            Ok(match url.host_str() {
                Some("lnkd.in") => {
                    Some("https://www.linkedin.com/posts/person-ugcPost-123-a/?token=keep".into())
                }
                _ if url.path() == "/posts/person-ugcPost-123-a/" => {
                    Some("../final?token=keep".into())
                }
                _ => None,
            })
        })
        .unwrap();
        assert_eq!(
            result.as_str(),
            "https://www.linkedin.com/posts/final?token=keep"
        );
    }

    #[test]
    fn rejects_loops_and_unsafe_redirects() {
        let url = Url::parse("https://lnkd.in/a").unwrap();
        assert_eq!(
            resolve_with(&url, public, |_, _| Ok(Some("/a".into())))
                .unwrap_err()
                .code,
            "short_link_resolution_failed"
        );
        for destination in [
            "file:///etc/passwd",
            "http://localhost/file",
            "http://127.0.0.1/file",
            "http://192.168.1.2/file",
        ] {
            assert!(
                resolve_with(
                    &url,
                    |url| {
                        if url.host_str() == Some("localhost") {
                            Ok(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)])
                        } else if let Ok(ip) = url.host_str().unwrap().parse() {
                            Ok(vec![ip])
                        } else {
                            public(url)
                        }
                    },
                    |_, _| Ok(Some(destination.into()))
                )
                .is_err(),
                "{destination}"
            );
        }
    }

    #[test]
    fn rejects_private_dns_answers() {
        let url = Url::parse("https://example.com/video").unwrap();
        assert_eq!(
            resolve_with(
                &url,
                |_| Ok(vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))]),
                |_, _| Ok(None)
            )
            .unwrap_err()
            .code,
            "unsafe_url"
        );
    }

    #[test]
    fn excludes_reserved_and_tunneled_addresses() {
        for raw in [
            "0.0.0.0",
            "100.100.100.200",
            "169.254.169.254",
            "192.0.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "2002:0a00:0001::1",
        ] {
            assert!(!public_ip(raw.parse().unwrap()), "{raw}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn parses_http2_redirect_headers() {
        assert_eq!(
            redirect_from_headers("HTTP/2 302\r\nlocation: /watch?token=keep\r\n\r\n").unwrap(),
            Some("/watch?token=keep".into())
        );
        assert_eq!(redirect_from_headers("HTTP/2 405\r\n\r\n").unwrap(), None);
    }
}
