# V6 Authentication / Lamp Fix

- The AskSEO-style lamp and PULL cord remain in place and remain clickable.
- Successful PostgreSQL login stores the session and explicitly opens the authenticated workspace.
- If an in-page transition is blocked by a browser/CSS/script issue, the login flow performs a hard navigation to `/?agent=1`; the saved session is restored by `/api/auth/me`.
- The authenticated workspace is forced visible only after authentication.
- Added `GET /api/auth/health` to verify PostgreSQL auth availability without exposing password data.
- PostgreSQL remains the only authentication store.
