# Final SEO Engine Consolidation

## Architecture

All measurable SEO sections use the Python FastAPI engine as the source of truth:

`Browser -> Node/Express -> Python FastAPI -> live page crawl / SerpApi / Google APIs`

Node remains responsible for the web app shell, authentication, exports and proxying.

## Python-backed sections

- Dashboard / full SEO analysis
- Site Audit
- Technical SEO
- SEO Actions / Optimizer
- Crawler / Site Health
- Keyword Intelligence
- Rank #1 Planner
- Rank Checker
- Rank Tracker
- Top Rankings / SERP Analyzer
- Competitor Analysis
- Content Analysis
- Content Gap
- Content Plan
- AI/evidence-first recommendations
- URL verification
- Internal Link Opportunities
- Backlink Opportunities (evidence-limited)
- SEO Monitor
- PageSpeed Insights
- OpenPageRank
- Google Search Console import
- SERP-based demand/trend context

## Live ranking data

Rank Checker, Rank Tracker, Top Rankings, Rank #1 Planner, keyword opportunities and competitor discovery use **live Google SERP data through SerpApi**.

Regional Google settings are passed through (`gl`, `hl`, `google_domain`) so India, US, UK, etc. are checked against the selected Google region.

The engine does not invent monthly search volume, backlink counts, traffic, authority or ranking data. When a metric is not provided by a configured data source, the UI reports that it is not verified.

## Startup

1. Copy `.env.example` to `.env` and add your keys.
2. Install Node dependencies:

```bash
npm install
```

3. Install Python dependencies:

```bash
cd seo-engine
python -m pip install -r requirements.txt
cd ..
```

4. Start everything:

```bash
npm start
```

Node automatically starts the local Python engine on `http://localhost:8000` and waits for its health endpoint before starting the web app.

## Required keys

- `GEMINI_API_KEY` — existing Gemini UI/AI functionality
- `SERPAPI_KEY` — live Google rankings, SERP and competitor features

Optional:

- `PAGESPEED_API_KEY`
- `OPENPR_API_KEY`

The distributed ZIP intentionally contains no live API secrets. Put your keys into `.env` locally.

## Final section routing (consolidated build)

| UI section | Source | What it returns |
|---|---|---|
| Technical SEO | Python FastAPI SEO Engine | Deterministic technical checks, evidence, why it matters, recommendations |
| On-Page SEO | Python FastAPI SEO Engine | Title/meta/headings/content/image checks, evidence, explanations, recommendations |
| Indexing & Schema | Python FastAPI SEO Engine | Canonical, robots, sitemap, indexability and structured-data checks |
| Site Health | Python FastAPI crawler | Multi-page crawl, per-page score, issues, evidence and recommended fixes |
| Opportunities | Python FastAPI action engine | Prioritized SEO opportunities with evidence, why and implementation |
| Internal Links | Python FastAPI crawler | Crawl-backed source/target suggestions, relevance evidence, orphan candidates and recommendations |
| Backlink Builder | Gemini API + verified destination catalog | Gemini-selected opportunities, action, why, quality checks; URLs are restricted to the verified catalog |
| Page Speed | Google PageSpeed Insights API | Lighthouse category scores, Core Web Vitals, diagnostics and optimization opportunities |
| Keyword Trends | Google Trends data adapter (`google-trends-api`) | 12-month interest timeline, trend direction, rising queries and top related queries |
| SEO Content Writer | Gemini API | SEO brief plus Gemini-generated content draft |
| Rank Tracker / Rank #1 Planner / Competitors | SerpApi + Python | Live regional Google SERP evidence, target-page/domain rank, competitor evidence and ranking tasks |

### Important

The Python engine is automatically started by `npm start` when `PYTHON_ENGINE_URL` is local. The Node application remains the web/auth/export shell and owns the direct Gemini, PageSpeed, and Google Trends integrations where specified above.

Set `GEMINI_API_KEY` and `SERPAPI_KEY` in `.env`. Set `PAGESPEED_API_KEY` for PageSpeed quota/automated usage when desired.

## PostgreSQL database setup

The application now uses PostgreSQL for persistent application data. JSON files are no longer used for authentication, projects, rank history, monitoring jobs, monitor snapshots, or alerts.

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL`, for example:
   `postgresql://postgres:postgres@localhost:5432/seo_agent`
4. Run:
   `npm install`
   `npm run db:migrate`
5. Start the application with `npm start`.

If you have an existing installation containing the old JSON files, run `npm run db:migrate:json` before deleting those files. The migration imports users, projects, rank history, monitor jobs, and alerts.

To promote an existing account to administrator:

`npm run db:make-admin -- user@example.com`

The server checks PostgreSQL during startup and exits with a clear startup error if `DATABASE_URL` is missing or the database is unreachable.
