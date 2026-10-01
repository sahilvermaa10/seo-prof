const crypto = require("crypto");
const { query } = require("../db");

/* =========================================================
   FEATURE LABELS
   Maps an Express route path to the human-readable feature name
   shown in the admin panel's activity views. Anything not listed
   here falls back to the raw path, so new routes are never silently
   dropped from the activity log — they just show up unlabeled until
   someone adds a mapping.
========================================================= */
const FEATURE_LABELS = {
    "/api/auth/signup": "Sign Up",
    "/api/auth/login": "Login",
    "/api/auth/logout": "Logout",
    "/api/crawl": "Site Crawl",
    "/api/rank-track": "Rank Check",
    "/api/keyword-opportunity": "Keyword Research",
    "/api/keyword-verify": "Keyword Verification",
    "/api/content-plan": "Content Plan",
    "/api/verify-url": "URL Verification",
    "/api/backlink-opportunities": "Backlink Opportunities",
    "/api/internal-link-opportunities": "Internal Link Opportunities",
    "/api/monitor-snapshot": "Monitor Snapshot",
    "/api/gsc-import": "Search Console Import",
    "/api/export-pdf": "PDF Export",
    "/api/pagespeed": "PageSpeed Audit",
    "/api/domain-authority": "Domain Authority Check",
    "/api/trends": "Keyword Trends",
    "/api/technical-check": "Technical SEO Audit",
    "/api/ai-recommendations": "AI Recommendations",
    "/api/seo-actions": "SEO Action Plan",
    "/api/agent/projects": "Project Management",
    "/api/agent/dashboard": "Agent Dashboard",
    "/api/agent/action-center": "Action Center",
    "/api/agent/keyword-gap": "Keyword Gap Analysis",
    "/api/agent/content-decay": "Content Decay Check",
    "/api/agent/rank-history": "Rank History",
    "/api/agent/ai-advisor": "AI Advisor",
    "/api/agent/content-refresh": "Content Refresh",
    "/api/agent/ai-strategy": "AI Strategy",
    "/api/agent/monitor/jobs": "Rank Monitoring",
    "/api/agent/monitor/run": "Rank Monitoring Run",
    "/api/agent/alerts": "Alerts",
    "/api/agent/report-pdf": "Agent PDF Report"
};

function featureForPath(path) {
    const clean = String(path || "").split("?")[0].replace(/\/$/, "");
    if (FEATURE_LABELS[clean]) return FEATURE_LABELS[clean];
    // Strip trailing /:id-style segments, e.g. /api/agent/monitor/jobs/abc123
    const withoutId = clean.replace(/\/[^/]+$/, "");
    if (FEATURE_LABELS[withoutId]) return FEATURE_LABELS[withoutId];
    return clean || "Unknown";
}

/* =========================================================
   LOGGERS
   Every function here is intentionally fire-and-forget-safe: it
   catches and logs its own errors to the console instead of
   throwing, so a problem with the activity/usage tables can never
   break a real user-facing request.
========================================================= */

async function logActivity({ userId, feature, method, path, projectId = null, statusCode, success, durationMs, req, metadata = {} }) {
    try {
        const ip = req ? String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() : null;
        const userAgent = req ? String(req.headers["user-agent"] || "").slice(0, 300) : null;
        await query(
            `INSERT INTO user_activity (id, user_id, feature, method, path, project_id, status_code, success, duration_ms, ip_address, user_agent, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
            [crypto.randomUUID(), userId || null, feature, method, path, projectId, statusCode ?? null, success ?? null, durationMs ?? null, ip, userAgent, JSON.stringify(metadata || {})]
        );
    } catch (error) {
        console.error("logActivity failed:", error.message);
    }
}

async function logApiUsage({ userId, provider, operation, success, durationMs, tokensEstimate = null, costEstimateUsd = null, errorMessage = null, metadata = {} }) {
    try {
        await query(
            `INSERT INTO api_usage (id, user_id, provider, operation, success, duration_ms, tokens_estimate, cost_estimate_usd, error_message, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
            [crypto.randomUUID(), userId || null, provider, operation, !!success, durationMs ?? null, tokensEstimate, costEstimateUsd, errorMessage, JSON.stringify(metadata || {})]
        );
    } catch (error) {
        console.error("logApiUsage failed:", error.message);
    }
}

async function logLogin({ userId = null, event, identifier = null, req }) {
    try {
        const ip = req ? String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() : null;
        const userAgent = req ? String(req.headers["user-agent"] || "").slice(0, 300) : null;
        // Only persist the typed identifier for failed attempts (helps spot
        // brute-force patterns); successful events are already tied to userId.
        const storedIdentifier = event === "failed_login" ? identifier : null;
        await query(
            `INSERT INTO login_history (id, user_id, event, identifier, ip_address, user_agent)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [crypto.randomUUID(), userId, event, storedIdentifier, ip, userAgent]
        );
    } catch (error) {
        console.error("logLogin failed:", error.message);
    }
}

// Rough Gemini token estimate: ~4 chars per token. Not billing-accurate,
// good enough for a trend line in the admin usage dashboard.
function estimateTokens(...texts) {
    const totalChars = texts.reduce((sum, t) => sum + String(t || "").length, 0);
    return Math.ceil(totalChars / 4);
}

module.exports = { featureForPath, logActivity, logApiUsage, logLogin, estimateTokens, FEATURE_LABELS };
