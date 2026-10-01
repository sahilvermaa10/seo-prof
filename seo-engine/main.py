import os, re, json, time, threading
from collections import deque, OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse, urldefrag
import hmac

import requests
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field

from security import ensure_public_url

# Load the project-root .env as well as inherited environment variables.
# The Node server starts this file with cwd=seo-engine, so relying on cwd alone
# can make SERPAPI_KEY/PAGESPEED_API_KEY appear missing.
def _load_project_env():
    env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".env"))
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if value[:1] in ("\"", "'") and value[-1:] == value[:1]:
                    value = value[1:-1]
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass

_load_project_env()

app = FastAPI(title="SEO Agent Python Engine", version="3.0.0")
# Compress large JSON/HTML responses so detailed audits arrive faster over the network.
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)

# Optional shared secret so the engine cannot be used directly by third parties
# when it is deployed as a separate public service. Node sends the same value in
# the X-Engine-Secret header. If ENGINE_SHARED_SECRET is unset, no check is made
# (local development keeps working exactly as before).
ENGINE_SHARED_SECRET = os.getenv("ENGINE_SHARED_SECRET", "").strip()


@app.middleware("http")
async def engine_secret_guard(request: Request, call_next):
    if ENGINE_SHARED_SECRET and request.url.path not in ("/", "/health"):
        supplied = request.headers.get("x-engine-secret", "")
        if not hmac.compare_digest(supplied.encode(), ENGINE_SHARED_SECRET.encode()):
            return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized engine request.", "source": "Python FastAPI SEO Engine"})
    return await call_next(request)

HEADERS = {"User-Agent": "SEO-Agent-Python-Engine/3.0 (+evidence-first SEO analysis)", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Encoding": "gzip, deflate"}
TIMEOUT = 15
CACHE_TTL = 30
SERP_CACHE_TTL = 30
_CACHE_MAX = 128
_page_cache = OrderedDict()
_serp_cache = OrderedDict()
_cache_lock = threading.RLock()
_session_local = threading.local()

def _http_session():
    # Connection pooling is useful for speed, but cookies/auth state must never
    # survive between independent public-site jobs.  SEO Agent does not need
    # browser-session semantics when crawling arbitrary public URLs.
    session = getattr(_session_local, "session", None)
    if session is None:
        session = requests.Session()
        session.headers.update(HEADERS)
        session.cookies.clear()
        _session_local.session = session
    return session

MAX_REDIRECTS = 5
MAX_BODY_BYTES = int(os.getenv("ENGINE_MAX_BODY_BYTES", str(5 * 1024 * 1024)))
# Hosts we call on purpose (third-party APIs). Everything else is treated as
# untrusted, user-supplied input and must resolve to a public IP on every hop.
TRUSTED_API_HOSTS = {"serpapi.com"}


def _read_capped(response):
    """Read at most MAX_BODY_BYTES so a hostile/huge page cannot exhaust memory."""
    chunks, total = [], 0
    try:
        for chunk in response.iter_content(65536):
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_BODY_BYTES:
                keep = len(chunk) - (total - MAX_BODY_BYTES)
                if keep > 0:
                    chunks.append(chunk[:keep])
                response._seo_truncated = True
                break
            chunks.append(chunk)
    finally:
        response.close()
    response._content = b"".join(chunks)
    response._content_consumed = True
    return response


def _fresh_get(url, *, timeout=TIMEOUT, allow_redirects=True, params=None):
    """GET with SSRF-safe redirect handling.

    requests' built-in redirect following would let a public site 302 us to
    http://169.254.169.254/ or http://localhost/, bypassing ensure_public_url()
    which only validated the first hop. We follow redirects manually and
    re-validate every hop, preserving `response.history` for redirect reporting.
    """
    session = _http_session()
    session.cookies.clear()
    history = []
    current = url
    try:
        for hop in range(MAX_REDIRECTS + 1):
            host = (urlparse(current).hostname or "").lower()
            if host not in TRUSTED_API_HOSTS:
                current = ensure_public_url(current)
            response = session.get(current, timeout=timeout, allow_redirects=False,
                                   params=params if hop == 0 else None, stream=True)
            if allow_redirects and response.is_redirect and response.headers.get("location"):
                if hop >= MAX_REDIRECTS:
                    response.close()
                    raise requests.TooManyRedirects(f"Exceeded {MAX_REDIRECTS} redirects")
                nxt = urljoin(current, response.headers["location"])
                response.close()
                history.append(response)
                current = nxt
                continue
            _read_capped(response)
            response.history = history
            return response
    finally:
        session.cookies.clear()


def _cache_get(cache, key, ttl):
    now = time.time()
    with _cache_lock:
        item = cache.get(key)
        if not item: return None
        ts, value = item
        if now - ts > ttl:
            cache.pop(key, None)
            return None
        cache.move_to_end(key)
        return value

def _cache_put(cache, key, value):
    with _cache_lock:
        cache[key] = (time.time(), value)
        cache.move_to_end(key)
        while len(cache) > _CACHE_MAX:
            cache.popitem(last=False)

def clear_caches():
    with _cache_lock:
        _page_cache.clear(); _serp_cache.clear()


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    # Normalize FastAPI's default {detail: ...} shape to the frontend contract.
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": str(exc.detail), "source": "Python FastAPI SEO Engine"},
    )


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"success": False, "error": str(exc), "source": "Python FastAPI SEO Engine"})


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    # Always return JSON so Node's Python proxy never receives an HTML 500 page.
    import logging
    logging.getLogger("seo-engine").exception("Unhandled engine error on %s", request.url.path)
    if isinstance(exc, requests.Timeout):
        msg = "The target website took too long to respond."
    elif isinstance(exc, requests.TooManyRedirects):
        msg = "The target website redirected too many times."
    elif isinstance(exc, requests.ConnectionError):
        msg = "Could not connect to the target website."
    elif isinstance(exc, requests.HTTPError):
        msg = f"The target website returned an error: {exc}"[:300]
    else:
        msg = "Python SEO Engine internal error."
    return JSONResponse(status_code=502 if isinstance(exc, requests.RequestException) else 500, content={"success": False, "error": msg, "source": "Python FastAPI SEO Engine"})

SERPAPI_KEY = os.getenv("SERPAPI_KEY", "").strip().strip("\"'")
PAGESPEED_API_KEY = os.getenv("PAGESPEED_API_KEY", "").strip().strip("\"'")
OPENPR_API_KEY = os.getenv("OPENPR_API_KEY", "").strip().strip("\"'")

COUNTRIES = {
    "us": {"code":"us","label":"United States","gl":"us","hl":"en","google_domain":"google.com"},
    "gb": {"code":"gb","label":"United Kingdom","gl":"gb","hl":"en","google_domain":"google.co.uk"},
    "uk": {"code":"gb","label":"United Kingdom","gl":"gb","hl":"en","google_domain":"google.co.uk"},
    "ca": {"code":"ca","label":"Canada","gl":"ca","hl":"en","google_domain":"google.ca"},
    "au": {"code":"au","label":"Australia","gl":"au","hl":"en","google_domain":"google.com.au"},
    "in": {"code":"in","label":"India","gl":"in","hl":"en","google_domain":"google.co.in"},
    "ae": {"code":"ae","label":"United Arab Emirates","gl":"ae","hl":"en","google_domain":"google.ae"},
    "sg": {"code":"sg","label":"Singapore","gl":"sg","hl":"en","google_domain":"google.com.sg"},
    "de": {"code":"de","label":"Germany","gl":"de","hl":"de","google_domain":"google.de"},
    "fr": {"code":"fr","label":"France","gl":"fr","hl":"fr","google_domain":"google.fr"},
    "ph": {"code":"ph","label":"Philippines","gl":"ph","hl":"en","google_domain":"google.com.ph"},
    "za": {"code":"za","label":"South Africa","gl":"za","hl":"en","google_domain":"google.co.za"},
}


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def country(value):
    return COUNTRIES.get(str(value or "us").strip().lower(), COUNTRIES["us"])


def clean_text(v):
    return re.sub(r"\s+", " ", str(v or "")).strip()


def fetch(url, timeout=TIMEOUT):
    safe = ensure_public_url(url)
    started = time.perf_counter()
    # Reuse TCP/TLS connections without carrying cookies from another target.
    r = _fresh_get(safe, timeout=timeout, allow_redirects=True)
    elapsed = round((time.perf_counter() - started) * 1000)
    r.raise_for_status()
    r._seo_elapsed_ms = elapsed
    return r


def extract_page(url, force_refresh=False):
    cache_key = normalize_page_url(url) if "normalize_page_url" in globals() else str(url).strip().rstrip("/").lower()
    cached = None if force_refresh else _cache_get(_page_cache, cache_key, CACHE_TTL)
    if cached is not None:
        return json.loads(json.dumps(cached))
    r = fetch(url)
    soup = BeautifulSoup(r.text, "lxml")
    final = r.url

    def meta(name):
        tag = soup.find("meta", attrs={"name": re.compile("^" + re.escape(name) + "$", re.I)})
        return clean_text(tag.get("content", "")) if tag else ""

    title = clean_text(soup.title.get_text(" ", strip=True) if soup.title else "")
    canonical_tag = soup.find("link", rel=lambda x: x and "canonical" in x)
    canonical = urljoin(final, canonical_tag.get("href", "")) if canonical_tag and canonical_tag.get("href") else ""
    imgs = soup.find_all("img")
    links = []
    internal, external = set(), set()
    host = urlparse(final).netloc.lower()

    for a in soup.find_all("a", href=True):
        href = urljoin(final, a["href"])
        href, _ = urldefrag(href)
        p = urlparse(href)
        if p.scheme not in ("http", "https"):
            continue
        anchor = clean_text(a.get_text(" ", strip=True))
        href = normalize_page_url(href)
        links.append({"href": href, "anchor": anchor, "rel": a.get("rel", [])})
        same_host = p.netloc.lower().removeprefix("www.") == host.removeprefix("www.")
        (internal if same_host else external).add(href)

    schemas = []
    for s in soup.find_all("script", attrs={"type": re.compile(r"application/ld\+json", re.I)}):
        raw = s.get_text(strip=True)
        try:
            schemas.append(json.loads(raw))
        except Exception:
            schemas.append({"raw": raw[:1000], "parse_error": True})

    text = clean_text(soup.get_text(" ", strip=True))
    words = re.findall(r"\b[\w'-]+\b", text)
    robots = meta("robots")
    xrobots = clean_text(r.headers.get("x-robots-tag", ""))
    result = {
        "requested_url": url,
        "url": final,
        "final_url": final,
        "status_code": r.status_code,
        "content_type": r.headers.get("content-type", ""),
        "response_time_ms": getattr(r, "_seo_elapsed_ms", None),
        "redirect_count": len(r.history),
        "redirect_chain": [h.url for h in r.history] + [final],
        "title": title,
        "title_length": len(title),
        "meta_description": meta("description"),
        "meta_description_length": len(meta("description")),
        "canonical": canonical,
        "robots": robots,
        "x_robots_tag": xrobots,
        "viewport": meta("viewport"),
        "charset": clean_text((soup.find("meta", charset=True) or {}).get("charset", "")) if soup.find("meta", charset=True) else "",
        "lang": clean_text((soup.find("html") or {}).get("lang", "")),
        "h1_count": len(soup.find_all("h1")),
        "h2_count": len(soup.find_all("h2")),
        "h3_count": len(soup.find_all("h3")),
        "h1": [clean_text(x.get_text(" ", strip=True)) for x in soup.find_all("h1")],
        "h2": [clean_text(x.get_text(" ", strip=True)) for x in soup.find_all("h2")],
        "h3": [clean_text(x.get_text(" ", strip=True)) for x in soup.find_all("h3")],
        "image_count": len(imgs),
        "images_without_alt": sum(1 for i in imgs if not clean_text(i.get("alt"))),
        "internal_links": len(internal),
        "external_links": len(external),
        "word_count": len(words),
        "schema_blocks": len(schemas),
        "structured_data": schemas[:30],
        "links": links,
        "text": text,
        "text_excerpt": text[:3000],
    }
    _cache_put(_page_cache, cache_key, result)
    return result


def domain_match(url, target):
    try:
        return urlparse(url).netloc.lower().removeprefix("www.") == urlparse(target).netloc.lower().removeprefix("www.")
    except Exception:
        return False


_TRACKING_PARAMS = {"utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","gclid","fbclid","msclkid","dclid","mc_cid","mc_eid"}

