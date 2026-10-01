# SEO Agent — AskSEO v3.4-inspired upgrade

## What changed

### 1. Fixed the Agent Pro crash
The production error `pythonPost is not defined` was caused by Agent Pro routes calling a helper that did not exist in `server.js`.

Added a centralized `pythonPost()` client with:
- JSON request/response handling
- 180-second timeout for long SEO jobs
- Python engine availability errors
- HTTP error propagation
- Abort handling

This covers Dashboard Pro, Action Center, Keyword Gap, Content Decay, Rank History, Monitoring, AI Advisor, Content Refresh and AI Strategy.

### 2. AskSEO-style workspace UX
Added an original AskSEO-v3.4-inspired presentation layer:
- grouped SaaS navigation
- compact top search
- user chip/avatar
- Ctrl/Cmd + K command palette
- keyboard navigation and Escape handling
- consistent cards, controls and navigation states

The existing SEO Agent tools and API routes remain in place rather than being replaced by mock screens.

### 3. AskSEO-style lamp login
The login experience now opens with an accessible lamp/pull-cord interaction and reveals:
- Sign in
- Create account
- Admin role login

Admin credentials are never hard-coded into the frontend. Admin access is verified by the database role returned from `/api/auth/login`.

### 4. Conversational SEO Agent AI
Added `POST /api/agent/ask`.

The assistant first obtains verified SEO evidence from the Python engine and then asks Gemini to answer the user's question using only that evidence. The prompt explicitly prohibits invented rankings, traffic, backlinks, search volume or guarantees.

A floating AI assistant is available throughout the authenticated workspace.

### 5. Quick actions
The dashboard now exposes direct shortcuts to:
- Site Audit
- Keyword research
- Rank Checker
- AI SEO Advisor

## Validation

Run:

```bash
npm test
```

The complete existing test suite passes, including the added Agent Pro integration assertions.

## Start

```bash
npm start
```

The Node server automatically starts the local Python SEO engine when `AUTO_START_PYTHON_ENGINE=true`.

For a separate Python process:

```bash
npm run start:python
```

Do not copy `.env` into a public repository. Use `.env.example` and provide your own keys locally.


## Authentication database boundary

This agent uses PostgreSQL only for users, sessions, projects, rankings, monitoring, alerts, audits, and admin data. The AskSEO SQLite database is not read, imported, or required at runtime. Existing PostgreSQL accounts remain the source of truth. The login verifier is backward-compatible with older SEO Agent scrypt output lengths and transparently upgrades a legacy hash after successful authentication.
