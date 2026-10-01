# SEO Agent Pro — Admin Panel Upgrade

This build hardens the admin panel and makes it easier to operate locally.

## Included
- `/admin` and `/admin.html` admin panel entry points.
- Live dashboard auto-refresh every 15 seconds.
- Manual Refresh button.
- PostgreSQL health/latency status.
- Python FastAPI engine health/latency status.
- Node.js uptime and memory status.
- 20-second browser API timeout with clearer errors.
- Automatic startup of the local Python SEO engine through `npm start` when configured.
- Idempotent startup schema initialization for the core PostgreSQL tables and activity tables.
- User search, role promotion/demotion and deletion.
- Project and audit management.
- Monitoring and alert management.
- Audit detail viewer.
- Admin audit log.
- New database diagnostics commands.

## Local commands

From the project folder:

```cmd
npm install
npm start
```

Admin database information:

```cmd
npm run db:admin-info
```

Check one account:

```cmd
npm run db:admin-info -- sahil.vermaa@gmail.com
```

Make an existing account an admin:

```cmd
npm run db:make-admin -- sahil.vermaa@gmail.com
```

If the account exists but the password is unknown, reset it and promote the same account:

```cmd
npm run db:reset-admin -- sahil.vermaa@gmail.com
```

The reset command asks for a new password and signs out old sessions.

## Important
Do not run `db:make-admin` by itself. It is an npm script and must be run with `npm run`.

Do not expose `.env` or its API/database credentials in screenshots or public repositories. Rotate credentials if they have already been shared publicly.

## Admin URL
After `npm start`, open:

```text
http://localhost:3000/admin
```

The browser must be using the same Node process and `.env` database configuration as the command-line scripts.