def normalize_page_url(value):
    """Stable URL identity for crawling/cache/database comparisons.
    Fragments and known tracking parameters are removed; functional query
    parameters are preserved and sorted so distinct pages cannot collide.
    """
    try:
        u = urlparse(str(value).strip())
        if u.scheme.lower() not in {"http", "https"} or not u.netloc:
            return str(value or "").strip().rstrip("/").lower()
        host = u.hostname.lower().removeprefix("www.") if u.hostname else ""
        port = u.port
        if (u.scheme.lower() == "http" and port == 80) or (u.scheme.lower() == "https" and port == 443):
            port = None
        netloc = host + (f":{port}" if port else "")
        path = re.sub(r"/{2,}", "/", u.path or "/")
        path = path.rstrip("/") or "/"
        from urllib.parse import parse_qsl, urlencode
        query = sorted((k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if k.lower() not in _TRACKING_PARAMS)
        qs = urlencode(query, doseq=True)
        return f"{u.scheme.lower()}://{netloc}{path}" + (f"?{qs}" if qs else "")
    except Exception:
        return str(value or "").strip().rstrip("/").lower()


def exact_page_match(url, target):
    return normalize_page_url(url) == normalize_page_url(target)


def serp_snapshot(keyword, country_code="us", num=10):
    if not SERPAPI_KEY:
        raise HTTPException(503, "SERPAPI_KEY is not configured in the Python SEO Engine. Add it to .env to use live Google ranking features.")
    keyword = clean_text(keyword)
    if not keyword:
        raise HTTPException(400, "Keyword is required.")
    c = country(country_code)
    n = min(max(int(num), 1), 100)
    cache_key = (keyword.lower(), c["code"], n)
    cached = _cache_get(_serp_cache, cache_key, SERP_CACHE_TTL)
    if cached is not None:
        return json.loads(json.dumps(cached))
    params = {
        "engine": "google", "q": keyword, "num": n,
        "gl": c["gl"], "hl": c["hl"], "google_domain": c["google_domain"],
        "api_key": SERPAPI_KEY, "no_cache": "true",
    }
    started = time.perf_counter()
    r = None; last_err = None
    for attempt in range(3):  # retry transient timeouts/connection resets
        try:
            r = _fresh_get("https://serpapi.com/search.json", timeout=(10, 60), allow_redirects=True, params=params)
            break
        except requests.RequestException as e:
            last_err = e; time.sleep(1.5 * (attempt + 1))
    if r is None:
        raise HTTPException(502, "Could not reach SerpApi after 3 tries (network/firewall/VPN or SerpApi slowdown). Check that this machine can open https://serpapi.com, then retry. Detail: " + str(last_err)[:160])
    elapsed = round((time.perf_counter() - started) * 1000)
    if not r.ok:
        detail = clean_text(r.text)[:300]
        # Preserve actionable upstream status information. Invalid credentials/quota
        # should not be presented to the UI as a mysterious generic 502.
        if r.status_code == 429:
            raise HTTPException(429, f"SerpApi rate limit or quota reached: {detail or 'try again later.'}")
        if r.status_code in (401, 403):
            raise HTTPException(503, f"SerpApi authentication failed. Check SERPAPI_KEY: {detail or 'provider rejected the key.'}")
        raise HTTPException(502, f"SerpApi request failed with status {r.status_code}: {detail}")
    try:
        d = r.json()
    except ValueError:
        raise HTTPException(502, "SerpApi returned invalid JSON.")
    if d.get("error"):
        raise HTTPException(502, str(d["error"]))

    organic = []
    for i, x in enumerate(d.get("organic_results", []), start=1):
        organic.append({
            "position": x.get("position", i),
            "title": clean_text(x.get("title", "")),
            "link": x.get("link", x.get("redirect_link", "")),
            "redirect_link": x.get("redirect_link", ""),
            "displayed_link": clean_text(x.get("displayed_link", x.get("link", ""))),
            "snippet": clean_text(x.get("snippet", "")),
            "source": clean_text(x.get("source", "")),
            "date": clean_text(x.get("date", "")),
            "rich_snippet": x.get("rich_snippet", {}),
        })
    result = {
        "keyword": keyword,
        "country": c,
        "results": organic,
        "related_searches": [clean_text(x.get("query", x.get("title", ""))) for x in d.get("related_searches", []) if clean_text(x.get("query", x.get("title", "")))],
        "people_also_ask": [{"question": clean_text(x.get("question", "")), "snippet": clean_text(x.get("snippet", "")), "link": x.get("link", "")} for x in d.get("related_questions", []) if clean_text(x.get("question", ""))],
        "search_metadata": {
            "engine": "google",
            "provider": "SerpApi",
            "query": keyword,
            "google_domain": c["google_domain"],
            "gl": c["gl"],
            "hl": c["hl"],
            "country": c["label"],
            "requested_results": n,
            "organic_results_returned": len(organic),
            "response_time_ms": elapsed,
            "checked_at": now_iso(),
            "serpapi_search_metadata": d.get("search_metadata", {}),
        },
    }
    _cache_put(_serp_cache, cache_key, result)
    return result


def technical_data(page, host_checks=None):
    p = urlparse(page["url"])
    base = f"{p.scheme}://{p.netloc}"
    checks = host_checks if host_checks is not None else {}
    if not checks:
        for name, path in [("robots_txt", "/robots.txt"), ("sitemap", "/sitemap.xml")]:
            try:
                r = _fresh_get(base + path, timeout=10, allow_redirects=True)
                checks[name] = {"url": base + path, "status": r.status_code, "found": r.status_code == 200, "content_type": r.headers.get("content-type", "")}
            except requests.RequestException as e:
                checks[name] = {"url": base + path, "status": None, "found": False, "error": str(e)}
    return {
        "page": page,
        "https": p.scheme.lower() == "https",
        "final_url": page["url"],
        "redirect_count": page["redirect_count"],
        "robots_txt": checks["robots_txt"],
        "sitemap": checks["sitemap"],
        "checked_at": now_iso(),
    }


def technical_checks(t):
    p = t["page"]
    out = []
    def add(status, name, evidence, why, fix):
        out.append({"status": status, "name": name, "label": name, "details": evidence, "value": evidence, "evidence": evidence, "why": why, "recommended_fix": fix})

    add("pass" if t["https"] else "fail", "HTTPS", "HTTPS is enabled." if t["https"] else "The final URL uses HTTP.", "HTTPS protects users and is expected for modern indexable pages.", "Serve the site over HTTPS and redirect HTTP URLs to HTTPS.")
    sc = int(p.get("status_code") or 0)
    add("pass" if 200 <= sc < 400 else "fail", "HTTP status", f"Final page returned HTTP {sc}.", "Search engines and users need a successful page response.", "Return a stable 200 response for the intended canonical page.")
    rc = int(p.get("redirect_count") or 0)
    add("pass" if rc <= 1 else "warning", "Redirect chain", f"The request followed {rc} redirect(s).", "Long redirect chains waste crawl efficiency and can create fragile URL paths.", "Keep redirects to a single direct hop where possible.")
    add("pass" if p.get("viewport") else "warning", "Mobile viewport", p.get("viewport") or "No viewport meta tag was detected.", "Mobile rendering is a core usability and SEO signal.", "Add a responsive viewport meta tag.")
    add("pass" if p.get("canonical") else "warning", "Canonical URL", f"Canonical: {p['canonical']}" if p.get("canonical") else "No canonical link was detected.", "Canonicalization helps consolidate duplicate URL variants.", "Add the preferred canonical URL when appropriate.")
    rt = t["robots_txt"]
    add("pass" if rt.get("found") else "warning", "robots.txt", f"robots.txt returned HTTP {rt.get('status')}." if rt.get("status") else "robots.txt could not be verified.", "robots.txt controls crawler guidance at the host level.", "Publish a valid robots.txt if crawler directives are needed.")
    sm = t["sitemap"]
    add("pass" if sm.get("found") else "warning", "XML sitemap", f"sitemap.xml returned HTTP {sm.get('status')}." if sm.get("status") else "sitemap.xml could not be verified.", "An XML sitemap can help search engines discover canonical URLs efficiently.", "Publish and reference a valid XML sitemap when the site warrants one.")
    noindex = bool(re.search(r"noindex", f"{p.get('robots','')} {p.get('x_robots_tag','')}", re.I))
    add("fail" if noindex else "pass", "Indexability directive", f"Noindex observed: {p.get('robots') or p.get('x_robots_tag')}" if noindex else "No page-level noindex directive was observed.", "A noindex directive prevents a page from being eligible for normal organic indexing.", "Remove noindex if this page should rank.")
    add("pass" if p.get("internal_links", 0) > 0 else "warning", "Internal links", f"{p.get('internal_links',0)} unique same-domain internal URLs were detected.", "Internal links help discovery and distribute contextual relevance.", "Add contextual internal links to important related pages.")
    ct = p.get("content_type", "")
    add("pass" if "text/html" in ct.lower() else "warning", "HTML content type", f"Content-Type: {ct or 'not reported'}.", "The SEO page checks assume an HTML document.", "Return the intended page as text/html.")
    schema = int(p.get("schema_blocks", 0))
    add("pass" if schema else "warning", "Structured data", f"{schema} JSON-LD block(s) detected.", "Relevant structured data can clarify entities and page types to search engines.", "Add only valid Schema.org JSON-LD that genuinely describes the page.")
    return out, verified_score(out)


def action_engine(page):
    actions = []
    def add(priority, category, title, desc, fix, evidence=None):
        actions.append({"id": f"{category.lower().replace(' ','-')}-{len(actions)+1}", "priority": priority, "category": category, "title": title, "description": desc, "recommended_fix": fix, "field": evidence or "", "status": "open", "evidence": evidence or desc})
    t, m, h1, h2 = page["title"], page["meta_description"], page["h1"], page["h2"]
    if not t: add("critical", "On-page", "Missing title tag", "No <title> element was detected.", "Add a unique, descriptive title aligned with the page's search intent.")
    elif len(t) < 30: add("warning", "On-page", "Title is short", f"The title is {len(t)} characters.", "Strengthen it with the primary topic and a clear value proposition.", t)
    elif len(t) > 60: add("warning", "On-page", "Title may be truncated", f"The title is {len(t)} characters.", "Move the most important wording earlier and shorten the title.", t)
    if not m: add("critical", "On-page", "Missing meta description", "No meta description was detected.", "Write a unique description that explains the page and matches intent.")
    elif len(m) < 120: add("warning", "On-page", "Meta description is short", f"The description is {len(m)} characters.", "Add useful context and a natural value proposition.", m)
    elif len(m) > 170: add("warning", "On-page", "Meta description may be truncated", f"The description is {len(m)} characters.", "Trim it so the important message appears earlier.", m)
    if not h1: add("critical", "Content", "Missing H1", "No H1 heading was detected.", "Add one clear primary H1 describing the main topic.")
    elif len(h1) > 1: add("warning", "Content", "Multiple H1 headings", f"Detected {len(h1)} H1 elements.", "Use one primary H1 and H2/H3 headings for subsections.", " | ".join(h1[:5]))
    if not h2 and page["word_count"] > 300: add("warning", "Content", "No H2 headings", "The page has substantial visible text but no H2 headings.", "Break substantial content into descriptive H2 sections.")
    if not page["viewport"]: add("warning", "Technical", "Missing mobile viewport", "No viewport meta tag was detected.", "Add a responsive viewport meta tag.")
    if page["image_count"] and page["images_without_alt"]:
        pri = "critical" if page["images_without_alt"] > 5 else "warning"
        add(pri, "Accessibility", "Images missing alt text", f"{page['images_without_alt']} of {page['image_count']} images lack alt text.", "Add concise descriptive alt text to informative images and empty alt for decorative images.")
    if not page["internal_links"]: add("warning", "Internal links", "No internal links detected", "No same-site links were detected on the page.", "Add contextual links to relevant pages.")
    if not page["canonical"]: add("warning", "Technical", "Missing canonical URL", "No canonical link was detected.", "Add the preferred canonical URL when appropriate.")
    if re.search(r"noindex", f"{page['robots']} {page['x_robots_tag']}", re.I): add("critical", "Indexability", "Page contains noindex", f"Robots directives: {page['robots'] or page['x_robots_tag']}", "Remove noindex if the page should appear in organic search.")
    if not page["schema_blocks"]: add("warning", "Structured data", "No JSON-LD detected", "No JSON-LD structured data blocks were detected.", "Add relevant valid structured data where it genuinely describes the page.")
    if page["word_count"] < 300: add("warning", "Content", "Low visible content depth", f"About {page['word_count']} visible words were detected.", "Make sure the page completely answers its intent with useful original content; do not add filler.")
    return actions




# Weighted, evidence-based scoring. Optional signals (for example Schema, sitemap,
# canonical and H2/H3 presence) are informational when absent and must not drag a
# healthy site down simply because the signal is not required for every page.
CHECK_WEIGHTS = {
    "https": 8, "http status": 12, "redirect chain": 5, "mobile viewport": 3,
    "internal linking": 6, "html content type": 6, "html language": 2,
    "robots.txt": 0, "xml sitemap": 0, "title tag": 10, "meta description": 8,
    "h1 structure": 10, "h2 structure": 2, "h3 depth": 1,
    "visible content depth": 5, "image alt coverage": 5,
    "indexability directive": 12, "canonical url": 2, "robots discovery": 0,
    "sitemap discovery": 0, "structured data / schema": 1, "json-ld validity": 2,
}

def check_weight(check):
    name = str(check.get("name") or check.get("label") or "").strip().lower()
    if name in CHECK_WEIGHTS:
        return CHECK_WEIGHTS[name]
    # Unknown checks still participate, but cannot dominate the score.
    return 2


def verified_score(checks):
    """Single deterministic weighted score used by every Python Agent surface.

    pass = full weight, warning = 35% of weight, fail/critical = 0.
    Informational checks carry zero weight. This measures verified page health; it
    is not a Google ranking score or a prediction of search performance.
    """
    checks = [x for x in (checks or []) if isinstance(x, dict)]
    scored = [x for x in checks if str(x.get("status", "")).lower() not in {"info", "informational", "n/a", "na"} and check_weight(x) > 0]
    total = sum(check_weight(x) for x in scored)
    if not total:
        return 0
    earned = 0.0
    for x in scored:
        status = str(x.get("status", "")).lower()
        w = check_weight(x)
        if status in {"pass", "passed", "good", "verified"}:
            earned += w
        elif status in {"warning", "warn", "needs_attention"}:
            earned += w * 0.35

    score = max(0, min(100, round(earned / total * 100)))

    # A perfect score is reserved for a complete audit where every check has an
    # explicit pass/fail/warning state. Informational/not-measured checks mean the
    # audit is incomplete, even when all measured checks pass. This prevents
    # ``no detected errors`` from being presented as ``perfect SEO``.
    incomplete = any(
        str(x.get("status", "")).lower() in {"info", "informational", "n/a", "na", "not_tested", "not_measured"}
        for x in checks
    )
    if incomplete and score >= 100:
        score = 99
    return score


def action_summary(actions):
    critical = sum(a["priority"] == "critical" for a in actions)
    high = sum(a["priority"] == "high" for a in actions)
    medium = sum(a["priority"] == "medium" for a in actions)
    low = sum(a["priority"] == "low" for a in actions)
    # Action Center is a recommendation list, not a second scoring engine.
    # The authoritative score comes from build_section_checks()/verified_score().
    return {"critical": critical, "high": high, "medium": medium, "low": low, "passed": max(0, 0), "actions": actions}


def content_gaps(page, topic=""):
    topic = topic or page["title"] or (page["h1"][0] if page["h1"] else "the topic")
    covered = (page["title"] + " " + " ".join(page["h1"] + page["h2"] + page["h3"]) + " " + page["text"][:12000]).lower()
    candidates = [
        ("Definition and fundamentals", "high", "Clarify the core concept and terminology.", f"What Is {topic}?", "informational"),
        ("How-to process", "high", "A step-by-step process improves task completion and intent coverage.", f"How to Use {topic}", "informational"),
        ("Best practices", "high", "Practical guidance adds useful depth and decision support.", f"Best Practices for {topic}", "informational"),
        ("Common mistakes", "medium", "Addressing pitfalls answers follow-up questions and reduces uncertainty.", f"Common {topic} Mistakes to Avoid", "informational"),
        ("Examples or use cases", "medium", "Concrete examples make the page more useful and differentiated.", "Examples and Use Cases", "commercial"),
        ("FAQ", "medium", "Direct answers can improve completeness and long-tail coverage.", "Frequently Asked Questions", "informational"),
    ]
    gaps = []
    for title, prio, why, heading, intent in candidates:
        tokens = [w for w in re.findall(r"\b[a-z]{5,}\b", title.lower())[:2]]
        if not all(token in covered for token in tokens):
            gaps.append({"gap_title": title, "priority": prio, "why_it_matters": why, "suggested_heading": "H2: " + heading, "search_intent": intent,
                         "fill_content": f"Create a concise, expert section covering {title.lower()} for {topic}. Use specific, verifiable claims and practical examples where they improve the user's outcome."})
    return gaps[:6]


class AnalyzeRequest(BaseModel): url: str; section: str = ""
class CrawlRequest(BaseModel): url: str; max_pages: int = Field(default=25, ge=1, le=100)
class KeywordRequest(BaseModel): url: str; seed: str = ""; intent: str = "all"; country: str = "us"; excludeKeywords: list[str] = Field(default_factory=list)
class ContentRequest(BaseModel): url: str; goal: str = "improve-existing"; tone: str = "professional"; topic: str = ""
class GapRequest(BaseModel): url: str; topic: str = ""; tone: str = "professional"
class RankRequest(BaseModel): url: str; keyword: str; country: str = "us"
class TopRequest(BaseModel): keyword: str; country: str = "us"
class CompetitorRequest(BaseModel): url: str; keyword: str = ""; country: str = "us"
class ActionRequest(BaseModel): url: str
class VerifyRequest(BaseModel): url: str
class LinkOppRequest(BaseModel): url: str; keyword: str = ""; maxPages: int = Field(default=25, ge=1, le=50)
class GscRequest(BaseModel): rows: list[dict] = Field(default_factory=list)
class DashboardRequest(BaseModel): url: str
class ActionCenterRequest(BaseModel): url: str
class KeywordGapRequest(BaseModel): url: str; competitors: list[str] = Field(default_factory=list); keywords: list[str] = Field(default_factory=list); country: str = "us"
class ContentDecayRequest(BaseModel): pages: list[dict] = Field(default_factory=list)
class RankHistoryRequest(BaseModel): snapshots: list[dict] = Field(default_factory=list)
class ReportRequest(BaseModel): report: dict = Field(default_factory=dict)


@app.get("/")
def root():
    return {"name":"SEO Agent Python Engine","status":"running","version":"3.0.0","source":"Python FastAPI","serpapi_configured":bool(SERPAPI_KEY),"endpoints":[
        "/analyze","/site-audit","/seo-actions","/technical-check","/verify-url","/links","/crawl","/keywords","/content","/content-gap","/rank-check","/top-rankings","/competitors","/internal-link-opportunities","/gsc-import","/pagespeed","/domain-authority","/monitor-snapshot","/backlink-opportunities","/rank-track","/keyword-opportunity","/keyword-verify","/content-plan","/ai-recommendations","/trends"]}


@app.get("/health")
def health():
    return {"status":"healthy","service":"python-seo-engine","version":"3.0.0","serpapi_configured":bool(SERPAPI_KEY),"checked_at":now_iso()}


@app.post("/analyze")
def analyze(b: AnalyzeRequest):
    p = extract_page(b.url, force_refresh=True)
    t = technical_data(p)
    checks = build_section_checks(p, t, "all")
    actions = action_engine(p)
    score = verified_score(checks)
    critical = sum(x["status"] == "fail" for x in checks)
    warnings = sum(x["status"] == "warning" for x in checks)
    passed = sum(x["status"] == "pass" for x in checks)
    lines = [f"SEO_SCORE: {score}", f"CRITICAL_ISSUES: {critical}", f"WARNINGS: {warnings}", f"PASSED: {max(0, passed)}", "SUMMARY:", f"Python SEO Engine verified {len(checks)} technical signals plus {len(actions)} actionable on-page/content signals on {p['url']}.", "", "FINDINGS:"]
    for c in checks:
        typ = "CRITICAL" if c["status"] == "fail" else "WARNING" if c["status"] == "warning" else "PASSED"
        lines.append(f"- {typ} | {c['name']} | {c['details']}")
    for a in actions[:15]:
        lines.append(f"- {a['priority'].upper()} | {a['title']} | {a['description']} Recommended fix: {a['recommended_fix']}")
    lines += ["", "TOP_ACTIONS:"] + [f"{i}. {a['recommended_fix']}" for i,a in enumerate(actions[:5],1)]
    lines += ["", "WHAT_WAS_CHECKED:", f"HTTP status {p['status_code']}; redirects {p['redirect_count']}; title length {p['title_length']}; meta description length {p['meta_description_length']}; H1 {p['h1_count']}; H2 {p['h2_count']}; words {p['word_count']}; internal links {p['internal_links']}; images missing alt {p['images_without_alt']}; JSON-LD blocks {p['schema_blocks']}; robots.txt {t['robots_txt']['status']}; sitemap.xml {t['sitemap']['status']}."]
    return {"success":True,"source":"Python FastAPI SEO Engine","url":p["url"],"evidence":p,"technical":t,"audit":{"overall_status":"Critical" if critical else "Needs Attention" if warnings else "Healthy","score":score,"critical":critical,"warnings":warnings,"passed":max(0,passed),"checks":checks,"actions":actions},"text":"\n".join(lines)}


def build_section_checks(p, t, section="all"):
    technical, _ = technical_checks(t)
    out=[]
    def add(status,name,evidence,why,fix,category):
        out.append({"status":status,"name":name,"label":name,"details":evidence,"value":evidence,"evidence":evidence,"why":why,"recommended_fix":fix,"category":category})
    if section in ("all","technical"):
        add("pass" if p["url"].lower().startswith("https://") else "fail","HTTPS","Final URL: " + p["url"],"HTTPS protects transport and is expected for modern sites.","Use HTTPS everywhere and redirect HTTP to the canonical HTTPS URL.","Technical")
        sc=p["status_code"]; add("pass" if 200<=sc<400 else "fail","HTTP status",f"Final response returned HTTP {sc}.","A successful response is required for a crawlable page.","Return HTTP 200 for the intended indexable page.","Technical")
        add("pass" if p["redirect_count"]<=1 else "warning","Redirect chain",f"{p['redirect_count']} redirect(s) followed. Chain: {' → '.join(p['redirect_chain'][:6])}","Long chains waste crawl efficiency and can dilute URL consistency.","Use a single direct redirect hop where possible.","Technical")
        add("pass" if p["viewport"] else "warning","Mobile viewport",p["viewport"] or "Viewport meta tag not detected.","Responsive rendering affects mobile usability and search experience.","Add a responsive viewport meta tag.","Technical")
        add("pass" if p["internal_links"] else "warning","Internal linking",f"{p['internal_links']} unique same-domain internal URLs detected.","Internal links support discovery and contextual authority flow.","Add contextual internal links to important related pages.","Technical")
        add("pass" if "text/html" in p["content_type"].lower() else "warning","HTML content type",f"Content-Type: {p['content_type'] or 'not reported'}","SEO page analysis expects an HTML document.","Return the intended page as text/html.","Technical")
        add("pass" if p["lang"] else "info","HTML language",f"lang={p['lang'] or 'not detected'}","A language declaration improves document interpretation and accessibility.","Add the correct lang attribute to the html element.","Technical")
        for key,label in (("robots_txt","robots.txt"),("sitemap","XML sitemap")):
            item=t[key]; add("pass" if item.get("found") else "info",label,f"{label} returned HTTP {item.get('status')}. URL: {item.get('url')}","Crawler directives and sitemap discovery can support efficient indexing.",f"Publish a valid {label} and keep it reachable with HTTP 200 when appropriate.","Technical")
    if section in ("all","onpage"):
        tl=p["title_length"]; add("pass" if 30<=tl<=60 else "warning" if p["title"] else "fail","Title tag",f"Title: {p['title'] or 'missing'} ({tl} characters)","The title communicates the page topic and is a major search-result signal.","Write one unique, descriptive title with the primary topic and value proposition.","On-page")
        ml=p["meta_description_length"]; add("pass" if 70<=ml<=170 else "warning" if p["meta_description"] else "fail","Meta description",f"Meta description: {p['meta_description'] or 'missing'} ({ml} characters)","A useful description can improve search-result clarity and click appeal.","Write a unique, concise description matching the page intent.","On-page")
        add("pass" if p["h1_count"]==1 else "warning" if p["h1_count"]>1 else "fail","H1 structure",f"{p['h1_count']} H1 heading(s): {' | '.join(p['h1'][:4]) or 'none'}","A clear primary heading makes the page topic explicit.","Use one clear H1 that matches the main page intent.","On-page")
        add("pass" if p["h2_count"]>0 else "info","H2 structure",f"{p['h2_count']} H2 heading(s): {' | '.join(p['h2'][:8]) or 'none'}","Subheadings improve scannability and topical organization.","Use descriptive H2 sections for substantial content.","On-page")
        add("pass" if p["h3_count"]>0 or p["h2_count"]<3 else "info","H3 depth",f"{p['h3_count']} H3 heading(s) detected.","Nested headings help organize detailed sections when the content warrants them.","Add H3s where a H2 contains multiple distinct subtopics.","On-page")
        add("pass" if p["word_count"]>=300 else "warning","Visible content depth",f"Approximately {p['word_count']:,} visible words were extracted.","Depth should match the search intent; more words are not automatically better.","Expand missing useful sections rather than adding filler.","Content")
        alt_status="pass" if p["image_count"]==0 or p["images_without_alt"]==0 else "warning"
        add(alt_status,"Image alt coverage",f"{p['images_without_alt']} of {p['image_count']} images lack alt text.","Descriptive alt text improves accessibility and image understanding.","Add concise alt text to informative images; leave decorative images empty.","Accessibility")
    if section in ("all","indexing"):
        noindex=bool(re.search(r"noindex",f"{p['robots']} {p['x_robots_tag']}",re.I))
        add("fail" if noindex else "pass","Indexability directive",f"Robots: {p['robots'] or 'none'}; X-Robots-Tag: {p['x_robots_tag'] or 'none'}; noindex={noindex}","A noindex directive removes a page from normal organic indexing eligibility.","Remove noindex if this page should rank.","Indexability")
        add("pass" if p["canonical"] else "info","Canonical URL",f"Canonical: {p['canonical'] or 'not detected'}","Canonicalization consolidates duplicate URL variants.","Add the preferred canonical URL when this page should be indexed.","Indexability")
        add("pass" if t["robots_txt"].get("found") else "info","Robots discovery",f"robots.txt HTTP status: {t['robots_txt'].get('status')}","Search engines use robots.txt for host-level crawler guidance.","Publish a valid robots.txt when crawler directives are needed.","Indexability")
        add("pass" if t["sitemap"].get("found") else "info","Sitemap discovery",f"sitemap.xml HTTP status: {t['sitemap'].get('status')}","Sitemaps help search engines discover canonical URLs efficiently.","Publish a valid XML sitemap and keep it current.","Indexability")
        add("pass" if p["schema_blocks"] else "info","Structured data / Schema",f"{p['schema_blocks']} JSON-LD block(s) detected.","Valid structured data can clarify entities and eligible rich-result types.","Add only valid Schema.org JSON-LD that genuinely describes the page.","Schema")
        invalid=sum(1 for x in p["structured_data"] if isinstance(x,dict) and x.get("parse_error"))
        add("pass" if invalid==0 else "warning","JSON-LD validity","Parsed JSON-LD blocks: %s; parse errors: %s."%(p['schema_blocks'],invalid),"Malformed structured data may be ignored by search engines.","Fix malformed JSON-LD and validate it against the intended Schema.org type.","Schema")
    return out


@app.post("/site-audit")
def site_audit(b: AnalyzeRequest):
    p=extract_page(b.url, force_refresh=True); t=technical_data(p)
    section=clean_text(getattr(b,"section","") if hasattr(b,"section") else "").lower() or "all"
    selected=build_section_checks(p,t,section if section in {"technical","onpage","indexing","all"} else "all")
    critical=sum(x["status"]=="fail" for x in selected); warnings=sum(x["status"]=="warning" for x in selected); passed=sum(x["status"]=="pass" for x in selected)
    return {"success":True,"source":"Python FastAPI SEO Engine","section":section,"url":p["url"],"technical":t,"seo":p,"audit":{"overall_status":"Critical" if critical else "Needs Attention" if warnings else "Healthy","score":verified_score(selected),"checks":selected,"summary":{"checked":len(selected),"critical":critical,"warnings":warnings,"passed":passed},"evidence":{"title":p["title"],"metaDescription":p["meta_description"],"h1":p["h1"],"h2":p["h2"],"h3":p["h3"],"wordCount":p["word_count"],"imageCount":p["image_count"],"imagesWithoutAlt":p["images_without_alt"],"internalLinks":p["internal_links"],"canonical":p["canonical"],"robots":p["robots"],"schemaBlocks":p["schema_blocks"]},"recommendationSummary":[x["recommended_fix"] for x in selected][:15],"checked_at":now_iso()}}


@app.post("/seo-actions")
def seo_actions(b: ActionRequest):
    p=extract_page(b.url, force_refresh=True); s=action_summary(action_engine(p)); return {"success":True,"source":"Python evidence-first SEO action engine","url":p["url"],**s,"checked":{"title":p["title"],"metaDescription":p["meta_description"],"h1":p["h1"],"h2":p["h2"],"wordCount":p["word_count"]}}


@app.post("/technical-check")
@app.post("/technical")
def technical_check(b: AnalyzeRequest):
    p=extract_page(b.url, force_refresh=True); t=technical_data(p); checks=build_section_checks(p,t,"technical"); score=verified_score(checks)
    return {"success":True,"source":"Python FastAPI SEO Engine","url":p["url"],"technical":t,"checks":checks,"score":score,"summary":{"checked":len(checks),"passed":sum(x["status"]=="pass" for x in checks),"warnings":sum(x["status"]=="warning" for x in checks),"critical":sum(x["status"]=="fail" for x in checks)},"audit":{"overall_status":"Critical" if any(x["status"]=="fail" for x in checks) else "Needs Attention" if any(x["status"]=="warning" for x in checks) else "Healthy","score":score,"checks":checks}}


@app.post("/verify-url")
def verify_url(b: VerifyRequest):
    p=extract_page(b.url, force_refresh=True); t=technical_data(p); checks,score=technical_checks(t)
    return {"success":True,"source":"Python FastAPI SEO Engine","url":p["requested_url"],"finalUrl":p["url"],"fetchedAt":now_iso(),"score":score,"checks":checks,"technical":t}


@app.post("/links")
def links(b: AnalyzeRequest):
    p=extract_page(b.url, force_refresh=True); internal=sorted({x["href"] for x in p["links"] if domain_match(x["href"],p["url"])}); external=sorted({x["href"] for x in p["links"] if not domain_match(x["href"],p["url"])})
    return {"success":True,"url":p["url"],"internal":internal,"external":external,"counts":{"internal":len(internal),"external":len(external)},"anchors":p["links"][:100]}


@app.post("/crawl")
def crawl(b: CrawlRequest):
    start=ensure_public_url(b.url); root_host=urlparse(start).netloc.lower().removeprefix("www."); q=deque([normalize_page_url(start)]); seen=set(); pages=[]
    host_parts=urlparse(start); host_base=f"{host_parts.scheme}://{host_parts.netloc}"; host_checks={}
    for name,path in [("robots_txt","/robots.txt"),("sitemap","/sitemap.xml")]:
        try:
            r=_fresh_get(host_base+path, timeout=10, allow_redirects=True)
            host_checks[name]={"url":host_base+path,"status":r.status_code,"found":r.status_code==200,"content_type":r.headers.get("content-type","")}
        except requests.RequestException as e:
            host_checks[name]={"url":host_base+path,"status":None,"found":False,"error":str(e)}
    # Crawl several independent pages concurrently; this is substantially faster than
    # waiting for each page/network request serially. The per-page cache still protects
    # repeated audits from duplicate downloads.
    def crawl_one(u):
        try:
            p=extract_page(u, force_refresh=False); a=action_summary(action_engine(p)); t=technical_data(p, host_checks.copy()); checks=build_section_checks(p, t, "all"); page_score=verified_score(checks)
            return {"url":p["url"],"status_code":p["status_code"],"title":p["title"],"word_count":p["word_count"],"score":page_score,"critical":sum(x["status"]=="fail" for x in checks),"warnings":sum(x["status"]=="warning" for x in checks),"internal_links":p["internal_links"],"h1_count":p["h1_count"],"h2_count":p["h2_count"],"technical":t,"actions":a["actions"]}, p["links"]
        except Exception as e:
            return {"url":u,"error":str(e)[:300],"score":0,"critical":1,"warnings":0,"word_count":0,"actions":[]}, []
    with ThreadPoolExecutor(max_workers=8) as pool:
        while q and len(pages)<b.max_pages:
            batch=[]
            while q and len(batch)<8 and len(pages)+len(batch)<b.max_pages:
                u,_=urldefrag(q.popleft()); u=normalize_page_url(u)
                if u in seen or urlparse(u).netloc.lower().removeprefix("www.")!=root_host: continue
                seen.add(u); batch.append(u)
            if not batch: continue
            futures={pool.submit(crawl_one,u):u for u in batch}
            for fut in as_completed(futures):
                page, links=fut.result(); pages.append(page)
                for x in links:
                    href=x.get("href") if isinstance(x,dict) else ""
                    if href and domain_match(href,start):
                        normalized=normalize_page_url(href)
                        if normalized and normalized not in seen and normalized not in q and len(q)+len(pages)<b.max_pages*3: q.append(normalized)
                if len(pages)>=b.max_pages: break
    scores=[p["score"] for p in pages if isinstance(p.get("score"),(int,float))]
    summary={"pagesCrawled":len(pages),"score":round(sum(scores)/len(scores),1) if scores else None,"critical":sum(p.get("critical",0) for p in pages),"warnings":sum(p.get("warnings",0) for p in pages),"checkedAt":now_iso()}
    return {"success":True,"source":"Python crawler","start_url":start,"pages_crawled":len(pages),"average_score":summary["score"],"summary":summary,"pages":pages}


def keyword_candidates(seed, snap, page, exclude):
    exclude={clean_text(x).lower() for x in exclude if clean_text(x)}
    raw=[]
    for x in snap["related_searches"]:
        raw.append((x,"Google related search"))
    for x in snap["people_also_ask"]:
        raw.append((x["question"],"Google People Also Ask"))
    # Add query-like phrases inferred from organic titles, but clearly label them as SERP-derived topics.
    for r in snap["results"][:10]:
        title=r["title"]
        if title: raw.append((title,"Google organic result title"))
    out=[]; seen=set()
    for kw,source in raw:
        k=clean_text(kw); key=k.lower()
        if not k or key in seen or key in exclude or key == seed.lower(): continue
        seen.add(key)
        intent="Informational" if any(w in key for w in ["how","what","why","guide","learn","tips","examples"]) else "Commercial" if any(w in key for w in ["best","price","cost","service","near me","review"]) else "Mixed"
        priority="High" if source in ("Google related search","Google People Also Ask") else "Medium"
        title_signal = seed.lower() in page["title"].lower()
        out.append({"keyword":k[:160],"topic":seed,"priority":priority,"intent":intent,"recommendation":"Target if intent and page relevance match." if not title_signal else "Potential expansion: title already signals the seed topic.","source":source,"serp_evidence":{"query":snap["keyword"],"country":snap["country"]["label"],"checkedAt":snap["search_metadata"]["checked_at"]}})
    return out


@app.post("/keywords")
def keywords(b: KeywordRequest):
    p=extract_page(b.url, force_refresh=True); seed=clean_text(b.seed) or (p["h1"][0] if p["h1"] else p["title"])
    if not seed: raise HTTPException(400,"Provide a seed keyword or a page with a detectable title/H1.")
    snap=serp_snapshot(seed,b.country,20); out=keyword_candidates(seed,snap,p,b.excludeKeywords)
    return {"success":True,"url":p["url"],"seed":seed,"keywords":out[:30],"source":"Live Google SERP via SerpApi","searchMetadata":snap["search_metadata"],"relatedSearches":snap["related_searches"],"peopleAlsoAsk":snap["people_also_ask"],"volume":{"level":"Not verified","note":"This engine does not invent monthly search volume. Connect a keyword-volume provider if numeric volume is required."},"checked":{"title":p["title"],"h1":p["h1"],"wordCount":p["word_count"]}}


@app.post("/content")
def content(b: ContentRequest):
    p=extract_page(b.url, force_refresh=True); topic=clean_text(b.topic) or p["title"] or (p["h1"][0] if p["h1"] else "")
    gaps=content_gaps(p,topic)
    headings=[{"heading":x["suggested_heading"],"purpose":x["why_it_matters"]} for x in gaps]
    brief={"topic":topic,"goal":b.goal,"tone":b.tone,"currentTitle":p["title"],"recommendedTitle":topic[:58] if topic else "Create a clear topic-led title","metaDescription":p["meta_description"],"primary_intent":"Improve topical completeness and satisfy the page's detected intent.","angle":f"Build a clearer, more comprehensive resource around {topic} using evidence from the current page.","title":topic[:58] if topic else "Topic-led SEO title","headings":headings,"entities":[],"ctas":["Add a clear next step that matches the page intent."],"outline":headings,"evidence":{"wordCount":p["word_count"],"h1":p["h1"],"h2":p["h2"],"h3":p["h3"],"titleLength":p["title_length"],"metaDescriptionLength":p["meta_description_length"],"source":"Live page crawl by Python SEO Engine"}}
    return {"success":True,"contentBrief":brief}


@app.post("/content-gap")
def content_gap(b: GapRequest):
    p=extract_page(b.url, force_refresh=True); topic=b.topic or p["title"] or (p["h1"][0] if p["h1"] else "the topic"); gaps=content_gaps(p,topic)
    return {"success":True,"gapAnalysis":{"page_topic":topic,"coverage_summary":f"Python verified {len(p['h2'])} H2 sections, {len(p['h1'])} H1 headings and about {p['word_count']} visible words. The gaps below are evidence-based structural opportunities, not fabricated search-volume claims.","gaps":gaps,"evidence":{"title":p["title"],"h1":p["h1"],"h2":p["h2"],"h3":p["h3"],"wordCount":p["word_count"]}}}


def rank_payload(url, keyword, country_code, scan_num=100):
    p=extract_page(url, force_refresh=True); snap=serp_snapshot(keyword,country_code,scan_num); results=snap["results"]
    exact=next((r for r in results if exact_page_match(r["link"],p["url"])),None)
    domain=next((r for r in results if domain_match(r["link"],p["url"])),None)
    return p,snap,exact,domain


@app.post("/rank-check")
def rank_check(b: RankRequest):
    p,snap,exact,domain=rank_payload(b.url,b.keyword,b.country,100)
    evidence={"matchType":"exact-target-page" if exact else "domain-only-not-target-page" if domain else "not-found","matchedUrl":exact["link"] if exact else domain["link"] if domain else "","position":exact["position"] if exact else domain["position"] if domain else None,"exactPageCounted":bool(exact),"scannedResults":len(snap["results"]),"checkedAt":snap["search_metadata"]["checked_at"]}
    return {"success":True,"source":"Live Google SERP via SerpApi","keyword":b.keyword,"url":p["url"],"siteHostname":urlparse(p["url"]).hostname,"country":snap["country"],"scannedResults":len(snap["results"]),"ranked":bool(exact),"position":exact["position"] if exact else None,"matchedResult":exact,"domainPosition":domain["position"] if domain else None,"topResults":snap["results"][:10],"rankEvidence":evidence,"searchMetadata":snap["search_metadata"],"relatedSearches":snap["related_searches"],"peopleAlsoAsk":snap["people_also_ask"]}


@app.post("/top-rankings")
def top_rankings(b: TopRequest):
    snap=serp_snapshot(b.keyword,b.country,10)
    return {"success":True,"source":"Live Google SERP via SerpApi","keyword":b.keyword,"country":snap["country"],"results":snap["results"],"searchMetadata":snap["search_metadata"],"relatedSearches":snap["related_searches"],"peopleAlsoAsk":snap["people_also_ask"]}


@app.post("/competitors")
def competitors(b: CompetitorRequest):
    p=extract_page(b.url, force_refresh=True); kw=clean_text(b.keyword) or (p["h1"][0] if p["h1"] else p["title"])
    if not kw: raise HTTPException(400,"Provide a keyword or a page with a detectable title/H1.")
    snap=serp_snapshot(kw,b.country,20)
    candidates=[r for r in snap["results"] if not domain_match(r["link"],p["url"])][:8]
    comps=[]
    for r in candidates:
        item={"name":r["title"] or r["link"],"url":r["link"],"serp_position":r["position"],"position":r["position"],"title":r["title"],"link":r["link"],"snippet":r["snippet"],"strengths":"Live SERP evidence: this URL is positioned above or around the target in the same query snapshot.","gaps":"Page-level gap metrics are only reported when the competitor page can be fetched; traffic/backlink authority is not guessed.","how_they_beat_target":f"Observed at Google position #{r['position']} for the selected query.","whyRanking":f"SERP position #{r['position']} with snippet/title evidence from the live Google result."}
        try:
            cp=extract_page(r["link"])
            item["pageMetrics"]={"statusCode":cp["status_code"],"wordCount":cp["word_count"],"titleLength":cp["title_length"],"metaDescriptionLength":cp["meta_description_length"],"h1Count":cp["h1_count"],"h2Count":cp["h2_count"],"internalLinks":cp["internal_links"],"schemaBlocks":cp["schema_blocks"],"imagesWithoutAlt":cp["images_without_alt"]}
            item["pageComparison"]={"pageFetched":True,"targetWordCount":p["word_count"],"wordCount":cp["word_count"],"wordCountDifference":cp["word_count"]-p["word_count"],"targetH2":p["h2_count"],"h2Count":cp["h2_count"],"targetSchema":p["schema_blocks"],"schemaBlocks":cp["schema_blocks"],"targetInternalLinks":p["internal_links"],"internalLinks":cp["internal_links"],"title":cp["title"],"h1":cp["h1"],"metaDescription":cp["meta_description"]}
            item["strengths"]=f"Live Google position #{r['position']}. The fetched page contains {cp['word_count']:,} visible words, {cp['h2_count']} H2s, {cp['schema_blocks']} JSON-LD blocks and {cp['internal_links']} internal links."
            item["gaps"]=f"Compared with the target ({p['word_count']:,} words, {p['h2_count']} H2s, {p['schema_blocks']} schema blocks), the competitor has {cp['word_count']-p['word_count']:+,} words, {cp['h2_count']-p['h2_count']:+} H2s and {cp['schema_blocks']-p['schema_blocks']:+} schema blocks. These are page-level observations, not proof of causation."
        except Exception as e:
            item["pageMetricsError"]=str(e)[:220]
        comps.append(item)
    recs=["Improve intent coverage using the live related searches and People Also Ask questions.","Align title and H1 with the exact target intent.","Add contextual internal links to the target page.","Use the competitor page metrics to prioritize content depth and structure gaps."]
    return {"success":True,"source":"Live Google SERP via SerpApi + Python page comparison","competitorAnalysis":{"primary_keyword":kw,"country":snap["country"],"target_overview":{"url":p["url"],"wordCount":p["word_count"],"title":p["title"],"h1":p["h1"],"h2Count":p["h2_count"],"schemaBlocks":p["schema_blocks"]},"competitors":comps,"recommendations":recs,"searchMetadata":snap["search_metadata"],"relatedSearches":snap["related_searches"],"peopleAlsoAsk":snap["people_also_ask"]}}


@app.post("/internal-link-opportunities")
def internal_link_opportunities(b: LinkOppRequest):
    start=ensure_public_url(b.url); root_host=urlparse(start).netloc.lower(); q=deque([start]); seen=set(); pages=[]
    while q and len(pages)<b.maxPages:
        u=q.popleft()
        if u in seen or urlparse(u).netloc.lower()!=root_host: continue
        seen.add(u)
        try:
            p=extract_page(u, force_refresh=False); pages.append(p)
            for x in p["links"]:
                if domain_match(x["href"],p["url"]) and x["href"] not in seen: q.append(x["href"])
        except Exception: pass
    candidates=[]; inbound={}; kw=clean_text(b.keyword).lower()
    for p in pages:
        for link in p["links"]:
            if domain_match(link["href"],p["url"]): inbound[normalize_page_url(link["href"])]=inbound.get(normalize_page_url(link["href"]),0)+1
            anchor=link["anchor"]
            if domain_match(link["href"],p["url"]) and ((kw and kw in anchor.lower()) or (anchor and len(anchor)>3)):
                relevance=80 if kw and kw in anchor.lower() else 45
                candidates.append({"sourceTitle":p["title"],"sourceUrl":p["url"],"suggestedTarget":link["href"],"suggestedAnchor":anchor or "descriptive contextual anchor","relevance":relevance,"reason":"The link and anchor were observed directly in crawled HTML; relevance is a deterministic crawl signal, not a ranking claim.","evidence":f"Source page has {p['word_count']:,} visible words and the target link was found in its HTML."})
    orphans=[{"url":p["url"],"title":p["title"],"reason":"No inbound same-domain link was observed within this crawl scope."} for p in pages if normalize_page_url(p["url"])!=normalize_page_url(start) and inbound.get(normalize_page_url(p["url"]),0)==0]
    return {"success":True,"pagesCrawled":len(pages),"crawlScope":f"Same-domain crawl from {start}.","opportunities":sorted(candidates,key=lambda x:x["relevance"],reverse=True)[:50],"orphanCandidates":orphans[:20],"source":"Python crawl evidence","recommendations":["Prefer contextual links that help users navigate to closely related pages.","Review possible orphan pages and add at least one relevant inbound link where appropriate.","Do not force exact-match anchors when a natural descriptive anchor is clearer."]}


@app.post("/gsc-import")
def gsc_import(b: GscRequest):
    def num(v):
        try:return float(str(v).replace("%","").replace(",",""))
        except:return 0.0
    rows=b.rows or []; clicks=sum(num(r.get("clicks")) for r in rows); impressions=sum(num(r.get("impressions")) for r in rows); positions=[num(r.get("position")) for r in rows if r.get("position") not in (None,"")]
    return {"success":True,"rows":len(rows),"totals":{"clicks":clicks,"impressions":impressions,"ctr":(clicks/impressions) if impressions else None,"averagePosition":sum(positions)/len(positions) if positions else None},"source":"user-supplied Google Search Console export"}


@app.post("/pagespeed")
def pagespeed(b: AnalyzeRequest):
    if not PAGESPEED_API_KEY: raise HTTPException(503,"PAGESPEED_API_KEY is not configured in the Python SEO Engine.")
    scores={}; details={}; warnings=[]
    for cat in ["performance","accessibility","best-practices","seo"]:
        try:
            r=requests.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed",params={"url":b.url,"strategy":"mobile","category":cat,"key":PAGESPEED_API_KEY},timeout=70); d=r.json(); lr=d.get("lighthouseResult",{}); score=lr.get("categories",{}).get(cat,{}).get("score"); scores[cat]=round(score*100) if score is not None else None; details[cat]={"score":scores[cat],"fetchTime":lr.get("fetchTime"),"finalUrl":lr.get("finalUrl"),"audits":{k:{"score":v.get("score"),"title":v.get("title"),"description":v.get("description") } for k,v in list(lr.get("audits",{}).items())[:80]}}
        except Exception as e: warnings.append(f"{cat}: {e}")
    return {"success":True,"source":"Google PageSpeed Insights API","url":b.url,"strategy":"mobile","scores":{"performance":scores.get("performance"),"accessibility":scores.get("accessibility"),"bestPractices":scores.get("best-practices"),"seo":scores.get("seo")},"details":details,"warnings":warnings}


@app.post("/domain-authority")
def domain_authority(body: dict):
    domains=body.get("domains") or []
    if not OPENPR_API_KEY: raise HTTPException(503,"OPENPR_API_KEY is not configured in the Python SEO Engine.")
    cleaned=[re.sub(r"^www\.","",re.sub(r"^https?://","",str(x).strip()).split("/")[0]) for x in domains[:100]]
    r=requests.get("https://openpagerank.com/api/v1.0/getPageRank",params=[("domains[]",d) for d in cleaned],headers={"API-OPR":OPENPR_API_KEY},timeout=30)
    if not r.ok: raise HTTPException(r.status_code,f"OpenPageRank error (HTTP {r.status_code}).")
    d=r.json(); return {"success":True,"source":"OpenPageRank API","results":[{"domain":x.get("domain"),"pr":x.get("page_rank_integer",0),"prDecimal":x.get("page_rank_decimal",0),"rank":x.get("rank"),"status":x.get("status_code"),"error":x.get("error","")} for x in d.get("response",[])]}


@app.post("/monitor-snapshot")
def monitor_snapshot(b: AnalyzeRequest):
    p=extract_page(b.url, force_refresh=True); t=technical_data(p); checks=build_section_checks(p,t,"all"); score=verified_score(checks)
    critical=sum(x["status"]=="fail" for x in checks); warnings=sum(x["status"]=="warning" for x in checks)
    actions=[make_user_facing_action(x) for x in checks if x["status"]!="pass"]
    return {"success":True,"snapshot":{"url":p["url"],"score":score,"critical":critical,"warnings":warnings,"wordCount":p["word_count"],"title":p["title"],"metaDescription":p["meta_description"],"checkedAt":now_iso(),"technicalChecks":checks,"actions":actions,"scoreMethod":"Weighted verified checks: pass=100% of check weight, warning=35%, fail=0%; informational checks do not affect score."},"source":"Python SEO Engine"}


@app.post("/backlink-opportunities")
def backlink_opportunities(b: dict):
    p=extract_page(str(b.get("url","")).strip())
    return {"success":True,"source":"Python evidence-first backlink module","opportunities":[{"type":"resource outreach","title":"Create a genuinely useful resource worth citing","reason":"The Python crawl can identify content depth and gaps, but it cannot verify third-party backlink opportunities without a backlink index.","confidence":"Evidence-limited"},{"type":"internal authority","title":"Strengthen internal links to the target page","reason":f"{p['internal_links']} unique internal URLs were observed on the analyzed page.","confidence":"High"}],"note":"No backlink counts, authority, traffic, or third-party link claims are fabricated."}


@app.post("/rank-track")
def rank_track(body: dict):
    url=clean_text(body.get("url")); kws=[clean_text(k) for k in (body.get("keywords") or []) if clean_text(k)][:10]; cc=body.get("country","us")
    if not url or not kws: raise HTTPException(400,"URL and keywords are required.")
    rows=[]
    for k in kws:
        p,snap,exact,domain=rank_payload(url,k,cc,100)
        rows.append({"keyword":k,"position":exact["position"] if exact else None,"ranked":bool(exact),"domainPosition":domain["position"] if domain else None,"scannedResults":len(snap["results"]),"matchedResult":exact,"topResults":snap["results"][:10],"checkedAt":snap["search_metadata"]["checked_at"],"rankEvidence":{"matchType":"exact-target-page" if exact else "domain-only-not-target-page" if domain else "not-found","matchedUrl":exact["link"] if exact else domain["link"] if domain else "","position":exact["position"] if exact else domain["position"] if domain else None}})
    return {"success":True,"url":url,"keywords":rows,"results":rows,"country":country(cc),"source":"Live Google SERP via SerpApi","checkedAt":now_iso()}


@app.post("/keyword-opportunity")
def keyword_opportunity(body: dict):
    url = clean_text(body.get("url"))
    seed = clean_text(body.get("keyword") or body.get("seed"))
    cc = body.get("country", "us")

    # Safely extract the target page
    p = extract_page(url, force_refresh=True)

    if not p or not isinstance(p, dict):
        raise HTTPException(
            status_code=400,
            detail="Could not crawl or extract the target page. Please check that the URL is valid and publicly accessible."
        )

    # Ensure expected page fields always exist
    p.setdefault("url", url)
    p.setdefault("title", "")
    p.setdefault("h1", [])
    p.setdefault("internal_links", 0)

    if not isinstance(p["h1"], list):
        p["h1"] = []

    # Determine keyword safely
    if not seed:
        seed = p["h1"][0] if p["h1"] else p["title"]

    if not seed:
        raise HTTPException(
            status_code=400,
            detail="Keyword is required. No keyword, page title, or H1 could be found."
        )

    # Get live SERP snapshot safely
    snap = serp_snapshot(seed, cc, 100) or {}

    results = snap.get("results") or []
    related_searches = snap.get("related_searches") or []
    people_also_ask = snap.get("people_also_ask") or []
    search_metadata = snap.get("search_metadata") or {}
    country = snap.get("country") or {"code": cc, "label": str(cc).upper()}

    # Remove invalid SERP entries
    results = [r for r in results if isinstance(r, dict)]
    related_searches = [q for q in related_searches if q]
    people_also_ask = [q for q in people_also_ask if q]

    # Find exact target-page and domain matches safely
    exact = next(
        (
            r for r in results
            if r.get("link")
            and exact_page_match(r.get("link"), p.get("url", url))
        ),
        None
    )

    domain = next(
        (
            r for r in results
            if r.get("link")
            and domain_match(r.get("link"), p.get("url", url))
        ),
        None
    )

    # Build opportunities safely
    opp = []

    for q in related_searches[:12]:
        if isinstance(q, str):
            title = q
        elif isinstance(q, dict):
            title = q.get("query") or q.get("title") or q.get("question")
        else:
            title = str(q)

        if title:
            opp.append({
                "title": title,
                "detail": "Live Google related search for the target query. Validate intent before targeting.",
                "source": "SerpApi"
            })

    for q in people_also_ask[:8]:
        if isinstance(q, dict):
            question = q.get("question") or q.get("title") or q.get("snippet")
        elif isinstance(q, str):
            question = q
        else:
            question = None

        if question:
            opp.append({
                "title": question,
                "detail": "Live Google People Also Ask question. Consider an answer section if relevant.",
                "source": "SerpApi"
            })

    # Build competitors safely
    competitors = []

    for r in results:
        link = r.get("link")

        if not link:
            continue

        if domain_match(link, p.get("url", url)):
            continue

        competitors.append({
            "position": r.get("position"),
            "link": link,
            "title": r.get("title") or "",
            "snippet": r.get("snippet") or "",
            "whyRanking": (
                f"Observed at position #{r.get('position')} "
                f"in the live Google snapshot."
            )
        })

        if len(competitors) >= 8:
            break

    # Build tasks
    current_h1 = p["h1"][0] if p["h1"] else "missing"

    tasks = [
        {
            "id": "title-intent",
            "title": "Align the title with the exact search intent",
            "category": "On-page",
            "description": (
                f"Current title: {p['title'] or 'missing'}. "
                "Use the target keyword naturally and make the value proposition clear."
            ),
            "completed": False
        },
        {
            "id": "h1-intent",
            "title": "Strengthen the primary H1",
            "category": "Content",
            "description": (
                f"Current H1: {current_h1}. "
                "Make the primary topic unmistakable."
            ),
            "completed": False
        },
        {
            "id": "serp-coverage",
            "title": "Cover live SERP questions and related searches",
            "category": "Content",
            "description": (
                f"The snapshot returned {len(related_searches)} related searches "
                f"and {len(people_also_ask)} People Also Ask questions."
            ),
            "completed": False
        },
        {
            "id": "internal-links",
            "title": "Add contextual internal links",
            "category": "Internal linking",
            "description": (
                f"The target page currently exposes "
                f"{p['internal_links']} unique internal URLs."
            ),
            "completed": False
        },
        {
            "id": "technical",
            "title": "Resolve technical audit warnings",
            "category": "Technical",
            "description": (
                "Run the Technical SEO section and resolve failed/warning "
                "checks before the final ranking push."
            ),
            "completed": False
        }
    ]

    # Safely calculate actions
    try:
        page_actions = action_engine(p) or []
    except Exception:
        page_actions = []

    critical_count = len([
        a for a in page_actions
        if isinstance(a, dict) and a.get("priority") == "critical"
    ])

    exact_position = exact.get("position") if exact else None
    domain_position = domain.get("position") if domain else None

    rating_score = (
        70
        + (10 if exact and exact_position is not None and exact_position <= 3
           else 5 if exact else 0)
        - min(25, critical_count * 10)
    )

    checked_at = search_metadata.get("checked_at") or ""

    country_label = (
        country.get("label")
        if isinstance(country, dict)
        else str(country)
    )

    return {
        "success": True,
        "source": "Live Google SERP via SerpApi + Python SEO Engine",
        "url": p.get("url", url),
        "keyword": seed,
        "country": country,

        "volume": {
            "level": "Not verified",
            "range": "",
            "reasoning": (
                "No numeric search volume is claimed without a verified "
                "volume provider."
            )
        },

        "difficulty": {
            "level": "SERP evidence only",
            "reasoning": (
                f"The live snapshot contains {len(results)} organic results; "
                "this is not a proprietary keyword-difficulty score."
            )
        },

        "currentPosition": exact_position,
        "domainPosition": domain_position,
        "scannedResults": len(results),

        "rankEvidence": {
            "matchType": (
                "exact-target-page"
                if exact
                else "domain-only-not-target-page"
                if domain
                else "not-found"
            ),
            "matchedUrl": (
                exact.get("link")
                if exact
                else domain.get("link")
                if domain
                else ""
            ),
            "position": (
                exact_position
                if exact
                else domain_position
                if domain
                else None
            ),
            "scannedResults": len(results),
            "checkedAt": checked_at
        },

        "searchMetadata": search_metadata,

        "research": {
            "searchMetadata": search_metadata,
            "provider": "SerpApi",
            "engine": "Google"
        },

        "topSerpResults": results[:20],
        "relatedSearches": related_searches,
        "peopleAlsoAsk": people_also_ask,
        "opportunities": opp[:20],
        "competitors": competitors,
        "tasks": tasks,

        "rating": {
            "score": max(0, min(100, rating_score)),
            "label": "Live SERP readiness assessment"
        },

        "warnings": [
            "Ranking is a live snapshot and can change by location, device and time.",
            "Search volume and backlink authority are not fabricated."
        ],

        "summary": (
            f"Live {country_label} Google snapshot for '{seed}'. "
            f"Exact target-page rank: "
            f"#{exact_position if exact_position is not None else 'not found'} "
            f"in {len(results)} scanned organic results."
        )
    }

@app.post("/keyword-verify")
def keyword_verify(body: dict):
    url=clean_text(body.get("url")); keyword=clean_text(body.get("keyword")); cc=body.get("country","us"); max_pages=min(max(int(body.get("maxPages",20)),1),50)
    p,snap,exact,domain=rank_payload(url,keyword,cc,100)
    actions=action_engine(p); verification=[]
    for task in body.get("tasks") or []:
        tid=task.get("id"); title=clean_text(task.get("title")); status="partial"; note="No matching automatic verification rule was available."
        low=title.lower()
        if "title" in low: status="verified" if p["title"] else "not_verified"; note=f"Title observed: {p['title'] or 'missing'}."
        elif "h1" in low: status="verified" if p["h1"] else "not_verified"; note=f"H1 count: {p['h1_count']}."
        elif "internal" in low: status="verified" if p["internal_links"] else "not_verified"; note=f"Internal links observed: {p['internal_links']}."
        elif "technical" in low: status="verified" if not any(a["priority"]=="critical" for a in actions) else "partial"; note=f"Critical action count: {sum(a['priority']=='critical' for a in actions)}."
        verification.append({"id":tid,"status":status,"note":note})
    return {"success":True,"source":"Python SEO Engine + live SerpApi verification","verification":verification,"liveRank":exact["position"] if exact else None,"domainRank":domain["position"] if domain else None,"rankScanDepth":len(snap["results"]),"rankEvidence":{"matchType":"exact-target-page" if exact else "domain-only-not-target-page" if domain else "not-found","matchedUrl":exact["link"] if exact else domain["link"] if domain else "","position":exact["position"] if exact else domain["position"] if domain else None,"scannedResults":len(snap["results"]),"checkedAt":snap["search_metadata"]["checked_at"]},"rating":{"score":max(0,100-len([a for a in actions if a["priority"]=="critical"])*15-len([a for a in actions if a["priority"]=="warning"])*5),"label":"Post-crawl verification"},"warnings":[f"Verified target-page rank from {len(snap['results'])} live Google results in {snap['country']['label']}.",f"The requested crawl cap was {max_pages} pages; ranking verification itself uses the live SERP snapshot."],"summary":f"Verification completed for '{keyword}' using the target page plus live Google SERP evidence."}


@app.post("/content-plan")
def content_plan(body: dict):
    url=clean_text(body.get("url")); keyword=clean_text(body.get("keyword") or body.get("topic")); cc=body.get("country","us")
    p=extract_page(url, force_refresh=True); keyword=keyword or p["title"] or (p["h1"][0] if p["h1"] else "the topic"); snap=serp_snapshot(keyword,cc,20)
    supporting=[]; blog=[]
    for i,q in enumerate(snap["related_searches"][:6],1): supporting.append({"id":f"page-{i}","title":q,"type":"Supporting page","reason":"Live Google related search.","keyword":q})
    for i,q in enumerate(snap["people_also_ask"][:8],1): blog.append({"id":f"blog-{i}","title":q["question"],"type":"Blog / FAQ topic","reason":"Live Google People Also Ask question.","keyword":q["question"]})
    if not supporting: supporting.append({"id":"page-1","title":f"Complete Guide to {keyword}","type":"Supporting page","reason":"Seed topic expansion based on the target keyword.","keyword":keyword})
    if not blog: blog.append({"id":"blog-1","title":f"Frequently Asked Questions About {keyword}","type":"Blog / FAQ topic","reason":"Intent coverage expansion.","keyword":keyword})
    return {"success":True,"source":"Live Google SERP via SerpApi","url":p["url"],"keyword":keyword,"country":snap["country"],"supportingPages":supporting,"blogTopics":blog,"searchMetadata":snap["search_metadata"],"relatedSearches":snap["related_searches"],"peopleAlsoAsk":snap["people_also_ask"]}


@app.post("/ai-recommendations")
def ai_recommendations(body: dict):
    url=clean_text(body.get("url")); p=extract_page(url, force_refresh=True); actions=action_engine(p); gaps=content_gaps(p,p["title"] or (p["h1"][0] if p["h1"] else "the topic"))
    priorities=[{"priority":a["priority"],"category":a["category"],"task":a["title"],"why":a["description"],"implementation":a["recommended_fix"]} for a in actions[:10]]
    for g in gaps[:3]: priorities.append({"priority":g["priority"],"category":"Content gap","task":g["gap_title"],"why":g["why_it_matters"],"implementation":g["fill_content"]})
    return {"success":True,"recommendations":{"summary":f"Python verified the current page structure and produced {len(actions)} technical/on-page actions plus {len(gaps)} content-gap opportunities.","priorities":priorities[:12],"quick_wins":[a["recommended_fix"] for a in actions if a["priority"]=="warning"][:5],"evidence":{"url":p["url"],"title":p["title"],"h1":p["h1"],"wordCount":p["word_count"]}},"source":"Python evidence-first recommendation engine"}


@app.post("/trends")
def trends(body: dict):
    keyword=clean_text(body.get("keyword")); cc=body.get("country","us")
    if not keyword: raise HTTPException(400,"Please provide a keyword.")
    snap=serp_snapshot(keyword,cc,10)
    return {"success":True,"keyword":keyword,"country":snap["country"],"trendData":None,"relatedSearches":snap["related_searches"],"peopleAlsoAsk":snap["people_also_ask"],"source":"Live Google SERP context via SerpApi","note":"This endpoint does not fabricate a numeric Google Trends time series. Use the live SERP demand context or connect a verified Trends data source."}


# ===================== PHASE 1-5 AGENT SERVICES =====================
def readable_status(status):
    return {"pass":"Looks good","warning":"Needs attention","fail":"Needs fixing"}.get(status,status.title())

def make_user_facing_action(item):
    title=clean_text(item.get("title") or item.get("name") or "SEO improvement")
    fix=clean_text(item.get("recommended_fix") or item.get("description") or "Review this item and make the recommended improvement.")
    priority=clean_text(item.get("priority") or "medium").lower()
    return {"priority":priority,"title":title,"what_to_do":fix,"why_it_matters":clean_text(item.get("why") or item.get("description") or "Improving this signal can make the site easier to crawl, understand, or use.")}

@app.post("/agent-dashboard")
def agent_dashboard(b: DashboardRequest):
    p=extract_page(b.url, force_refresh=True); t=technical_data(p); checks=build_section_checks(p,t,"all")
    counts={"passed":sum(x["status"]=="pass" for x in checks),"warnings":sum(x["status"]=="warning" for x in checks),"critical":sum(x["status"]=="fail" for x in checks)}
    score=verified_score(checks)
    actions=[make_user_facing_action(x) for x in checks if x["status"]!="pass"]
    category_summary={}
    for x in checks:
        cat=x.get("category") or "Other"; bucket=category_summary.setdefault(cat,{"checks":0,"passed":0,"warnings":0,"critical":0})
        bucket["checks"]+=1; bucket["passed"]+=x["status"]=="pass"; bucket["warnings"]+=x["status"]=="warning"; bucket["critical"]+=x["status"]=="fail"
    priority_stats={"critical":sum(a["priority"]=="critical" for a in actions),"high":sum(a["priority"]=="high" for a in actions),"medium":sum(a["priority"]=="medium" for a in actions),"low":sum(a["priority"]=="low" for a in actions)}
    deep_metrics={"statusCode":p["status_code"],"responseTimeMs":p.get("response_time_ms"),"contentType":p.get("content_type"),"titleLength":p["title_length"],"metaDescriptionLength":p["meta_description_length"],"h1Count":p["h1_count"],"h2Count":p["h2_count"],"h3Count":p["h3_count"],"words":p["word_count"],"internalLinks":p["internal_links"],"externalLinks":p["external_links"],"images":p["image_count"],"missingAlt":p["images_without_alt"],"schemaBlocks":p["schema_blocks"],"redirects":p["redirect_count"],"canonical":p["canonical"],"robots":p["robots"],"xRobotsTag":p["x_robots_tag"],"viewport":p["viewport"],"language":p["lang"]}
    score_breakdown=[{"name":x["name"],"category":x.get("category"),"status":x["status"],"weight":check_weight(x)} for x in checks]
    return {"success":True,"source":"Python FastAPI SEO Engine","url":p["url"],"score":score,"counts":counts,"metrics":{"words":p["word_count"],"internal_links":p["internal_links"],"images":p["image_count"],"missing_alt":p["images_without_alt"],"schema":p["schema_blocks"],"redirects":p["redirect_count"]},"deepMetrics":deep_metrics,"categorySummary":category_summary,"priorityStats":priority_stats,"actions":actions[:40],"scoreMethod":"Weighted verified checks: pass=100% of check weight, warning=35%, fail=0%; informational checks do not affect score.","scoreBreakdown":score_breakdown,"message":f"Your site scored {score}/100 from {len(checks)} verified checks. Start with the {len(actions)} items marked for attention.","interpretation":{"what_the_score_means":"The score is a descriptive summary of the verified checks; it is not a Google ranking prediction.","execution_order":["Fix critical issues","Resolve warnings","Improve page intent and content depth","Strengthen internal links and structured data where relevant","Re-run the checks to verify improvement"]},"checks":checks}

@app.post("/agent-action-center")
def agent_action_center(b: ActionCenterRequest):
    p=extract_page(b.url, force_refresh=True); t=technical_data(p); checks=build_section_checks(p,t,"all")
    actions=[make_user_facing_action(x) for x in checks if x["status"]!="pass"]
    rank={"critical":0,"high":1,"medium":2,"low":3}
    for a in actions:
        if a["priority"] not in rank: a["priority"]="medium"
    actions.sort(key=lambda x:rank[x["priority"]])
    priority_stats={k:sum(a["priority"]==k for a in actions) for k in rank}
    category_stats={}
    for a in actions:
        category_stats.setdefault(a.get("category") or "Other",0); category_stats[a.get("category") or "Other"]+=1
    return {"success":True,"url":p["url"],"total":len(actions),"priorityStats":priority_stats,"categoryStats":category_stats,"actions":actions,"summary":f"There are {len(actions)} improvements to work through. Fix critical problems first, then high-impact warnings.","methodology":"Actions are derived from the current crawl and are not guarantees of ranking improvement.","recommendedWorkflow":["Resolve critical blockers","Complete high-impact fixes","Review medium and low-priority enhancements","Re-run the audit and verify the changed signals"]}

@app.post("/agent-keyword-gap")
def agent_keyword_gap(b: KeywordGapRequest):
    target=normalize_page_url(b.url); keywords=[clean_text(x) for x in b.keywords if clean_text(x)][:40]; comps=[clean_text(x) for x in b.competitors if clean_text(x)][:5]
    if not keywords: raise HTTPException(400,"Add at least one keyword to compare.")
    if not comps: raise HTTPException(400,"Add at least one competitor URL.")
    rows=[]
    for kw in keywords:
        snap=serp_snapshot(kw,b.country,100)
        def pos(domain):
            for r in snap["results"]:
                if domain_match(r.get("link",""),domain): return r.get("position")
            return None
        tp=pos(target); cp=[pos(c) for c in comps]
        best=min([x for x in cp if isinstance(x,int)],default=None)
        if best is not None and (tp is None or best<tp):
            rows.append({"keyword":kw,"your_position":tp,"competitor_best_position":best,"competitor_positions":cp,"opportunity":"High" if tp is None or best<=10 else "Medium","explanation":"A competitor is visible ahead of your site for this keyword. Create or improve the most relevant page and strengthen internal links."})
    rows.sort(key=lambda x:(x["competitor_best_position"], 999 if x["your_position"] is None else x["your_position"]))
    return {"success":True,"country":country(b.country),"keywords_checked":len(keywords),"opportunities":rows,"summary":f"Found {len(rows)} keyword opportunities where a competitor currently has stronger visibility."}

@app.post("/agent-content-decay")
def agent_content_decay(b: ContentDecayRequest):
    results=[]
    for x in b.pages[:200]:
        try:
            current=float(x.get("current_clicks",x.get("currentClicks",0)) or 0); previous=float(x.get("previous_clicks",x.get("previousClicks",0)) or 0); curpos=float(x.get("current_position",x.get("currentPosition",0)) or 0); prevpos=float(x.get("previous_position",x.get("previousPosition",0)) or 0)
        except: continue
        change=None if previous==0 else round((current-previous)/previous*100,1)
        pos_change=None if not prevpos or not curpos else round(curpos-prevpos,1)
        if (change is not None and change<=-20) or (pos_change is not None and pos_change>=3):
            results.append({"url":x.get("url",""),"title":x.get("title",x.get("url","")),"click_change_pct":change,"position_change":pos_change,"severity":"High" if (change is not None and change<=-40) else "Medium","recommendation":"Refresh this page: verify the search intent, update outdated sections, improve the title/description, add missing internal links, and compare the current top results before republishing."})
    return {"success":True,"pages_checked":len(b.pages),"decaying_pages":results,"summary":f"Detected {len(results)} pages with meaningful traffic or ranking decline."}

@app.post("/agent-rank-history")
def agent_rank_history(b: RankHistoryRequest):
    snaps=b.snapshots[-200:]
    grouped={}
    for s in snaps:
        for r in s.get("keywords",[]):
            grouped.setdefault(r.get("keyword",""),[]).append({"date":s.get("date",now_iso()),"position":r.get("position"),"country":s.get("country","")})
    series=[]
    for kw,points in grouped.items():
        valid=[p for p in points if isinstance(p.get("position"),(int,float))]
        change=None
        if len(valid)>=2: change=valid[-2]["position"]-valid[-1]["position"]
        series.append({"keyword":kw,"points":points,"change":change,"message":"Improving" if isinstance(change,(int,float)) and change>0 else "Declining" if isinstance(change,(int,float)) and change<0 else "Stable / not enough history"})
    return {"success":True,"series":series}

@app.post("/agent-report-pdf")
def agent_report_pdf(b: ReportRequest):
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.enums import TA_CENTER
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.pdfbase import pdfmetrics
        from io import BytesIO
        data=b.report or {}; buf=BytesIO(); doc=SimpleDocTemplate(buf,pagesize=A4,rightMargin=36,leftMargin=36,topMargin=40,bottomMargin=40)
        styles=getSampleStyleSheet(); styles.add(ParagraphStyle(name="Hero",parent=styles["Title"],alignment=TA_CENTER,fontSize=24,spaceAfter=14)); styles.add(ParagraphStyle(name="Small",parent=styles["BodyText"],fontSize=8,leading=10));
        story=[Paragraph("SEO Agent — SEO Performance Report",styles["Hero"]),Paragraph(f"Website: {clean_text(data.get('url','Not specified'))}",styles["BodyText"]),Paragraph(f"Generated: {datetime.now().strftime('%d %B %Y, %H:%M UTC')}",styles["Small"]),Spacer(1,18)]
        score=data.get("score",data.get("dashboard",{}).get("score","—")); story.append(Paragraph(f"Overall SEO score: <b>{score}/100</b>",styles["Heading2"]))
        counts=data.get("counts",data.get("dashboard",{}).get("counts",{})); story.append(Paragraph(f"Status: {counts.get('critical',0)} critical · {counts.get('warnings',0)} warnings · {counts.get('passed',0)} passed",styles["BodyText"])); story.append(Spacer(1,12))
        story.append(Paragraph("How the agent works",styles["Heading2"])); flow=Table([["Crawl website","→","Verify signals","→","Prioritize fixes","→","Measure again"]],colWidths=[90,22,90,22,90,22,90]); flow.setStyle(TableStyle([("BOX",(0,0),(-1,-1),0.7,colors.HexColor('#8aa0b6')),("INNERGRID",(0,0),(-1,-1),0.4,colors.HexColor('#cbd5e1')),("ALIGN",(0,0),(-1,-1),'CENTER'),("VALIGN",(0,0),(-1,-1),'MIDDLE'),("FONTSIZE",(0,0),(-1,-1),8)])); story.append(flow); story.append(Spacer(1,18))
        metrics=data.get("metrics",data.get("dashboard",{}).get("metrics",{})); metric_rows=[["Metric","Observed value"],["Visible words",str(metrics.get("words","—"))],["Internal links",str(metrics.get("internal_links","—"))],["Images",str(metrics.get("images","—"))],["Images missing alt",str(metrics.get("missing_alt","—"))],["Schema blocks",str(metrics.get("schema","—"))],["Redirects",str(metrics.get("redirects","—"))]]; tbl=Table(metric_rows,colWidths=[220,220]); tbl.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),colors.HexColor('#e8eef5')),("GRID",(0,0),(-1,-1),0.4,colors.HexColor('#b7c3d0')),("FONTNAME",(0,0),(-1,0),'Helvetica-Bold'),("FONTSIZE",(0,0),(-1,-1),9),("VALIGN",(0,0),(-1,-1),'TOP')])); story.append(Paragraph("Verified website metrics",styles["Heading2"])); story.append(tbl); story.append(Spacer(1,16))
        from reportlab.graphics.shapes import Drawing, Rect, String, Line
        graph=Drawing(440,150); vals=[int(metrics.get("words",0) or 0),int(metrics.get("internal_links",0) or 0),int(metrics.get("images",0) or 0),int(metrics.get("schema",0) or 0)]; labels=["Words","Internal links","Images","Schema"]; scale=max(vals+[1]); base=25
        for i,(label,val) in enumerate(zip(labels,vals)):
            x=35+i*100; h=95*(val/scale); graph.add(Rect(x,base,48,h,strokeWidth=0.5)); graph.add(String(x,10,label,fontSize=8)); graph.add(String(x,base+h+4,str(val),fontSize=8))
        graph.add(Line(25,base,425,base)); story.append(Paragraph("Verified metrics at a glance",styles["Heading2"])); story.append(graph); story.append(Spacer(1,12))
        actions=data.get("actions",data.get("dashboard",{}).get("actions",[])); story.append(Paragraph("Recommended actions — written in plain language",styles["Heading2"]));
        for i,a in enumerate(actions[:15],1): story.append(Paragraph(f"<b>{i}. {clean_text(a.get('title','SEO improvement'))}</b> ({clean_text(a.get('priority','medium')).upper()})",styles["BodyText"])); story.append(Paragraph(f"What to do: {clean_text(a.get('what_to_do',a.get('recommended_fix','Review this issue.')))}",styles["Small"])); story.append(Paragraph(f"Why it matters: {clean_text(a.get('why_it_matters','This can improve crawlability, relevance, usability, or search visibility.'))}",styles["Small"])); story.append(Spacer(1,7))
        story.append(PageBreak()); story.append(Paragraph("SEO improvement flowchart",styles["Heading2"])); flow2=Table([["1. Find","→","2. Understand","→","3. Fix","→","4. Verify","→","5. Track"]],colWidths=[65,18,80,18,55,18,65,18,55]); flow2.setStyle(TableStyle([("BOX",(0,0),(-1,-1),0.7,colors.HexColor('#8aa0b6')),("INNERGRID",(0,0),(-1,-1),0.4,colors.HexColor('#cbd5e1')),("ALIGN",(0,0),(-1,-1),'CENTER'),("FONTSIZE",(0,0),(-1,-1),8)])); story.append(flow2); story.append(Spacer(1,14)); story.append(Paragraph("This report only describes data supplied to the report generator. Ranking, traffic, backlink, and Search Console claims are not invented when the corresponding data was not provided.",styles["Small"])); doc.build(story); pdf=buf.getvalue(); return Response(content=pdf,media_type="application/pdf",headers={"Content-Disposition":"attachment; filename=seo-agent-report.pdf"})
    except Exception as e:
        raise HTTPException(500,f"PDF generation failed: {e}")

