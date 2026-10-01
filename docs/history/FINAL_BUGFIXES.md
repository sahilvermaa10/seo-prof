# Final bug-fix architecture

## SEO source of truth
- Technical SEO: Python FastAPI engine
- On-Page SEO: Python FastAPI engine
- Indexing & Schema: Python FastAPI engine
- Site Health/Crawler: Python FastAPI engine
- Opportunities/SEO Actions: Python FastAPI engine
- Internal Link Opportunities: Python FastAPI engine
- Keyword research, rank tracking, Rank #1 Planner and competitors: Python + live SerpApi Google results
- PageSpeed: Google PageSpeed Insights API
- Keyword Trends: Google Trends adapter with SerpApi Google Trends fallback
- Backlink Builder: Gemini API, constrained to a verified destination catalog
- SEO Content Writer: Gemini API, using verified crawled page context
- AI implementation recommendations: Gemini API

## Detailed output fixes
Every Python SEO section returns and renders:
- what was checked
- observed evidence
- why the signal matters
- recommended fix
- status/priority

Technical, On-Page, and Indexing now use dedicated check sets instead of filtering a shared audit result.

## Competitor output fixes
Competitor cards now show:
- live regional Google position
- strengths
- gaps
- how the competitor can beat the target
- fetched page metrics
- target-vs-competitor word/H2/schema/internal-link comparisons

No traffic, backlink authority, or search-volume numbers are fabricated.

## Optimizer fix
The crawler uses the Python response field `word_count` and the UI accepts both `word_count` and `wordCount`, removing `undefined` values.

## Authentication fix
Accounts are persisted in `data/users.json`. Passwords remain scrypt-hashed and are never stored in plaintext. Login sessions are persisted in `data/sessions.json` for 30 days so refreshing the browser or restarting Node does not force account creation again. `data/sessions.json` is gitignored.

## Startup
Run `npm start`. The Node server automatically starts the local Python engine on port 8000 when Python dependencies are installed.
