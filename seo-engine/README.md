# SEO Agent Python Engine

FastAPI is now the **single source of truth for SEO analysis**. The Node/Express app is the UI/auth/export shell and proxies measurable SEO requests to this engine.

## Coverage

- Dashboard SEO scoring and findings
- Site audit / technical SEO
- SEO action optimizer
- Same-domain crawler
- Internal/external link extraction and internal-link opportunities
- Keyword research/opportunities from live SerpApi results
- Rank check and rank tracking with regional Google parameters
- Top rankings and competitor discovery
- Content brief and content-gap analysis
- Content planning and evidence-first recommendations
- URL verification and SEO monitoring snapshots
- Google Search Console CSV aggregation
- PageSpeed Insights
- OpenPageRank
- Backlink-opportunity guidance without fabricated backlink metrics
- Google Trends section returns evidence-limited live SERP context rather than inventing a numeric trend series
- Public-URL/SSRF protection

## Run locally

The normal application command automatically starts this FastAPI service:

```bat
npm ci
npm start
```

Node launches Uvicorn on `http://localhost:8000` when the default local
`PYTHON_ENGINE_URL` is used, so no second terminal is required.

If Python dependencies are not installed, run once:

```bat
cd seo-engine
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```


## Environment

The Python service reads these environment variables directly:

- `SERPAPI_KEY`
- `PAGESPEED_API_KEY`
- `OPENPR_API_KEY`

Missing third-party keys produce explicit configuration errors instead of fake data.

## Endpoints

`POST /analyze`, `/site-audit`, `/keywords`, `/content`, `/content-gap`, `/rank-check`, `/top-rankings`, `/competitors`, `/seo-actions`, `/crawl`, `/rank-track`, `/ai-recommendations`, `/keyword-opportunity`, `/keyword-verify`, `/content-plan`, `/verify-url`, `/backlink-opportunities`, `/internal-link-opportunities`, `/monitor-snapshot`, `/gsc-import`, `/pagespeed`, `/domain-authority`, `/trends`, `/technical-check`.

All of these are exposed through the Node application's matching `/api/...` routes.
