# SEO Agent Pro — Premium Intelligence Upgrade V7

This release upgrades the inner SEO Agent interface without changing PostgreSQL-only authentication.

## User-facing upgrades
- Premium SaaS-style visual hierarchy, highlighted sections, cards, pills and responsive layouts.
- Verified metrics displayed as KPI cards instead of raw machine output.
- SVG charts for score health, status distribution, ranking history and issue magnitude.
- Detailed explanations: what the result means, why it matters, what to do next and how to measure.
- Expandable action cards with local "Mark as reviewed" interaction.
- JSON-to-readable presentation: structured responses are rendered as human-readable fields and nested cards, with optional readable JSON disclosure.
- Advanced AI output rendering with evidence, implementation steps and measurement guidance when returned by Gemini.
- GSC CSV results presented as exact imported KPIs and normalized visual comparisons.
- Rank history shown as per-keyword trend charts with interpretation and methodology.
- Audit/Technical/On-page/Indexing results rendered as detailed check-by-check explanations.

## Evidence policy
The UI does not invent search volume, traffic, backlinks, rankings or Google Search Console data. When a metric is unavailable, it is shown as unavailable rather than fabricated.

## Authentication
Authentication remains PostgreSQL-only. The AskSEO SQLite database is not used.
