//! Fail-closed network boundary for URL-driven media subprocesses.
//!
//! A child may connect only to this loopback SOCKS endpoint. The proxy resolves
//! each requested host and connects to a checked SocketAddr, so DNS cannot
//! change between validation and connection. The child's Seatbelt profile is
//! inherited by yt-dlp's ffmpeg/external-downloader descendants.

use crate::errors::{Result, ShiftError};
use crate::validation::public_url::public_ip;
use std::io::{self, Read, Write};
use std::net::{
    IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

type Connector = Arc<dyn Fn(&str, u16) -> io::Result<TcpStream> + Send + Sync>;

pub const NO_NETWORK_PROFILE: &str = "(version 1)(allow default)(deny network-outbound)";

pub struct PublicProxy {
    port: u16,
    stopped: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

impl PublicProxy {
    pub fn start() -> Result<Self> {
        Self::start_with(Arc::new(connect_public))
    }

    fn start_with(connect: Connector) -> Result<Self> {
        let ipv4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(proxy_error)?;
        let port = ipv4.local_addr().map_err(proxy_error)?.port();
        // Seatbelt's "localhost:port" allowance includes both 127.0.0.1 and
        // ::1. Hold both sockets so the permitted port cannot reach an
        // unrelated local service on the other address family.
        let ipv6 = TcpListener::bind((Ipv6Addr::LOCALHOST, port)).map_err(proxy_error)?;
        ipv4.set_nonblocking(true).map_err(proxy_error)?;
        ipv6.set_nonblocking(true).map_err(proxy_error)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stopped);
        let listener = thread::spawn(move || {
            while !flag.load(Ordering::Acquire) {
                for listener in [&ipv4, &ipv6] {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let connect = Arc::clone(&connect);
                            thread::spawn(move || {
                                let _ = stream.set_nonblocking(false);
                                let _ = serve(stream, connect.as_ref());
                            });
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                        Err(_) => return,
                    }
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        Ok(Self {
            port,
            stopped,
            listener: Some(listener),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn profile(&self) -> String {
        format!("(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote tcp \"localhost:{}\"))", self.port)
    }
}

impl Drop for PublicProxy {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}

fn proxy_error(e: io::Error) -> ShiftError {
    ShiftError::new(
        "network_boundary",
        "SHIFT couldn't start its protected network connection.",
    )
    .technical(e.to_string())
}

fn serve(
    mut client: TcpStream,
    connect: &dyn Fn(&str, u16) -> io::Result<TcpStream>,
) -> io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(20)))?;
    client.set_write_timeout(Some(Duration::from_secs(20)))?;
    let mut hello = [0u8; 2];
    client.read_exact(&mut hello)?;
    if hello[0] != 5 || hello[1] == 0 || hello[1] > 16 {
        return Ok(());
    }
    let mut methods = vec![0u8; hello[1] as usize];
    client.read_exact(&mut methods)?;
    if !methods.contains(&0) {
        client.write_all(&[5, 0xff])?;
        return Ok(());
    }
    client.write_all(&[5, 0])?;

    let mut request = [0u8; 4];
    client.read_exact(&mut request)?;
    if request[0] != 5 || request[1] != 1 || request[2] != 0 {
        reply(&mut client, 7)?;
        return Ok(());
    }
    let host = match request[3] {
        1 => {
            let mut bytes = [0u8; 4];
            client.read_exact(&mut bytes)?;
            IpAddr::V4(Ipv4Addr::from(bytes)).to_string()
        }
        4 => {
            let mut bytes = [0u8; 16];
            client.read_exact(&mut bytes)?;
            IpAddr::V6(Ipv6Addr::from(bytes)).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            client.read_exact(&mut len)?;
            if len[0] == 0 {
                reply(&mut client, 8)?;
                return Ok(());
            }
            let mut bytes = vec![0u8; len[0] as usize];
            client.read_exact(&mut bytes)?;
            match String::from_utf8(bytes) {
                Ok(host) => host,
                Err(_) => {
                    reply(&mut client, 8)?;
                    return Ok(());
                }
            }
        }
        _ => {
            reply(&mut client, 8)?;
            return Ok(());
        }
    };
    let mut port = [0u8; 2];
    client.read_exact(&mut port)?;
    let port = u16::from_be_bytes(port);
    let Ok(remote) = connect(&host, port) else {
        reply(&mut client, 2)?;
        return Ok(());
    };
    reply(&mut client, 0)?;
    client.set_read_timeout(None)?;
    client.set_write_timeout(None)?;
    tunnel(client, remote)
}

fn reply(client: &mut TcpStream, code: u8) -> io::Result<()> {
    client.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0])
}

fn connect_public(raw_host: &str, port: u16) -> io::Result<TcpStream> {
    connect_with(
        raw_host,
        port,
        |host, port| (host, port).to_socket_addrs().map(Iterator::collect),
        |addr| TcpStream::connect_timeout(&addr, Duration::from_secs(10)),
    )
}

fn connect_with<T>(
    raw_host: &str,
    port: u16,
    mut resolve: impl FnMut(&str, u16) -> io::Result<Vec<SocketAddr>>,
    mut dial: impl FnMut(SocketAddr) -> io::Result<T>,
) -> io::Result<T> {
    if !matches!(port, 80 | 443) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "blocked port",
        ));
    }
    let host = normalize_host(raw_host)?;
    let addresses = resolve(&host, port)?;
    if addresses.is_empty() || addresses.iter().any(|addr| !public_ip(addr.ip())) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "blocked address",
        ));
    }
    let mut last = io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        "no public address reachable",
    );
    for addr in addresses {
        match dial(addr) {
            Ok(stream) => return Ok(stream),
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn normalize_host(raw: &str) -> io::Result<String> {
    let host = raw.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.contains('/')
        || host.contains('@')
        || host.contains('%')
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "blocked host",
        ));
    }
    if host.parse::<IpAddr>().is_ok() {
        return Ok(host);
    }
    let url = url::Url::parse(&format!("http://{host}/"))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid host"))?;
    if url.host_str().is_none() || url.port().is_some() || !url.username().is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid host"));
    }
    Ok(url.host_str().unwrap().to_string())
}

