# SEO Agent Automation Hardening V1

## Scope
This release hardens the SEO Agent against cross-site contamination, stale responses, unsafe caching, inconsistent scoring, crawler URL duplication, duplicate scheduled monitoring, and backend request failures.

## Fixed
- Removed premium-layer persistence/restoration of the previous dashboard/audit site.
- Removed automatic copying of the dashboard URL into Technical, On-Page, Indexing, Site Health, Opportunities, and Reports.
- Made the Ask SEO assistant require its own explicit URL instead of searching other section inputs.
- Centralized Technical/On-Page/Indexing/Health/Opportunities execution through the guarded section runner.
- Added per-section request-generation protection so late async responses cannot overwrite newer results.
- Reset extended sections on return and invalidate pending requests.
- Made full reports fetch independent audit/technical/on-page/indexing/health/opportunity evidence for the report URL.
- Added report context URL guards to prevent mixed-site report state.
- Disabled client POST result caching; GET caching remains short-lived.
- Added no-store headers to Node-to-Python requests and unique request IDs.
- Added timeout handling to Python technical/proxy/PDF paths.
- Fixed agent routes that were calling authentication without `await`.
- Protected the generic `/api/python-engine/:endpoint` proxy with agent authentication.
- Replaced the Gemini-generated `/api/site-audit` fact/scoring path with deterministic Python evidence, removing the invalid-JSON audit failure mode.
- Unified Python SEO scoring to: `100 - 12 × critical - 5 × warning`, clamped to 0–100.
- Made Technical SEO use the Python source-of-truth score.
- Made monitoring snapshots use the same unified score.
- Added actual `audit_runs` records for Agent Dashboard and Action Center executions.
- Added atomic `FOR UPDATE SKIP LOCKED` scheduled-monitoring job claiming.
- Normalized stored project, rank-history, and monitoring URLs.
- Improved URL normalization: removes fragments and known tracking parameters while preserving functional query parameters.
- Made crawler URL identity consistent and deduplicated normalized URLs.
- Reused host-level robots/sitemap checks across a crawl.
- Kept live single-page extraction fresh while allowing safe per-page crawl caching.
- Prevented cached page objects from being mutated by callers.
- Prevented crawler HTTP sessions from carrying cookies between independent public-site jobs.
- Added automated regression/static hardening tests.

## Intentionally NOT changed
Python runtime/version configuration was deliberately left unchanged so the current Python version can be tested first, as requested.

## Verification
- Node syntax checks: PASS
- Python compile check: PASS
- Existing application test suite: PASS
- Automation hardening regression tests: PASS
- URL normalization invariants: PASS
- Unified scoring invariants: PASS