# ===================== SEO GROWTH OS / PHASE 6 =====================

def _intent_for_keyword(keyword):
    k=clean_text(keyword).lower()
    if any(x in k for x in ["buy","price","pricing","cost","quote","hire","service"]): return "commercial"
    if any(x in k for x in ["how","what","why","guide","tutorial","tips"]): return "informational"
    if any(x in k for x in ["near me","nearby","in "]): return "local"
    return "mixed"

def _keyword_map_from_page(page, keywords):
    title=clean_text(page.get("title","")); h1s=page.get("h1",[]) or []; text=clean_text(page.get("text",""))[:12000].lower()
    out=[]
    for kw in keywords[:100]:
        k=clean_text(kw); kl=k.lower()
        score=0
        if kl in title.lower(): score+=45
        if any(kl in clean_text(h).lower() for h in h1s): score+=35
        if kl in text: score+=20
        out.append({"keyword":k,"intent":_intent_for_keyword(k),"fit_score":min(score,100),"recommended_action":"Keep and optimize" if score>=60 else "Create/assign a more relevant page"})
    return out

def _deep_technical(page, technical):
    checks=[]
    def add(name,ok,priority,detail): checks.append({"name":name,"status":"pass" if ok else "fail" if priority in ("critical","high") else "warning","priority":priority,"detail":detail})
    add("HTTPS", str(page.get("url","")).startswith("https://"), "high", "Serve the canonical site over HTTPS.")
    add("Canonical", bool(page.get("canonical")), "high", "A canonical URL helps search engines consolidate duplicate URL signals.")
    add("Robots directives", ("noindex" not in clean_text(page.get("robots","")).lower() and "noindex" not in clean_text(page.get("x_robots_tag","")).lower()), "critical", "Avoid accidental noindex on pages intended to rank.")
    add("Sitemap discovery", False, "medium", "Sitemap discovery is not verified by this single-page fetch; confirm robots.txt references an XML sitemap or expose /sitemap.xml.")
    add("H1 structure", len(page.get("h1s",[]))==1, "medium", "Use one clear primary H1 that matches the page intent.")
    add("Image accessibility", int(page.get("images_without_alt",0))==0, "low", "Add meaningful alt text to informative images.")
    add("Structured data", int(page.get("schema_blocks",0))>0, "medium", "Add valid schema that matches the visible page content.")
    add("Redirects", int(page.get("redirect_count",0))<=1, "high", "Avoid long redirect chains; link directly to the final URL.")
    return checks

