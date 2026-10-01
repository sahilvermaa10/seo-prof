# Admin Panel Live Monitoring Upgrade

- Live user presence refreshes every 15 seconds.
- Session history records start/last-seen/end/estimated duration.
- UI activity records page views, clicks, feature events, visibility and session events.
- Pointer data is aggregated/throttled; raw mousemove streams, keystrokes, passwords and form values are never recorded.
- PostgreSQL is the source of truth.
- Open `/admin` after `npm start`.
