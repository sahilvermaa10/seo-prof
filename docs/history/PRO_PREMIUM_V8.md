# SEO Agent Pro — V8 Dashboard & Results Fix

V8 keeps the premium interface and fixes the result flow. The main Dashboard now consumes the structured evidence-first `/api/agent/dashboard` response instead of depending on a free-form Gemini response. The last verified dashboard result is cached locally so returning to Dashboard does not show an empty state after navigation or refresh. Audit results synchronize their legacy summary cards, while premium result rendering remains available.

The V8 CSS also prevents audit/result cards from collapsing into narrow columns and improves wrapping/readability. PostgreSQL-only authentication and the lamp/PULL login flow are unchanged.