def _content_optimizer(page, keyword=""):
    k=clean_text(keyword)
    title=clean_text(page.get("title","")); words=int(page.get("word_count",0) or 0); h2s=page.get("h2",[]) or []
    score=0; issues=[]
    if k and k.lower() in title.lower(): score+=25
    else: issues.append({"priority":"high","title":"Strengthen the title for the target query","action":f"Include the primary concept '{k}' naturally in the title without keyword stuffing."})
    if len(title) and 30<=len(title)<=65: score+=20
    else: issues.append({"priority":"medium","title":"Improve title length","action":"Aim for a concise, descriptive title that communicates the page value."})
    if len(page.get("h1s",[]))==1: score+=20
    else: issues.append({"priority":"medium","title":"Clarify the H1","action":"Use one descriptive H1 aligned with search intent."})
    if words>=700: score+=20
    else: issues.append({"priority":"medium","title":"Expand topical coverage","action":"Add useful sections that answer the complete search intent; do not add filler."})
    if len(h2s)>=4: score+=15
    else: issues.append({"priority":"low","title":"Improve information architecture","action":"Use descriptive H2s to make the page easier to scan and expand topical coverage."})
    return {"score":score,"projected_score":min(100,score+len(issues)*8),"target_keyword":k,"issues":issues,"recommended_outline":[{"heading":"Direct answer / value proposition","purpose":"Satisfy the primary intent immediately."},{"heading":"Core topic sections","purpose":"Cover the major subtopics users need."},{"heading":"FAQ","purpose":"Address common objections and long-tail questions."}],"quality_checklist":["Search intent is satisfied","Primary topic is naturally represented","Internal links point to relevant supporting pages","Schema matches visible content","Claims are accurate and current"]}

