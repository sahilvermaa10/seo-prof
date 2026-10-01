# SEO Zypp — Free, Evidence-First SEO Agent

SEO Zypp is a Node.js/Express SEO workspace designed to separate **verified facts** from **AI analysis**.

## Core features
- Site Audit and deterministic technical/on-page checks
- Same-domain crawler (10/25/50 page limits)
- Rank #1 Planner using regional Google SERP data via SerpApi
- Exact target-page rank verification, including fetched final URL/canonical matching
- SERP evidence: actual ranking URL, title, snippet, region, scan depth and search metadata
- Keyword research and content planning grounded in live SERP signals
- Competitor analysis with direct page crawling where available
- Rank tracking
- PageSpeed Insights
- OpenPageRank
- Google Trends
- SEO task completion + fresh crawl/SERP verification
- **Verification Center** with deterministic HTML evidence
- **Internal Link Builder** based on crawl-backed topical overlap
- **Google Search Console CSV Import** (free; uses only data exported by the user)
- **SEO Monitor** with browser-local snapshots and score/rank comparisons
- Professional reports/PDF print export

## Evidence policy
The app must never manufacture search volume, traffic, backlinks, rankings or Search Console metrics. When a metric is unavailable, it is labelled unavailable/not verified. AI is used for interpretation of verified inputs, not as a source of facts.

## Run locally
1. Copy `.env.example` to `.env`.
2. Add your own API keys:
   - `GEMINI_API_KEY`
   - `SERPAPI_KEY`
   - optional `PAGESPEED_API_KEY`
   - optional `OPENPR_API_KEY`
3. Install:
   `npm ci`
4. Start:
   `npm start`
5. Open:
   `http://localhost:3000`

## Free-cost design
The crawler, technical checks, verification engine, internal-link analysis and GSC CSV import do not require paid SEO databases. SerpApi/Gemini/PageSpeed/OpenPageRank usage is quota-dependent. Do not commit `.env`.

## Google Search Console
Export Performance data as CSV from Search Console and import it in Verification Center. The imported totals are calculated directly from the supplied rows. No Search Console values are guessed.

## Rank verification
Rank checks are regional and use the selected Google domain. The planner distinguishes:
- **Exact target page** — target URL (or fetched final/canonical URL) was found in the live SERP.
- **Domain only** — another page on the same domain ranked; this is not counted as the target page's rank.
- **Not found** — target page was not verified in the scanned organic results.

## Testing
Run:
`npm test` (Node suites, incl. security regression tests) and `npm run test:python` (engine SSRF/redirect tests; `pip install -r seo-engine/requirements-dev.txt` first).

Or just the original suite: `npm run test:professional`

The test suite checks that production routes are wired to real-data sources, ranking verification is evidence-limited, regional settings are used, and the free evidence-first tools are present.

## Security
Never distribute or commit `.env`, API keys, access tokens, or Search Console credentials. The distribution ZIP intentionally excludes `.env` and `node_modules`.

## Authentication & Personalized Dashboard

This version includes signup/login validation, secure password hashing with Node.js `crypto.scrypt`, username-based personalized greetings, user workspace cards, saved websites, recent search activity, task checkboxes, and a task-progress pie chart.

### Important for production
The included user store is a simple JSON file for local/demo use. Render's filesystem is not durable across all deployments or scaling scenarios. Before launching this as a multi-user SaaS, migrate authentication data to a managed PostgreSQL database (for example Render PostgreSQL) and use persistent sessions/JWTs.


## Technical SEO URL flow

## Python SEO Engine flow

Every measurable SEO section uses the same Python FastAPI engine as its source of truth:
dashboard analysis, site audit, technical/on-page/indexing checks, crawler/site health,
SEO actions, keyword research and opportunities, keyword verification, rank checking/tracking,
top rankings, competitors, content analysis/gaps/planning, recommendations, URL verification,
internal-link opportunities, backlink opportunities, PageSpeed, OpenPageRank, Search Console
import, Trends context, and monitoring snapshots.

Browser → Node `/api/...` → Python FastAPI `localhost:8000/...` → real website/API evidence.

You only need to run:

1. `npm ci`
2. `npm start`
3. Open `http://localhost:3000`

`npm start` now automatically launches the Python FastAPI engine on port 8000 and waits for
its `/health` endpoint. A second terminal is no longer required.

If Python dependencies are not installed, run once:

`cd seo-engine` → `python -m venv venv` → activate it → `pip install -r requirements.txt`

For a separately deployed Python engine, set `PYTHON_ENGINE_URL=https://...`. Local auto-start
is skipped for non-local URLs. Set `AUTO_START_PYTHON_ENGINE=false` to disable auto-start.


## Security & operations (v1.1)

See `CHANGELOG.md` for the full list of what was hardened. Practical settings:

| Setting | Why |
|---|---|
| `NODE_ENV=production` | Enables HSTS and TLS to the database. |
| `TRUST_PROXY` (default `1`) | Number of reverse-proxy hops in front of Node. Set `false` if Node faces the internet directly, otherwise client IPs (and therefore rate limits) can be spoofed. |
| `ENGINE_SHARED_SECRET` | Set the same random value on Node and on a separately deployed Python engine so only your app can call the engine. |
| `DB_SSL=false` | For a local/private Postgres that has no TLS while `NODE_ENV=production`. |

Health probes: `GET /healthz` (liveness) and `GET /readyz` (database + engine status; returns 503 only if the database is down).

Docker: `docker build -t seo-agent . && docker run -p 3000:3000 --env-file .env seo-agent` (runs Node and auto-starts the Python engine in one container).

Known limits: rate limiting is in-memory (per instance) — put a shared limiter (e.g. Redis, or your host's WAF) in front if you run several instances. The Python engine validates the target IP before every request/redirect hop but does not pin the resolved IP, so a hostile DNS server could in theory rebind between check and connect; run the engine without access to internal networks/metadata endpoints for defence in depth.


## Direct username password recovery
The user-facing recovery flow opens `Create a new password` directly. The user enters their username, new password, and confirmation; the server hashes the new password and updates `users.password_hash`, then creates a new authenticated session. No email, verification code, or reset link is involved.
