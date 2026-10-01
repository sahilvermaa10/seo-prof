# SEO Agent Pro — Growth OS

This release adds an actionable SEO operating layer to the existing product.

## Included
- **SEO Copilot foundation:** evidence-first Growth OS endpoint that combines crawl evidence, technical findings, content optimization, keyword/page mapping and a 30-day roadmap.
- **Keyword/page mapping:** intent classification, page-fit scoring and cannibalization guidance.
- **Content Optimizer:** title/H1/coverage/structure checks, projected optimization score, outline and quality checklist.
- **Technical Deep Audit:** HTTPS, canonical, indexing directives, sitemap verification status, H1 structure, image accessibility, structured data and redirects.
- **SEO Change Detection API:** compares previous/current page snapshots for title, canonical, meta, headings, content, links, schema and indexing changes.
- **Execution Queue:** persistent, prioritized SEO tasks with open/in-progress/done states.
- **Agency layer:** persistent white-label brand/logo/domain settings.
- **Integration registry:** GSC, GA4, WordPress, Shopify and Slack connection state/capability layer.
- **Existing monitoring and alerts:** retained and compatible with the new execution workflow.
- **Existing PDF/reporting:** retained; agency settings can now be used as the foundation for branded reporting.

## Important deployment notes
Provider integrations require the deployment owner's OAuth/API credentials and explicit permissions. This release does **not** pretend to have live GSC/GA4 data without credentials, and it never silently writes to a customer's CMS.

## Run
```bash
npm install
npm test
npm start
```

Do not commit `.env` or real provider credentials.