def _seo_intelligence(page, keyword=""):
    title=clean_text(page.get("title","")); desc=clean_text(page.get("meta_description","")); h1s=page.get("h1s",[]) or []; h2s=page.get("h2",[]) or []
    words=int(page.get("word_count",0) or 0); internal=int(page.get("internal_links",0) or 0); schema=int(page.get("schema_blocks",0) or 0)
    missing_alt=int(page.get("images_without_alt",0) or 0); status=int(page.get("status_code",0) or 0); noindex=bool(page.get("noindex",False)); canonical=clean_text(page.get("canonical",""))
    k=clean_text(keyword); low=(title+' '+desc+' '+' '.join(h1s)+' '+' '.join(h2s)).lower(); kl=k.lower()
    intent="informational"; role="Topic / resource page"
    if any(x in low for x in ["buy","price","pricing","order","book","quote"]): intent="transactional"; role="Conversion page"
    elif any(x in low for x in ["service","tutoring","consulting","agency","hire"]): intent="commercial investigation"; role="Service / solution page"
    elif any(x in low for x in ["login","sign up","account"]): intent="navigational"; role="Destination page"
    intent_fit=82 if not k else (96 if kl in low else 62)
    indexability=100
    if status<200 or status>=400: indexability-=45
    if noindex: indexability-=60
    if not canonical: indexability-=8
    if page.get("redirect_count",0)>1: indexability-=12
    snippet=55
    if 30<=len(title)<=65: snippet+=18
    if 120<=len(desc)<=170: snippet+=17
    if len(h1s)==1: snippet+=10
    trust=35
    if schema: trust+=15
    if len(h2s)>=4: trust+=15
    if words>=1000: trust+=15
    if internal>=8: trust+=10
    differentiation=48
    if words>=1200: differentiation+=12
    if len(h2s)>=6: differentiation+=10
    if schema: differentiation+=8
    if k and kl in low: differentiation+=10
    link_leverage=min(100,35+internal*5)
    opportunities=[]
    if not k or kl not in low: opportunities.append({"title":"Intent-to-page alignment","action":"Align the title, H1 and opening section around the primary query without repeating the keyword unnaturally."})
    if len(h1s)!=1: opportunities.append({"title":"Heading hierarchy","action":"Create one clear H1 and use H2s to map the user's decision journey."})
    if not schema: opportunities.append({"title":"Entity / schema layer","action":"Add only schema types supported by the visible page and validate the markup."})
    if internal<5: opportunities.append({"title":"Contextual authority transfer","action":"Add relevant internal links from stronger pages into this URL using descriptive anchors."})
    if words<800: opportunities.append({"title":"Depth without filler","action":"Expand missing intent coverage rather than adding generic word count."})
    if missing_alt: opportunities.append({"title":"Image accessibility","action":f"Resolve {missing_alt} image(s) with meaningful alt text where the image conveys information."})
    if noindex: opportunities.append({"title":"Indexability gate","action":"Review the noindex directive before expecting organic visibility."})
    angle="Win through clearer intent coverage and stronger evidence rather than simply adding more words."
    if role=="Service / solution page": angle="Differentiate with proof, process, outcomes, trust signals and a clear path to conversion."
    elif role=="Topic / resource page": angle="Own the topic by answering the core question quickly, then covering the important sub-intents with original evidence."
    next_moves=[x["action"] for x in opportunities[:5]]
    return {"intent_fit":max(0,min(100,int(intent_fit))),"indexability_confidence":max(0,min(100,int(indexability))),"snippet_readiness":max(0,min(100,int(snippet))),"trust_depth":max(0,min(100,int(trust))),"content_differentiation":max(0,min(100,int(differentiation))),"internal_link_leverage":max(0,min(100,int(link_leverage))),"primary_intent":intent,"page_role":role,"competitive_angle":angle,"recommended_strategy":"Prioritize the highest-leverage evidence-backed improvements first, then re-crawl to measure change.","why_it_matters":"This fingerprint separates technical eligibility from search-intent fit and content differentiation, so the agent can recommend a different action for a page that is indexable but strategically weak versus a page that is strong but technically blocked.","unique_opportunities":opportunities,"next_moves":next_moves or ["Re-crawl after the next meaningful page change","Validate indexing in Search Console","Track the target query over time"]}