fn tunnel(mut client: TcpStream, mut remote: TcpStream) -> io::Result<()> {
    let mut client_read = client.try_clone()?;
    let mut remote_write = remote.try_clone()?;
    let upstream = thread::spawn(move || {
        let _ = io::copy(&mut client_read, &mut remote_write);
        let _ = remote_write.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut remote, &mut client);
    let _ = client.shutdown(Shutdown::Write);
    let _ = upstream.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::Mutex;

    struct FixtureServer {
        addr: SocketAddr,
        hits: Arc<Mutex<Vec<String>>>,
        requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl FixtureServer {
        fn start(
            response: impl Fn(&str) -> (u16, Vec<(&'static str, String)>, Vec<u8>)
                + Send
                + Sync
                + 'static,
        ) -> Self {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            let hits = Arc::new(Mutex::new(Vec::new()));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let seen = Arc::clone(&hits);
            let raw_requests = Arc::clone(&requests);
            let flag = Arc::clone(&stop);
            let thread = thread::spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut bytes = [0u8; 8192];
                            if let Ok(size) = stream.read(&mut bytes) {
                                let first = String::from_utf8_lossy(&bytes[..size]);
                                raw_requests.lock().unwrap().push(first.to_string());
                                let path =
                                    first.split_whitespace().nth(1).unwrap_or("/").to_string();
                                seen.lock().unwrap().push(path.clone());
                                let (status, headers, body) = response(&path);
                                let mut head = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
                                for (name, value) in headers {
                                    head.push_str(&format!("{name}: {value}\r\n"));
                                }
                                head.push_str("\r\n");
                                let _ = stream.write_all(head.as_bytes());
                                let _ = stream.write_all(&body);
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10))
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                addr,
                hits,
                requests,
                stop,
                thread: Some(thread),
            }
        }
        fn hits(&self) -> Vec<String> {
            self.hits.lock().unwrap().clone()
        }
        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }
    impl Drop for FixtureServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn fixture_proxy(addr: SocketAddr, attempts: Arc<Mutex<Vec<String>>>) -> PublicProxy {
        PublicProxy::start_with(Arc::new(move |host, port| {
            attempts.lock().unwrap().push(format!("{host}:{port}"));
            if matches!(host, "public.test" | "other-public.test") && port == 80 {
                TcpStream::connect(addr)
            } else {
                connect_public(host, port)
            }
        }))
        .unwrap()
    }

    fn ytdlp(proxy: &PublicProxy, url: &str, download: bool) -> std::process::Output {
        ytdlp_with_extra(proxy, url, download, &[])
    }

    fn ytdlp_with_extra(
        proxy: &PublicProxy,
        url: &str,
        download: bool,
        extra: &[&str],
    ) -> std::process::Output {
        let binary = crate::process::resolve(crate::process::Binary::YtDlp).unwrap();
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command.arg("-p").arg(proxy.profile()).arg(binary).args([
            "--ignore-config",
            "--proxy",
            &format!("socks5://127.0.0.1:{}", proxy.port()),
            "--socket-timeout",
            "2",
            "--retries",
            "0",
            "--fragment-retries",
            "0",
            "--downloader",
            "m3u8:native",
            "--downloader",
            "dash:native",
        ]);
        let output_path = std::env::temp_dir().join(format!(
            "shift-egress-{}-{}.%(ext)s",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        if download {
            command.arg("--no-playlist").arg("-o").arg(&output_path);
        } else {
            command.arg("--dump-single-json");
        }
        let result = command.args(extra).arg(url).output().unwrap();
        if download {
            if let Some(parent) = output_path.parent() {
                if let Ok(entries) = std::fs::read_dir(parent) {
                    let prefix = format!("shift-egress-{}-", std::process::id());
                    for entry in entries.flatten() {
                        if entry.file_name().to_string_lossy().starts_with(&prefix) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
        result
    }

    #[test]
    fn blocks_private_and_untrusted_targets() {
        for host in [
            "localhost",
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(connect_public(host, 80).is_err(), "{host}");
        }
        assert!(connect_public("example.com", 22).is_err());
    }

    #[test]
    fn proxy_owns_both_loopback_families_on_its_allowed_port() {
        let proxy = PublicProxy::start().unwrap();
        for address in [
            SocketAddr::from((Ipv4Addr::LOCALHOST, proxy.port())),
            SocketAddr::from((Ipv6Addr::LOCALHOST, proxy.port())),
        ] {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(&[5, 1, 0]).unwrap();
            let mut selected = [0u8; 2];
            stream.read_exact(&mut selected).unwrap();
            assert_eq!(selected, [5, 0]);
        }
    }

    #[test]
    fn sandbox_allows_only_proxy_tcp_not_udp_or_other_loopback_addresses() {
        let proxy = PublicProxy::start().unwrap();
        let script = format!(r#"import socket
for label, family, kind, host in [
 ('proxy4', socket.AF_INET, socket.SOCK_STREAM, '127.0.0.1'),
 ('proxy6', socket.AF_INET6, socket.SOCK_STREAM, '::1'),
 ('udp', socket.AF_INET, socket.SOCK_DGRAM, '127.0.0.1'),
 ('other', socket.AF_INET, socket.SOCK_STREAM, '127.0.0.2'),
]:
 try:
  s=socket.socket(family,kind); s.settimeout(1)
  if kind==socket.SOCK_STREAM: s.connect((host,{port}))
  else: s.sendto(b'x',(host,{port}))
  print(label+':allowed')
 except Exception as error: print(label+':'+type(error).__name__)
"#, port=proxy.port());
        let output = Command::new("/usr/bin/sandbox-exec")
            .arg("-p").arg(proxy.profile()).arg("/usr/bin/python3")
            .arg("-c").arg(script).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let lines = String::from_utf8_lossy(&output.stdout);
        assert!(lines.contains("proxy4:allowed"), "{lines}");
        assert!(lines.contains("proxy6:allowed"), "{lines}");
        assert!(lines.contains("udp:PermissionError"), "{lines}");
        assert!(lines.contains("other:PermissionError"), "{lines}");
    }

    #[test]
    fn chrome_session_mode_keeps_keychain_read_access_and_private_egress_blocked() {
        let proxy = PublicProxy::start().unwrap();
        // Query a deliberately nonexistent item. Exit 44 means securityd was
        // reachable under the same Seatbelt profile, without reading a secret
        // or prompting for Chrome Safe Storage authorization.
        let keychain = Command::new("/usr/bin/sandbox-exec")
            .arg("-p")
            .arg(proxy.profile())
            .arg("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                "SHIFT-integration-nonexistent-probe-20261021",
                "-a",
                "SHIFT-integration-probe",
            ])
            .output()
            .unwrap();
        assert_eq!(keychain.status.code(), Some(44));

        let forbidden = FixtureServer::start(|_| (200, vec![], b"secret".to_vec()));
        let missing_profile = std::env::temp_dir().join(format!(
            "shift-missing-chrome-profile-{}",
            uuid::Uuid::new_v4()
        ));
        let cancel = crate::process::CancelToken::new();
        let output = crate::process::run_capture(
            crate::process::Binary::YtDlp,
            &[
                "--ignore-config".into(),
                "--cookies-from-browser".into(),
                format!("chrome:{}", missing_profile.display()),
                "--dump-single-json".into(),
                format!("http://127.0.0.1:{}/video.mp4", forbidden.addr.port()),
            ],
            &cancel,
        )
        .unwrap();
        assert!(!output.success);
        assert!(forbidden.hits().is_empty(), "Chrome mode bypassed network protection");
    }

    #[test]
    fn dns_is_resolved_once_and_connection_uses_the_checked_address() {
        let mut lookups = 0;
        let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let private: SocketAddr = "127.0.0.1:443".parse().unwrap();
        let connected = connect_with(
            "PUBLIC.TEST",
            443,
            |_, _| {
                lookups += 1;
                Ok(vec![if lookups == 1 { public } else { private }])
            },
            |addr| Ok(addr),
        )
        .unwrap();
        assert_eq!(lookups, 1, "the name was re-resolved after validation");
        assert_eq!(connected, public);
        let mut dialed = false;
        assert!(connect_with(
            "public.test",
            443,
            |_, _| Ok(vec![public, private]),
            |_| {
                dialed = true;
                Ok(())
            }
        )
        .is_err());
        assert!(
            !dialed,
            "mixed DNS answers must be rejected before connecting"
        );
    }

    #[test]
    fn actual_downloader_cannot_reach_localhost_after_public_redirects() {
        let forbidden = FixtureServer::start(|_| (200, vec![], b"secret".to_vec()));
        let private = format!("http://127.0.0.1:{}/secret", forbidden.addr.port());
        let public = FixtureServer::start(move |path| match path {
            "/first" => (
                302,
                vec![("Location", "http://other-public.test/second".into())],
                vec![],
            ),
            "/second" => (302, vec![("Location", private.clone())], vec![]),
            _ => (404, vec![], vec![]),
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, Arc::clone(&attempts));
        let output = ytdlp(&proxy, "http://public.test/first", false);
        assert!(!output.status.success(), "unexpected extraction success");
        assert!(
            public.hits().contains(&"/first".into()),
            "yt-dlp did not use the proxy: {}; attempts={:?}",
            String::from_utf8_lossy(&output.stderr),
            attempts.lock().unwrap()
        );
        assert!(public.hits().contains(&"/second".into()));
        assert!(attempts
            .lock()
            .unwrap()
            .iter()
            .any(|host| host.starts_with("127.0.0.1:")));
        assert!(
            forbidden.hits().is_empty(),
            "private server received traffic"
        );
    }

    #[test]
    fn actual_downloader_cannot_reach_direct_private_ip() {
        let forbidden = FixtureServer::start(|_| (200, vec![], b"secret".to_vec()));
        let proxy = PublicProxy::start().unwrap();
        let output = ytdlp(
            &proxy,
            &format!("http://127.0.0.1:{}/video.mp4", forbidden.addr.port()),
            false,
        );
        assert!(!output.status.success());
        assert!(
            forbidden.hits().is_empty(),
            "private server received traffic"
        );
    }

    #[test]
    fn bundled_downloader_keeps_file_urls_disabled() {
        let proxy = PublicProxy::start().unwrap();
        let output = ytdlp(&proxy, "file:///etc/hosts", false);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("file:// URLs are disabled"));
    }

    #[test]
    fn public_cross_domain_redirect_is_forwarded_to_real_downloader() {
        let public = FixtureServer::start(|path| match path {
            "/first" => (
                302,
                vec![("Location", "http://other-public.test/video.mp4".into())],
                vec![],
            ),
            "/video.mp4" => (
                200,
                vec![("Content-Type", "video/mp4".into())],
                b"fixture-video".to_vec(),
            ),
            _ => (404, vec![], vec![]),
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, Arc::clone(&attempts));
        let output = ytdlp(&proxy, "http://public.test/first", false);
        assert!(
            public.hits().contains(&"/first".into()),
            "{}; attempts={:?}",
            String::from_utf8_lossy(&output.stderr),
            attempts.lock().unwrap()
        );
        assert!(
            public.hits().contains(&"/video.mp4".into()),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn actual_preview_and_export_paths_block_private_requests() {
        let forbidden = FixtureServer::start(|_| (200, vec![], b"secret".to_vec()));
        let source = format!("http://127.0.0.1:{}/video.mp4", forbidden.addr.port());
        let cancel = crate::process::CancelToken::new();
        let yt = crate::process::run_capture(
            crate::process::Binary::YtDlp,
            &[
                "--ignore-config".into(),
                "--dump-single-json".into(),
                source.clone(),
            ],
            &cancel,
        )
        .unwrap();
        assert!(
            !yt.success,
            "preview analysis unexpectedly reached a private URL"
        );
        let ffprobe = crate::process::run_capture(
            crate::process::Binary::Ffprobe,
            &["-v".into(), "error".into(), source.clone()],
            &cancel,
        )
        .unwrap();
        assert!(
            !ffprobe.success,
            "ffprobe unexpectedly reached a private URL"
        );
        let ffmpeg = crate::process::run_capture(
            crate::process::Binary::Ffmpeg,
            &[
                "-v".into(),
                "error".into(),
                "-i".into(),
                source,
                "-f".into(),
                "null".into(),
                "-".into(),
            ],
            &cancel,
        )
        .unwrap();
        assert!(!ffmpeg.success, "ffmpeg unexpectedly reached a private URL");
        assert!(
            forbidden.hits().is_empty(),
            "a media process made a private request"
        );
    }

    #[test]
    fn public_hls_manifest_cannot_reach_local_segment() {
        let forbidden = FixtureServer::start(|_| (200, vec![], b"segment".to_vec()));
        let segment = format!("http://127.0.0.1:{}/seg.ts", forbidden.addr.port());
        let manifest = format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n{segment}\n#EXT-X-ENDLIST\n");
        let public = FixtureServer::start(move |_| {
            (
                200,
                vec![("Content-Type", "application/vnd.apple.mpegurl".into())],
                manifest.as_bytes().to_vec(),
            )
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, Arc::clone(&attempts));
        let output = ytdlp(&proxy, "http://public.test/master.m3u8", true);
        assert!(
            public.hits().contains(&"/master.m3u8".into()),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !output.status.success(),
            "private segment unexpectedly downloaded"
        );
        assert!(
            attempts
                .lock()
                .unwrap()
                .iter()
                .any(|host| host.starts_with("127.0.0.1:")),
            "manifest did not attempt its segment: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            forbidden.hits().is_empty(),
            "private HLS segment server received traffic"
        );
    }

    #[test]
    fn browser_cookie_scope_is_not_broadened_by_public_redirect() {
        let public = FixtureServer::start(|path| match path {
            "/cookie" => (
                302,
                vec![
                    ("Set-Cookie", "shift_test=SECRET; Path=/".into()),
                    ("Location", "http://other-public.test/video.mp4".into()),
                ],
                vec![],
            ),
            "/video.mp4" => (
                200,
                vec![("Content-Type", "video/mp4".into())],
                b"fixture".to_vec(),
            ),
            _ => (404, vec![], vec![]),
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, attempts);
        let _ = ytdlp(&proxy, "http://public.test/cookie", false);
        assert!(public.hits().contains(&"/video.mp4".into()));
        let cross_origin = public
            .requests()
            .into_iter()
            .find(|request| request.contains("GET /video.mp4 "))
            .unwrap();
        assert!(!cross_origin
            .to_ascii_lowercase()
            .contains("cookie: shift_test=secret"));
    }

    #[test]
    fn actual_downloader_blocks_ipv6_and_mapped_private_destinations() {
        let Ok(listener) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)) else {
            return;
        };
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = PublicProxy::start().unwrap();
        for host in ["[::1]", "[::ffff:127.0.0.1]"] {
            let output = ytdlp(&proxy, &format!("http://{host}:{port}/video.mp4"), false);
            assert!(!output.status.success(), "{host} unexpectedly succeeded");
        }
        assert!(
            listener.accept().is_err(),
            "IPv6 private listener received traffic"
        );
    }

    #[test]
    fn embedded_private_video_is_not_fetched() {
        let forbidden = FixtureServer::start(|_| (200, vec![], b"secret".to_vec()));
        let html = format!("<html><head><title>Fixture</title></head><body><video controls src=\"http://127.0.0.1:{}/clip.mp4\"></video></body></html>", forbidden.addr.port());
        let public = FixtureServer::start(move |_| {
            (
                200,
                vec![("Content-Type", "text/html".into())],
                html.as_bytes().to_vec(),
            )
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, Arc::clone(&attempts));
        let output = ytdlp(&proxy, "http://public.test/page", true);
        assert!(public.hits().contains(&"/page".into()));
        assert!(!output.status.success());
        assert!(
            attempts
                .lock()
                .unwrap()
                .iter()
                .any(|host| host.starts_with("127.0.0.1:")),
            "embedded URL was not exercised: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(forbidden.hits().is_empty());
    }

    #[test]
    fn export_download_cannot_follow_private_redirect() {
        let forbidden = FixtureServer::start(|_| (200, vec![], b"secret".to_vec()));
        let private = format!("http://127.0.0.1:{}/video.mp4", forbidden.addr.port());
        let public =
            FixtureServer::start(move |_| (302, vec![("Location", private.clone())], vec![]));
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, Arc::clone(&attempts));
        let output = ytdlp(&proxy, "http://public.test/video.mp4", true);
        assert!(!output.status.success());
        assert!(public.hits().contains(&"/video.mp4".into()));
        assert!(attempts
            .lock()
            .unwrap()
            .iter()
            .any(|host| host.starts_with("127.0.0.1:")));
        assert!(forbidden.hits().is_empty());
    }

    #[test]
    fn direct_public_media_download_passes_through_proxy() {
        let public = FixtureServer::start(|_| {
            (
                200,
                vec![("Content-Type", "video/mp4".into())],
                b"fixture-video".to_vec(),
            )
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, attempts);
        let output = ytdlp(&proxy, "http://public.test/video.mp4", true);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(public.hits().contains(&"/video.mp4".into()));
    }

    #[test]
    fn public_hls_segment_is_requested_through_proxy() {
        let manifest = b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\nhttp://other-public.test/seg.ts\n#EXT-X-ENDLIST\n".to_vec();
        let public = FixtureServer::start(move |path| match path {
            "/master.m3u8" => (
                200,
                vec![("Content-Type", "application/vnd.apple.mpegurl".into())],
                manifest.clone(),
            ),
            "/seg.ts" => (
                200,
                vec![("Content-Type", "video/mp2t".into())],
                b"fixture-segment".to_vec(),
            ),
            _ => (404, vec![], vec![]),
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, attempts);
        let output = ytdlp(&proxy, "http://public.test/master.m3u8", true);
        assert!(public.hits().contains(&"/master.m3u8".into()));
        assert!(
            public.hits().contains(&"/seg.ts".into()),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn dash_manifest_cannot_reach_private_segment() {
        let forbidden = FixtureServer::start(|_| (200, vec![], b"secret".to_vec()));
        let segment = format!("http://127.0.0.1:{}/segment.m4s", forbidden.addr.port());
        let manifest = format!("<?xml version=\"1.0\"?><MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" type=\"static\" mediaPresentationDuration=\"PT1S\" minBufferTime=\"PT1S\"><Period duration=\"PT1S\"><AdaptationSet mimeType=\"video/mp4\" segmentAlignment=\"true\"><Representation id=\"v1\" bandwidth=\"100000\" codecs=\"avc1.42E01E\" width=\"320\" height=\"240\"><BaseURL>{segment}</BaseURL></Representation></AdaptationSet></Period></MPD>");
        let public = FixtureServer::start(move |_| {
            (
                200,
                vec![("Content-Type", "application/dash+xml".into())],
                manifest.as_bytes().to_vec(),
            )
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, Arc::clone(&attempts));
        let output = ytdlp(&proxy, "http://public.test/manifest.mpd", true);
        assert!(public.hits().contains(&"/manifest.mpd".into()));
        assert!(!output.status.success());
        assert!(
            attempts
                .lock()
                .unwrap()
                .iter()
                .any(|host| host.starts_with("127.0.0.1:")),
            "DASH segment was not exercised: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(forbidden.hits().is_empty());
    }

    #[test]
    fn external_ffmpeg_downloader_cannot_bypass_the_boundary() {
        let forbidden = FixtureServer::start(|_| (200, vec![], b"segment".to_vec()));
        let segment = format!("http://127.0.0.1:{}/seg.ts", forbidden.addr.port());
        let manifest = format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n{segment}\n#EXT-X-ENDLIST\n");
        let public = FixtureServer::start(move |_| {
            (
                200,
                vec![("Content-Type", "application/vnd.apple.mpegurl".into())],
                manifest.as_bytes().to_vec(),
            )
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let proxy = fixture_proxy(public.addr, attempts);
        let output = ytdlp_with_extra(
            &proxy,
            "http://public.test/master.m3u8",
            true,
            &[
                "--downloader",
                "m3u8:ffmpeg",
                "--ffmpeg-location",
                crate::process::resolve(crate::process::Binary::Ffmpeg)
                    .unwrap()
                    .to_str()
                    .unwrap(),
            ],
        );
        assert!(public.hits().contains(&"/master.m3u8".into()));
        assert!(!output.status.success());
        let log = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            log.to_ascii_lowercase().contains("ffmpeg"),
            "external downloader was not exercised: {log}"
        );
        assert!(
            forbidden.hits().is_empty(),
            "external FFmpeg reached a private segment"
        );
    }
}
