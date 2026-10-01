# SEO Agent authentication & password recovery

The public user recovery flow is intentionally username-only. It does **not** send email, require a verification code, use a reset link, or require an existing login session.

## Password recovery flow

1. User clicks **Forgot password?**.
2. User enters their username.
3. The UI immediately opens **New password** and **Confirm new password** fields after the username is found.
4. The server hashes the new password and updates `users.password_hash` in PostgreSQL.
5. Existing sessions for that account are invalidated.
6. A fresh session is created and the user is taken directly into the dashboard.

No Resend, SMTP, email API key, verification code, or reset URL is required.

### Security note

Username-only recovery is intentionally weaker than verified password recovery because anyone who knows a username can request a password change. The application keeps rate limiting enabled, but this mode should only be used where that trade-off is explicitly acceptable.

## User authentication UI

The public authentication screen is intentionally user-only. Admin login is not exposed as a public tab or form; admin access remains controlled by the database role and separate admin surface.

The user login screen includes:

- Username or email sign-in
- Create-account flow
- Username-only password recovery
- New password + confirm password fields
- Password show/hide controls
- Password-strength feedback
- Authentication database health indicator
- Light/dark mode
- Hover, press, loading and keyboard states
- Responsive scrolling

## SEO Master Quiz

Every authenticated login generates a fresh randomized 20-question SEO quiz. A server-side grading endpoint validates the answers. A perfect 20/20 score activates `quiz_unlimited` for 30 days using the existing billing entitlement system. The reward is applied in PostgreSQL, so it is not dependent on local browser state.