def _change_detection(previous,current):
    fields=[("title","Title"),("canonical","Canonical"),("description","Meta description"),("h1s","H1"),("word_count","Word count"),("internal_links","Internal links"),("schema_blocks","Structured data"),("noindex","Indexing directive")]
    changes=[]
    for key,label in fields:
        a=previous.get(key); b=current.get(key)
        if a!=b:
            impact="high" if key in ("canonical","noindex") else "medium" if key in ("title","h1s","word_count") else "low"
            changes.append({"field":label,"before":a,"after":b,"impact":impact})
    return changes

@app.post("/seo-intelligence")
def seo_intelligence(body: dict):
    url=clean_text(body.get("url")); keyword=clean_text(body.get("keyword"))
    if not url: raise HTTPException(400,"Please provide a page URL.")
    page=extract_page(url, force_refresh=True)
    return {"success":True,"url":page["url"],"captured_at":now_iso(),"intelligence":_seo_intelligence(page,keyword),"evidence":{"status_code":page.get("status_code"),"title":page.get("title"),"meta_description":page.get("meta_description"),"h1":page.get("h1s"),"h2":page.get("h2"),"word_count":page.get("word_count"),"internal_links":page.get("internal_links"),"schema_blocks":page.get("schema_blocks"),"images_without_alt":page.get("images_without_alt"),"canonical":page.get("canonical"),"noindex":page.get("noindex")}}

