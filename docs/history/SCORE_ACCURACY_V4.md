# Score Accuracy Update

## What changed
- Dashboard SEO scores are now deterministic and cannot be replaced by a Gemini-generated score.
- The dashboard score is calculated only from verified crawl evidence.
- If optional signals are not measured, a perfect 100/100 is not permitted; the response exposes `score_complete=false`.
- Python site-audit scoring now reserves 100/100 for a complete audit with explicit states for all checks. Informational/not-measured checks cap a perfect computed score at 99.
- A zero-check audit now returns 0 instead of 100.
- Frontend asset cache version bumped to 11.1.0.
- Python version was not changed.

## Important
The score is an internal page-health score based on verified checks. It is not a Google ranking score and does not predict rankings.
