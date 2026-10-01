## 1.6.0 — Premium admin panel
- New: `public/admin-premium.css` + `admin-premium.js` — "Obsidian Aurora" redesign of /admin.html: split-hero login, glass sidebar with grouped icon navigation and collapsible rail, sticky glass topbar, gradient stat cards, rounded panels/tables, Light/Dark toggle, Ctrl+K command palette, count-up stats.
- Fix: unclosed `.section-head` div in the Overview markup (hero cards were nested inside the header row).
- No admin API or data logic changed.

## 1.5.0 — Contrast Layer + signature features
- Fix: unreadable text in dark/light mode (white rows with white text on My websites / Recent searches / Keyword results; faint sidebar + pills in light mode). New final stylesheet `public/zypp-contrast.css` makes every surface and its text read from one token set per theme.
- New: Contrast Guard (`public/zypp-contrast.js`) — WCAG check on rendered text, self-heals unreadable text in either theme, including dynamically rendered content.
- New: Theme Studio — Light / Dark / Auto (system), 6 accent palettes, compact density, calm motion.
- New: Mission Control on the dashboard — Next Best Action + SEO Quest (XP, level, streak, badges) computed from real workspace data.
- New: Keyword Opportunity score (transparent heuristic), Hot/Commercial filters, sort, CSV export.

## 1.4.0 — Premium Plus
- New **Pro Toolkit** hub (client-side, no API quota): SERP Snippet Lab (pixel-width title/description previews), Schema Lab (JSON-LD for Article, FAQ, LocalBusiness, Product, Organization), Content Lab (readability, keyword density, top terms) and Tech Files (robots.txt, sitemap.xml, 301 redirect rules with loop/chain checks).
- New **Advanced Suite** page: "Coming soon" experience with a six-item roadmap and a per-device wishlist. Roadmap/stage labels are plain text in `ROADMAP` inside `public/zypp-premium-plus.js`.
- Sidebar hubs now support `badge` labels (NEW / SOON). New sections appear automatically in the existing Ctrl+K palette.
- Added `test/premium_plus_static_test.js` (included in `npm test`).


## 2026-09-29 — Global auth bridge / feature execution fix
- Fixed `authHeaders is not defined` errors caused by feature scripts calling an auth helper that was scoped inside the login IIFE.
- Added a global, request-time authentication header bridge and shared authenticated fetch helper.
- Feature requests now receive the current Bearer token immediately after login/password recovery without a refresh.
- Preserved section-specific API functionality instead of routing requests through Dashboard.
# 1.2.2 — Direct Username Password Recovery

- Forgot password now opens the new-password form immediately.
- Recovery requires only username + new password + confirm password.
- No email, verification code, reset link, or existing session is used.
- Password changes are written immediately to `users.password_hash` using scrypt; plaintext passwords are never stored.
- All existing sessions for the account are revoked after a password change, then a fresh session is created.
- Public authentication UI is user-only; no admin login control is exposed.
- Username login remains supported.
- Quiz and personalized workspace hydration remain active after login/recovery.

## 1.2.1 — Direct Username Password Recovery

- Replaced email/code recovery with direct username → new password + confirm password recovery.
- Password reset requires no email, verification code, reset link, or existing session.
- Password changes update PostgreSQL immediately and revoke old sessions.
- Removed Admin login from the public user authentication UI; admin remains role-controlled separately.
- Added personalized user identity/plan/usage status to the workspace header.
- Added dashboard loading experience with live progress messaging.
- Added SEO Master Quiz with 20 randomized questions per login and a server-validated 20/20 reward of 30 days unlimited usage.
- Added persistent quiz attempts and secure reward entitlement through the existing billing plan system.


## 1.1.1 — Authentication & UX hardening
- Added PostgreSQL-backed one-time password recovery/reset flow.
- Removed email delivery requirements from the public password recovery flow.
- Rebuilt login/create-account/recovery UI with hover, loading, password visibility and strength states.
- Added authentication-screen light/dark mode and database health status.
- Removed global scroll traps and hardened vertical/horizontal viewport behavior.
- Added static regression coverage for authentication recovery.
# Changelog

## 1.1.0 — Optimization & hardening pass

### Security fixes (real vulnerabilities found in the audit)
- **Rate limits could be bypassed.** `getClientIP()` trusted the client-supplied `X-Forwarded-For` header, so sending a different fake value on each request defeated every limiter. It now uses Express's `req.ip` (resolved through the configured trusted proxy hops; `TRUST_PROXY` env).
- **Logout did not log you out.** Logout only stamped `ended_at`; token lookups ignored it, so a "logged-out" token stayed valid for up to 30 days. All session lookups now require `ended_at IS NULL`.
- **Python-backed routes had no rate limit at all** (`/api/crawl`, `/api/rank-track`, `/api/keyword-*`, `/api/content-plan`, …) — anyone could burn your SerpApi quota. Added a dedicated per-IP limiter (default 120 / 10 min, `ENGINE_RATE_LIMIT_MAX_REQUESTS`).
- **No brute-force protection on sign-in.** Added per-IP and per-IP+account failed-login lockout (15 min), a sign-up limiter, password length cap (scrypt DoS), and a constant-cost path for unknown users so timing does not reveal which accounts exist.
- **SSRF via redirects in the Python engine.** The public-URL check only covered the first request; a public page could 302 to `http://169.254.169.254/` or `localhost`. Redirects are now followed manually and every hop is re-validated. The IP check now uses `is_global` (also blocks CGNAT 100.64/10, IPv4-mapped IPv6, `.local/.internal` names, URLs with credentials).
- **Unbounded downloads.** Fetched pages are capped at 5 MB (`ENGINE_MAX_BODY_BYTES`).
- **Python engine was open to anyone** when deployed as its own service. Optional `ENGINE_SHARED_SECRET` (header `X-Engine-Secret`, constant-time compare); `/health` stays open.
- `/api/env-check` was public and exposed config details and server paths — now admin-only and trimmed.
- Removed an error handler that returned internal exception messages to clients; malformed JSON now returns a clean 400 (was 500), oversize bodies 413.
- Added CSP (`frame-ancestors`, `base-uri`, `object-src`, `form-action`), COOP, and HSTS (production).
- **Your `.env` (with live API keys) was inside the ZIP.** It is no longer shipped; `.gitignore`/`.dockerignore` added. Rotate any keys if that ZIP has been shared.