@app.post("/agent-growth-os")
def agent_growth_os(body: dict):
    url=clean_text(body.get("url")); keyword=clean_text(body.get("keyword")); keywords=[clean_text(x) for x in body.get("keywords",[]) if clean_text(x)]
    if not url: raise HTTPException(400,"Please provide a website URL.")
    page=extract_page(url, force_refresh=True); tech=technical_data(page)
    if keyword and keyword not in keywords: keywords.insert(0,keyword)
    checks=_deep_technical(page,tech); optimizer=_content_optimizer(page,keyword); km=_keyword_map_from_page(page,keywords)
    # Deep site footprint: crawl a bounded set of same-domain pages concurrently so
    # Growth OS can reason about architecture, internal links, thin pages and orphans.
    max_pages=max(3,min(int(body.get("max_pages",8) or 8),20))
    root_host=urlparse(page["url"]).netloc.lower(); q=deque([page["url"]]); seen=set(); crawled=[]
    def crawl_one(u):
        try:
            p=extract_page(u); a=action_summary(action_engine(p)); return p,a
        except Exception: return None,None
    with ThreadPoolExecutor(max_workers=8) as pool:
        while q and len(crawled)<max_pages:
            batch=[]
            while q and len(batch)<8 and len(crawled)+len(batch)<max_pages:
                u,_=urldefrag(q.popleft()); u=normalize_page_url(u)
                if u in seen or urlparse(u).netloc.lower().removeprefix("www.")!=root_host: continue
                seen.add(u); batch.append(u)
            futures=[pool.submit(crawl_one,u) for u in batch]
            for fut in as_completed(futures):
                p,a=fut.result()
                if p:
                    crawled.append(p)
                    for link in p.get("links",[]):
                        href=link.get("href") if isinstance(link,dict) else ""
                        if href and domain_match(href,page["url"]) and href not in seen and len(q)<max_pages*3: q.append(href)
    inbound={}
    for p in crawled:
        for link in p.get("links",[]):
            href=link.get("href") if isinstance(link,dict) else ""
            if href and domain_match(href,page["url"]): inbound[normalize_page_url(href)]=inbound.get(normalize_page_url(href),0)+1
    site_pages=[{"url":p["url"],"title":p["title"],"words":p["word_count"],"h1":p["h1_count"],"h2":p["h2_count"],"internalLinks":p["internal_links"],"schema":p["schema_blocks"],"missingAlt":p["images_without_alt"],"status":p["status_code"]} for p in crawled]
    thin_pages=[x for x in site_pages if x["words"]<500]
    orphan_candidates=[x for x in site_pages if normalize_page_url(x["url"])!=normalize_page_url(page["url"]) and inbound.get(normalize_page_url(x["url"]),0)==0]
    link_opportunities=[]
    if keyword:
        kl=keyword.lower()
        for p in crawled:
            for link in p.get("links",[]):
                anchor=clean_text(link.get("anchor","")) if isinstance(link,dict) else ""
                if anchor and kl in anchor.lower(): link_opportunities.append({"sourceUrl":p["url"],"anchor":anchor,"target":link.get("href"),"reason":"Existing same-domain anchor contains the target concept."})
    actions=[]
    for c in checks:
        if c["status"]!="pass": actions.append({"title":c["name"],"priority":c["priority"],"description":c["detail"],"source":"deep-technical"})
    for i in optimizer["issues"]: actions.append({"title":i["title"],"priority":i["priority"],"description":i["action"],"source":"content-optimizer"})
    if thin_pages: actions.append({"title":f"Review {len(thin_pages)} thin page(s)","priority":"medium","description":"Pages below roughly 500 visible words should be reviewed for intent coverage and usefulness; expand only where the user intent requires it.","source":"deep-crawl"})
    if orphan_candidates: actions.append({"title":f"Strengthen {len(orphan_candidates)} possible orphan page(s)","priority":"high","description":"Add relevant contextual internal links from authoritative same-domain pages to pages with no observed inbound link in this crawl scope.","source":"deep-crawl"})
    actions.sort(key=lambda x:{"critical":0,"high":1,"medium":2,"low":3}.get(x["priority"],2))
    roadmap=[
      {"week":1,"goal":"Stabilize indexability and technical foundations","actions":[x["title"] for x in actions if x["priority"] in ("critical","high")][:10]},
      {"week":2,"goal":"Improve page intent and content quality","actions":[x["title"] for x in actions if x["priority"]=="medium"][:10]},
      {"week":3,"goal":"Build topical authority and internal-link architecture","actions":["Create missing supporting content where the crawl shows a real topical gap","Connect related service and informational pages with contextual anchors","Strengthen pages identified as orphan candidates"]},
      {"week":4,"goal":"Verify and iterate","actions":["Re-run the deep audit","Compare score and issue mix","Check Search Console indexing/ranking signals","Promote completed improvements into the next execution cycle"]}
    ]
    return {"success":True,"url":page["url"],"captured_at":now_iso(),"technical":checks,"content_optimizer":optimizer,"keyword_map":km,"site_footprint":{"pages_crawled":len(crawled),"max_pages":max_pages,"pages":site_pages,"thin_pages":thin_pages[:20],"orphan_candidates":orphan_candidates[:20],"internal_link_observations":link_opportunities[:30]},"opportunities":actions[:60],"roadmap":roadmap,"execution_note":"Recommendations are evidence-based and derived from the verified crawl. They are not ranking guarantees. Deeper crawl results are bounded by the selected page limit and public-page accessibility."}

