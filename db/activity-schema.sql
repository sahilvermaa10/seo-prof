-- Admin panel Phase 3: activity & usage logging
-- Additive only — does not modify any existing table.
-- Run with: psql "$DATABASE_URL" -f db/activity-schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Every authenticated (and failed-auth) API call, one row per request.
-- This is the backbone for "Individual User Tracking" and the live
-- activity feed. Written by generic middleware, not by each route,
-- so new routes are covered automatically.
CREATE TABLE IF NOT EXISTS user_activity (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    feature TEXT NOT NULL,            -- human label, e.g. "Keyword Research"
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    status_code INTEGER,
    success BOOLEAN,
    duration_ms INTEGER,
    ip_address TEXT,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"keyword":"...","country":"US","url":"..."}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_activity_user_created_idx ON user_activity(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_feature_created_idx ON user_activity(feature, created_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_created_idx ON user_activity(created_at DESC);

-- One row per outbound call to a paid/rate-limited external provider
-- (Gemini, SerpApi, PageSpeed, the Python SEO engine). This is what
-- powers "AI & API Usage Monitoring" and cost estimates. Never stores
-- API keys — only counts, durations, and error text.
CREATE TABLE IF NOT EXISTS api_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    provider TEXT NOT NULL CHECK (provider IN ('gemini','groq','serpapi','pagespeed','python_engine')),
    operation TEXT NOT NULL,          -- e.g. "generateContent", "google_search", "technical-check"
    success BOOLEAN NOT NULL,
    duration_ms INTEGER,
    tokens_estimate INTEGER,          -- Gemini only, rough (prompt+output length / 4)
    cost_estimate_usd NUMERIC(10,5),  -- best-effort estimate, not a billing source of truth
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_usage_provider_created_idx ON api_usage(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_user_created_idx ON api_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_created_idx ON api_usage(created_at DESC);

-- Login/signup/logout/failed-login events. Kept separate from
-- user_activity because it must also capture FAILED auth attempts
-- for users who don't have a valid session yet.
CREATE TABLE IF NOT EXISTS login_history (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    event TEXT NOT NULL CHECK (event IN ('signup','login','logout','failed_login')),
    identifier TEXT,                  -- username/email as typed, only stored on failed attempts
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS login_history_user_created_idx ON login_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_history_created_idx ON login_history(created_at DESC);


-- Live user presence/session analytics. This deliberately stores aggregate
-- pointer activity and page/feature events, never keystrokes or form values.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_path TEXT;
UPDATE sessions SET last_seen_at = COALESCE(last_seen_at, created_at) WHERE last_seen_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions(expires_at, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS user_presence (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    session_token_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    page_path TEXT,
    page_title TEXT,
    cursor_x INTEGER,
    cursor_y INTEGER,
    viewport_width INTEGER,
    viewport_height INTEGER,
    mouse_moves INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    page_views INTEGER NOT NULL DEFAULT 0,
    idle_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_presence_last_seen_idx ON user_presence(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS ui_activity (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token_hash TEXT REFERENCES sessions(token_hash) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    page_path TEXT,
    target TEXT,
    duration_ms INTEGER,
    cursor_x INTEGER,
    cursor_y INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ui_activity_user_created_idx ON ui_activity(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ui_activity_created_idx ON ui_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS ui_activity_type_created_idx ON ui_activity(event_type, created_at DESC);

-- Allow the optional Groq AI fallback in existing installations as well.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_usage_provider_check') THEN
        ALTER TABLE api_usage DROP CONSTRAINT api_usage_provider_check;
    END IF;
    ALTER TABLE api_usage ADD CONSTRAINT api_usage_provider_check CHECK (provider IN ('gemini','groq','serpapi','pagespeed','python_engine'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
