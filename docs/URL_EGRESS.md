# URL media network boundary

SHIFT accepts public HTTP(S) media URLs. The initial resolver is one request
path, not a security boundary for a later downloader request. URL-driven
network access is therefore constrained at each component that can connect.

| Component | URL-derived requests | Boundary |
| --- | --- | --- |
| Rust URL resolver | HEAD requests and HTTP redirects | Every hop resolves all DNS answers, rejects non-public addresses, and uses curl `--resolve` to pin the checked address. Curl does not follow redirects on its own. |
| yt-dlp analysis | Page, extractor, embed, and metadata URLs | The subprocess inherits a macOS Seatbelt profile allowing outbound TCP only to SHIFT's temporary loopback SOCKS proxy. UDP and other direct connections remain denied. The proxy resolves and checks each requested destination and dials the checked `SocketAddr`. |
| yt-dlp thumbnail and download | Poster URLs, direct media, HLS/DASH manifests and segments | Same sandbox and proxy on every invocation. Native HLS/DASH downloaders are selected so segment requests normally stay in yt-dlp. |
| yt-dlp child downloader or FFmpeg | Any URL opened by a child | Children inherit the Seatbelt profile. They may use the same checked proxy, or fail closed if they cannot proxy. No unsandboxed retry is used. |
| FFmpeg, ffprobe, sips launched by SHIFT | Preview, probe, conversion, export | `process::run` applies a no-network Seatbelt profile. These stages receive acquired local files. |
| Frontend preview | Thumbnail and playable source | Cached local/data assets produced by the backend; no remote media URL is handed to the webview. |

The proxy binds both `127.0.0.1` and `::1` on its single permitted port, so
the Seatbelt loopback allowance cannot reach a different service on the other
address family. It supports SOCKS5 CONNECT for HTTP(S) ports 80 and 443. It rejects
localhost, private/link-local/reserved IP addresses, IPv4-mapped private IPv6,
non-global IPv6, and mixed public/private DNS answers. It resolves once per
connection and dials a validated socket address, so a later DNS answer cannot
replace the checked address. TLS is still negotiated and verified by the
downloader with the original hostname. Redirects and nested resources create
new proxy connections and receive the same check.

`sandbox-exec` is required on the supported macOS host. If the sandbox or
proxy cannot start, the request fails; there is no direct-network fallback.
FFmpeg does not support this SOCKS proxy for every external HLS path, so those
paths fail closed. Standard unencrypted HLS/DASH is routed through yt-dlp's
native downloader. Unusual media that requires an FFmpeg network downloader
may remain unavailable. Private media, DRM, and unsupported extractor formats
remain outside SHIFT's scope.

Browser cookies are not read by default: yt-dlp user configuration is ignored.
The existing explicit Chrome retry uses yt-dlp's domain-scoped cookie handling.
Its permission explanation appears before the retry. The network sandbox also
applies in Chrome mode; it permits local Keychain access while keeping network
connections restricted to the checked proxy. A denied or unavailable Chrome
session is reported as a specific error without storing session credentials.
The proxy is a transport tunnel and cannot inspect HTTPS headers; it enforces
destination reachability, while yt-dlp remains responsible for cookie origin
matching. A local cross-domain redirect fixture checks that a cookie set for
one origin is not sent to another.

The local fixture tests exercise the bundled yt-dlp process through the
Seatbelt and proxy, plus standalone FFmpeg/ffprobe network denial. They make no
live provider requests. Provider-specific extraction behavior still requires
manual review.