@app.post("/agent-content-optimizer")
def agent_content_optimizer(body: dict):
    url=clean_text(body.get("url")); keyword=clean_text(body.get("keyword"))
    if not url: raise HTTPException(400,"Please provide a URL.")
    p=extract_page(url, force_refresh=True); return {"success":True,"url":p["url"],"optimizer":_content_optimizer(p,keyword),"evidence":{"title":p.get("title"),"h1s":p.get("h1"),"h2s":p.get("h2"),"word_count":p.get("word_count"),"internal_links":p.get("internal_links"),"schema_blocks":p.get("schema_blocks")}}

@app.post("/agent-keyword-map")
def agent_keyword_map(body: dict):
    url=clean_text(body.get("url")); keywords=[clean_text(x) for x in body.get("keywords",[]) if clean_text(x)]
    if not url or not keywords: raise HTTPException(400,"Provide a URL and at least one keyword.")
    p=extract_page(url, force_refresh=True); rows=_keyword_map_from_page(p,keywords)
    return {"success":True,"url":p["url"],"map":rows,"cannibalization_rule":"When multiple URLs have the same intent and compete for the same query, consolidate or assign one canonical target page.","next_steps":["Choose one primary URL per search intent","Consolidate overlapping pages where appropriate","Add internal links using natural anchor text","Track the target URL over time"]}

@app.post("/agent-change-detect")
def agent_change_detect(body: dict):
    previous=body.get("previous") or {}; current=body.get("current") or {}
    if not previous or not current: raise HTTPException(400,"Provide previous and current snapshot objects.")
    return {"success":True,"changes":_change_detection(previous,current),"summary":"No material changes detected." if not _change_detection(previous,current) else "Material SEO changes were detected; review high-impact changes first."}