### Reliability
- Gemini/Groq calls now have timeouts (`AI_TIMEOUT_MS`, default 60 s) and one retry on transient 429/5xx before falling back to Groq (previously a hung provider hung the request).
- Removed early `SIGINT`/`SIGTERM` handlers that exited before the graceful shutdown could run; shutdown now has a 10 s force-exit guard. Added `unhandledRejection`/`uncaughtException` handling.
- HTTP server keep-alive/header/request timeouts set (fixes sporadic proxy 502s, mitigates slow-loris).
- Engine proxy calls now time out instead of hanging.
- Expired sessions are purged daily (`SESSION_RETENTION_DAYS`); DB statement timeout added; DB TLS configurable (`DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`).
- New `/healthz` and `/readyz` probes.
- Unexpected engine errors no longer leak raw exception text; network failures map to clear messages (timeout / connection / too many redirects).

### Performance
- gzip/deflate compression on all Node responses (`index.html` 405 KB → ~79 KB on the wire).

### Maintenance / missing pieces added
- Dependencies pinned (`"latest"` → caret ranges; lockfile updated), `engines: node >= 20`, new `compression` dependency.
- New tests: `test/security_hardening_test.js` (in `npm test`) and `seo-engine/tests/test_security.py` (22 tests, `npm run test:python`).
- Added `.gitignore`, `.dockerignore`, `Dockerfile`, `requirements-dev.txt`; `render.yaml` gains a health check and env vars.
- Removed dead files (`script0.js`, `script1.js`, `__pycache__`); moved status notes into `docs/`.
- `.env.example` documents every new setting.

## 1.3.0
- Removed SEO Quiz (UI, API, DB table) to cut backend load
- New users get a 30-day unlimited trial; buying during it adds 2 free months
- Pricing: Rs 99/month, Rs 4999/year
- Pro Studio: one full-page Pro dashboard per tool group (8), icon rail, all sub-sections in depth; 3 Pro runs per group for trial/free users, unlimited when paid; server-side orchestration
- SerpApi calls retry 3x with 10s connect / 60s read timeout

## 2026-09-30 — Pro Studio v3 UI/UX + performance hardening
- Rebuilt Pro Studio visual system with theme-aware dark/light modes, responsive rail, sticky command header, section navigation and premium executive summary cards.
- Added combined Executive Summary to every Pro hub so related sub-checks are presented as one decision workspace.
- Added short-lived client/server result caching and in-flight request deduplication for repeat Pro runs; sub-checks continue to execute in parallel.
- Added active section navigation, contextual quick-jump actions, run-time/cache indicators and improved empty/error/loading states.
- Fixed dashboard Add Website with a real project modal backed by `/api/agent/projects`.
- Added dashboard workspace hydration for projects, tasks, task progress and recent activity.
- Added persistent contextual SEO Zypp Copilot instead of the old transient buddy toast.
- Hardened URL/autofill styling so recommended/autofilled URLs retain readable text and theme-appropriate backgrounds.
- Added responsive header and dashboard control polish.

## Luxe UI pass
- Header: the account name was rendered twice (`#agentUserChip` + a second chip injected by `askseo-inspired.js`). The injected chip is gone; the header is now one row: title · search · theme icon · single account chip (name + plan/expiry) · logout icon. Usage chip and model badge are no longer shown there.
- Pro Studio redesigned as the "Private Suite": wide grouped sidebar (Intelligence / Market / Concierge) with membership card, collapsible to an icon rail (`[` key or the ‹ button), obsidian + champagne palette in dark mode and ivory + bronze in light mode, serif headings, underline sub-tabs, in-suite theme switch.
- All Pro results (Pro Studio tables/cards/rings/bars, Pro Premium `pp-*`, deep-dive `zd-*`, graphic tiles `zg-*`, and app tables) now read one token set (`--lx-*` in `pro-luxe.css`) keyed to `html[data-theme]`, so background and text always flip together (fixes white table rows with pale text in dark mode).
- New: `public/pro-luxe.css`, `public/pro-luxe.js`, `test/luxe_ui_static_test.js`.
- Fix: after login/reset the Overview page was blank until another tab was clicked. `resetWorkspaceClientState()` removed `active-view` from every view and never restored it on the dashboard; it now does, and re-fills the page title/subtitle if empty.
- Packaging: the delivered zip no longer contains `.env` (copy `.env.example` to `.env` and add your keys) and no caches/build output.
