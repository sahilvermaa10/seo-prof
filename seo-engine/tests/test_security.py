"""SSRF / fetch-hardening tests for the SEO engine. Run: python -m pytest tests -q"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
import requests
from unittest import mock

import security
import main


@pytest.mark.parametrize("url", [
    "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/",
    "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "http://foo.internal/", "http://printer.local/",
    "http://user:pass@example.com/", "ftp://example.com/", "file:///etc/passwd", "",
])
def test_blocks_unsafe_urls(url):
    with pytest.raises(ValueError):
        security.ensure_public_url(url)


def test_allows_public_ip_literal():
    assert security.ensure_public_url("http://93.184.216.34/").startswith("http://93.184.216.34")


def _resp(status, location=None, body=b"ok", url="http://x/"):
    r = requests.Response()
    r.status_code = status
    r.url = url
    r._content = body
    r._content_consumed = True
    r.raw = mock.Mock()
    r.iter_content = lambda n: iter([body])
    if location:
        r.headers["location"] = location
    return r


def test_redirect_to_private_ip_is_blocked():
    """A public page that 302s to cloud metadata must NOT be followed."""
    calls = []
    def fake_get(url, **kw):
        calls.append(url)
        return _resp(302, "http://169.254.169.254/latest/meta-data/")
    with mock.patch.object(security, "socket") as sock, \
         mock.patch.object(main._http_session(), "get", side_effect=fake_get):
        sock.gaierror = Exception
        sock.getaddrinfo.return_value = [(2, 1, 6, "", ("93.184.216.34", 0))]
        with pytest.raises(ValueError):
            main._fresh_get("http://example.com/")
    assert calls == ["http://example.com/"], "second hop must never be requested"


def test_redirect_history_preserved_and_capped():
    seq = [_resp(301, "http://example.com/b"), _resp(200, body=b"hello")]
    with mock.patch.object(security, "socket") as sock, \
         mock.patch.object(main._http_session(), "get", side_effect=lambda *a, **k: seq.pop(0)):
        sock.getaddrinfo.return_value = [(2, 1, 6, "", ("93.184.216.34", 0))]
        r = main._fresh_get("http://example.com/a")
    assert r.status_code == 200 and len(r.history) == 1 and r.text == "hello"


def test_redirect_loop_is_stopped():
    with mock.patch.object(security, "socket") as sock, \
         mock.patch.object(main._http_session(), "get", side_effect=lambda *a, **k: _resp(302, "http://example.com/loop")):
        sock.getaddrinfo.return_value = [(2, 1, 6, "", ("93.184.216.34", 0))]
        with pytest.raises(requests.TooManyRedirects):
            main._fresh_get("http://example.com/loop")


def test_body_is_size_capped():
    big = b"a" * (main.MAX_BODY_BYTES + 5000)
    r = _resp(200, body=big)
    main._read_capped(r)
    assert len(r.content) == main.MAX_BODY_BYTES and r._seo_truncated


def test_engine_secret_guard():
    from fastapi.testclient import TestClient
    with mock.patch.object(main, "ENGINE_SHARED_SECRET", "s3cret"):
        c = TestClient(main.app)
        assert c.get("/health").status_code == 200
        assert c.post("/analyze", json={"url": "example.com"}).status_code == 401
        assert c.post("/analyze", json={"url": "example.com"}, headers={"X-Engine-Secret": "wrong"}).status_code == 401
