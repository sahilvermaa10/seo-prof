# PostgreSQL-only authentication

This agent uses PostgreSQL only for users and sessions. The AskSEO database is not read, imported, or required.

## First run

1. Copy `.env.example` to `.env` and set `DATABASE_URL` to the PostgreSQL database used by this SEO Agent.
2. Run `npm install`.
3. Run `npm start`.

The server now creates the PostgreSQL `users` and `sessions` auth tables/indexes automatically if they do not already exist. It does not create or access any SQLite/AskSEO database.

## Authentication diagnostics

Open `/api/auth/health` while the server is running. A healthy response contains `database: "postgresql"` and user/session counts.

If login or signup fails, the UI now displays the server error instead of silently doing nothing.
