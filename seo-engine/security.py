import ipaddress
import socket
from urllib.parse import urlparse

ALLOWED_SCHEMES = {"http", "https"}
BLOCKED_HOSTNAMES = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "metadata.google.internal"}
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".intranet", ".home.arpa")


def normalize_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        raise ValueError("URL is required")
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    p = urlparse(value)
    if p.scheme not in ALLOWED_SCHEMES or not p.hostname:
        raise ValueError("Enter a valid public http/https URL")
    if p.username or p.password:
        raise ValueError("URLs containing credentials are not allowed")
    return value


def _ip_is_public(ip) -> bool:
    # Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1) so it cannot bypass the check.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    # `is_global` is stricter than the private/loopback/link-local blacklist:
    # it also rejects CGNAT (100.64/10), benchmarking, documentation and other
    # special-purpose ranges that are not routable on the public internet.
    return bool(ip.is_global) and not ip.is_multicast


def ensure_public_url(value: str) -> str:
    url = normalize_url(value)
    host = (urlparse(url).hostname or "").lower().rstrip(".")
    if host in BLOCKED_HOSTNAMES or host.endswith(BLOCKED_SUFFIXES):
        raise ValueError("Private or local network URLs are not allowed")
    try:
        # Literal IPs (including decimal/hex forms Python understands) are checked directly.
        literal = ipaddress.ip_address(host)
        if not _ip_is_public(literal):
            raise ValueError("Private or local network URLs are not allowed")
        return url
    except ValueError as exc:
        if "not allowed" in str(exc):
            raise
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise ValueError("Could not resolve the website hostname")
    if not infos:
        raise ValueError("Could not resolve the website hostname")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not _ip_is_public(ip):
            raise ValueError("Private or local network URLs are not allowed")
    return url
