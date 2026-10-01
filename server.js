const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const { runWithContext, currentUserId, currentFeature } = require("./lib/requestContext");
const { spawn } = require("child_process");
const googleTrends = require("google-trends-api");
const compression = require("compression");

// Always load .env relative to this file, not the working directory
dotenv.config({ path: path.resolve(__dirname, ".env") });
const { query, health: dbHealth, close: closeDb } = require("./db");
const { featureForPath, logActivity, logApiUsage, logLogin, estimateTokens } = require("./lib/activity");

const app = express();
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/* =========================================================
   PRODUCTION HARDENING + RESPONSE TELEMETRY
   Lightweight native middleware: no extra dependency required.
========================================================= */
app.disable("x-powered-by");
app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    // Inline scripts are used by the UI, so a script-src policy would break it. These
    // directives add clickjacking / base-tag / plugin protection without doing that.
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'");
    if (IS_PRODUCTION) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    res.setHeader("X-Request-Id", crypto.randomUUID());

    // Headers must be finalized BEFORE the response is sent. Setting a header
    // from the `finish` event causes ERR_HTTP_HEADERS_SENT because Node has
    // already committed the headers by that point. Wrap writeHead so the
    // measured response time is attached safely at the moment headers commit.
    const originalWriteHead = res.writeHead;
    res.writeHead = function patchedWriteHead(statusCode, statusMessage, headers) {
        if (!res.headersSent) {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            res.setHeader("X-Response-Time-Ms", ms.toFixed(1));
        }
        return originalWriteHead.call(this, statusCode, statusMessage, headers);
    };
    next();
});

const PORT =
    process.env.PORT || 3000;

/* =========================================================
   PYTHON SEO ENGINE — AUTOMATIC LOCAL SERVICE
   All measurable SEO sections use FastAPI as the source of truth.
   npm start automatically launches the local engine on :8000.
========================================================= */
const PYTHON_SEO_ENGINE_URL =
    (process.env.PYTHON_ENGINE_URL || "http://localhost:8000").replace(/\/$/, "");
const AUTO_START_PYTHON_ENGINE =
    String(process.env.AUTO_START_PYTHON_ENGINE || "true").toLowerCase() !== "false";
let pythonEngineProcess = null;
let pythonEngineSpawnError = null;
// Optional shared secret sent to the Python engine (X-Engine-Secret). Set the same
// ENGINE_SHARED_SECRET on both services when the engine is deployed publicly.
const ENGINE_SHARED_SECRET = String(process.env.ENGINE_SHARED_SECRET || "").trim();
function engineHeaders(extra = {}) {
    return ENGINE_SHARED_SECRET ? { ...extra, "X-Engine-Secret": ENGINE_SHARED_SECRET } : extra;
}

function isLocalPythonEngineUrl() {
    try {
        const u = new URL(PYTHON_SEO_ENGINE_URL);
        return ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
    } catch (_) { return false; }
}
function pythonCommandCandidates() {
    if (process.env.PYTHON_BIN) return [{cmd:process.env.PYTHON_BIN,args:[]}];
    return process.platform === "win32"
        ? [{cmd:"python",args:[]},{cmd:"py",args:["-3"]}]
        : [{cmd:"python3",args:[]},{cmd:"python",args:[]}];
}
function pythonEnginePort() {
    try { return String(new URL(PYTHON_SEO_ENGINE_URL).port || "8000"); }
    catch (_) { return "8000"; }
}
function pythonEngineHost() {
    try { return new URL(PYTHON_SEO_ENGINE_URL).hostname || "127.0.0.1"; }
    catch (_) { return "127.0.0.1"; }
}
async function waitForPythonEngine(timeoutMs=20000) {
    const started=Date.now();
    while(Date.now()-started<timeoutMs) {
        try {
            const r=await fetch(`${PYTHON_SEO_ENGINE_URL}/health`);
            if(r.ok) {
                const d=await r.json().catch(()=>({}));
                if(d.status==="healthy") return true;
            }
        } catch (_) {}
        await new Promise(resolve=>setTimeout(resolve,400));
    }
    return false;
}
async function startPythonSeoEngine() {
    if(!AUTO_START_PYTHON_ENGINE || !isLocalPythonEngineUrl()) {
        if(!isLocalPythonEngineUrl()) console.log(`Python SEO Engine: using external service ${PYTHON_SEO_ENGINE_URL}`);
        return false;
    }
    const fs=require("fs");
    const engineDir=path.resolve(__dirname,"seo-engine");
    const mainFile=path.join(engineDir,"main.py");
    if(!fs.existsSync(mainFile)) {
        pythonEngineSpawnError="seo-engine/main.py was not found.";
        console.error("PYTHON SEO ENGINE:",pythonEngineSpawnError);
        return false;
    }
    const localCandidates=process.platform==="win32"
        ? [path.join(engineDir,"venv","Scripts","python.exe"),path.join(engineDir,".venv","Scripts","python.exe")]
        : [path.join(engineDir,"venv","bin","python"),path.join(engineDir,".venv","bin","python")];
    let command=localCandidates.find(p=>fs.existsSync(p));
    let prefix=[];
    if(!command) { const c=pythonCommandCandidates()[0]; command=c.cmd; prefix=c.args; }
    try {
        pythonEngineProcess=spawn(command,[...prefix,"-m","uvicorn","main:app","--host",pythonEngineHost(),"--port",pythonEnginePort()],{
            cwd:engineDir,env:{...process.env},stdio:["ignore","pipe","pipe"],windowsHide:true
        });
        pythonEngineProcess.stdout.on("data",c=>process.stdout.write(`[Python SEO] ${c}`));
        pythonEngineProcess.stderr.on("data",c=>process.stderr.write(`[Python SEO] ${c}`));
        pythonEngineProcess.on("error",e=>{pythonEngineSpawnError=e.message;console.error("PYTHON SEO ENGINE SPAWN ERROR:",e.message);});
        pythonEngineProcess.on("exit",(code,signal)=>{console.log(`Python SEO Engine stopped (code=${code}, signal=${signal||"none"}).`);pythonEngineProcess=null;});
        console.log(`Starting Python SEO Engine automatically at ${PYTHON_SEO_ENGINE_URL} ...`);
        if(await waitForPythonEngine()) { console.log("Python SEO Engine: ✓ healthy and connected"); return true; }
        pythonEngineSpawnError=pythonEngineSpawnError||"Python engine did not become healthy within 20 seconds. Install seo-engine/requirements.txt and restart.";
        console.error("PYTHON SEO ENGINE:",pythonEngineSpawnError);
        return false;
    } catch(e) { pythonEngineSpawnError=e.message; console.error("PYTHON SEO ENGINE START ERROR:",e.message); return false; }
}

/* =========================================================
   PYTHON SEO ENGINE CLIENT
   Centralized, timeout-aware JSON proxy used by every Agent Pro
   route. This fixes the legacy `pythonPost is not defined` crash
   that affected Dashboard Pro, Action Center, Keyword Gap,
   Content Decay, Rank History, Monitoring and AI Agent routes.
========================================================= */
async function pythonPost(endpoint, payload = {}, timeoutMs = 180000) {
    const cleanEndpoint = String(endpoint || "").replace(/^\/+/, "");
    if (!cleanEndpoint) throw new Error("Python SEO Engine endpoint is missing.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 180000));

    try {
        const startedAt = Date.now();
        const response = await fetch(`${PYTHON_SEO_ENGINE_URL}/${cleanEndpoint}`, {
            method: "POST",
            headers: engineHeaders({ "Content-Type": "application/json", "Accept": "application/json", "Cache-Control": "no-store", "X-SEO-Agent-Request": crypto.randomUUID() }),
            body: JSON.stringify(payload || {}),
            signal: controller.signal
        });

        const contentType = response.headers.get("content-type") || "";
        const data = contentType.toLowerCase().includes("application/json")
            ? await response.json().catch(() => ({}))
            : { error: (await response.text()).slice(0, 1000) };

        const durationMs = Date.now() - (startedAt || Date.now());
        if (!response.ok) {
            const detail = data.detail || data.error || `Python SEO Engine returned HTTP ${response.status}.`;
            await logApiUsage({ userId: currentUserId(), provider: "python_engine", operation: cleanEndpoint, success: false, durationMs, errorMessage: String(detail).slice(0,500), metadata: { feature: currentFeature() } });
            throw new Error(String(detail));
        }
        await logApiUsage({ userId: currentUserId(), provider: "python_engine", operation: cleanEndpoint, success: true, durationMs, metadata: { feature: currentFeature() } });
        return data;
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(`Python SEO Engine timed out after ${Math.round(timeoutMs / 1000)} seconds. Check that the engine is running and the target URL is reachable.`);
        }
        if (error?.message?.includes("fetch failed") || error?.code === "ECONNREFUSED") {
            throw new Error(`Python SEO Engine is unavailable at ${PYTHON_SEO_ENGINE_URL}. Start the engine or verify PYTHON_ENGINE_URL.`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function stopPythonSeoEngine() {
    if(pythonEngineProcess) { try { pythonEngineProcess.kill(); } catch (_) {} pythonEngineProcess=null; }
}


const MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.5-flash-lite";

/* =========================================================
   GEMINI SETUP
========================================================= */

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim().replace(/^["\']|["\']$/g, "");
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || "").trim().replace(/^["\']|["\']$/g, "");
const GROQ_MODEL = String(process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim();
const GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";

/* =========================================================
   SERPAPI SETUP
========================================================= */

/*
 * CUSTOMIZABLE: paste your SerpApi key into .env as SERPAPI_KEY.
 * Unlike GEMINI_API_KEY, a missing SerpApi key does NOT stop the
 * server from starting — only the 3 SERP-powered routes below
 * (rank-check, top-rankings, competitors) will fail, with a clear
 * error message, until the key is added.
 */
const SERPAPI_BASE_URL =
    "https://serpapi.com/search.json";

const SERPAPI_DEFAULT_COUNTRY =
    process.env.SERPAPI_COUNTRY ||
    "us";

const SERPAPI_DEFAULT_LANGUAGE =
    process.env.SERPAPI_LANGUAGE ||
    "en";

/*
 * BUG FIX: every SERP-powered route used to be hardcoded to gl=us/hl=en
 * with no google_domain, so a site that genuinely ranks #1 in India (on
 * google.co.in) but much lower — or not at all — on google.com/US would
 * be reported as "not ranking" even though it truly ranks #1 in the
 * country the user actually cares about. These presets let every route
 * accept a `country` code from the client and search the *real* regional
 * Google (correct gl + hl + google_domain), instead of silently always
 * checking the US results.
 */
const COUNTRY_PRESETS = {
    in: { label: "India", gl: "in", hl: "en", google_domain: "google.co.in" },
    us: { label: "United States", gl: "us", hl: "en", google_domain: "google.com" },
    gb: { label: "United Kingdom", gl: "gb", hl: "en", google_domain: "google.co.uk" },
    ca: { label: "Canada", gl: "ca", hl: "en", google_domain: "google.ca" },
    au: { label: "Australia", gl: "au", hl: "en", google_domain: "google.com.au" },
    ae: { label: "UAE", gl: "ae", hl: "en", google_domain: "google.ae" },
    sg: { label: "Singapore", gl: "sg", hl: "en", google_domain: "google.com.sg" },
    de: { label: "Germany", gl: "de", hl: "de", google_domain: "google.de" },
    fr: { label: "France", gl: "fr", hl: "fr", google_domain: "google.fr" },
    ph: { label: "Philippines", gl: "ph", hl: "en", google_domain: "google.com.ph" },
    za: { label: "South Africa", gl: "za", hl: "en", google_domain: "google.co.za" }
};

/* Resolves a client-supplied country code to real SerpApi geo params, falling
   back to the server's configured default (env var, or "us") when the code
   is missing/unrecognized — never silently guesses a wrong region. */
function resolveCountry(code) {
    const key = String(code || "").trim().toLowerCase();
    if (key && COUNTRY_PRESETS[key]) return { code: key, ...COUNTRY_PRESETS[key] };
    const fallbackKey = SERPAPI_DEFAULT_COUNTRY.toLowerCase();
    return {
        code: fallbackKey,
        ...(COUNTRY_PRESETS[fallbackKey] || {
            label: fallbackKey.toUpperCase(),
            gl: SERPAPI_DEFAULT_COUNTRY,
            hl: SERPAPI_DEFAULT_LANGUAGE,
            google_domain: "google.com"
        })
    };
}

/* How many organic results to scan when looking for YOUR site (deep scan). */
const RANK_CHECK_SCAN_DEPTH = 30;

/* How many organic results to show for a plain keyword lookup. */
const TOP_RANKINGS_RESULT_COUNT = 10;

/* How many competitor pages to send to Gemini for analysis. */
const COMPETITOR_RESULT_COUNT = 5;

function getSerpApiKey() {
    // Strip surrounding whitespace and quotes that users sometimes add in .env
    const raw = process.env.SERPAPI_KEY || "";
    return raw.trim().replace(/^["']|["']$/g, "");
}

function requireSerpApiKey() {

    const key = getSerpApiKey();

    if (!key) {

        throw new Error(
            "SERPAPI_KEY is missing. Add it to your .env file to use this feature."
        );
    }

    return key;
}

async function fetchSerpResults(
    keyword,
    {
        num = TOP_RANKINGS_RESULT_COUNT,
        gl = SERPAPI_DEFAULT_COUNTRY,
        hl = SERPAPI_DEFAULT_LANGUAGE,
        google_domain = "google.com"
    } = {}
) {

    const apiKey =
        requireSerpApiKey();

    const params =
        new URLSearchParams({

            engine:
                "google",

            q:
                keyword,

            num:
                String(num),

            gl,

            hl,

            google_domain,

            no_cache:
                "true",

            api_key:
                apiKey
        });

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => {
                controller.abort();
            },
            FETCH_TIMEOUT_MS
        );

    let response;

    try {

        response =
            await fetch(
                `${SERPAPI_BASE_URL}?${params.toString()}`,
                {
                    signal:
                        controller.signal
                }
            );

    } catch {

        throw new Error(
            "Could not reach SerpApi. Please try again."
        );

    } finally {

        clearTimeout(
            timeout
        );
    }

    if (!response.ok) {

        throw new Error(
            `SerpApi request failed with status ${response.status}.`
        );
    }

    let data;

    try {

        data =
            await response.json();

    } catch {

        throw new Error(
            "SerpApi returned an unreadable response."
        );
    }

    if (data.error) {

        throw new Error(
            data.error
        );
    }

    const organic =
        Array.isArray(
            data.organic_results
        )
            ? data.organic_results
            : [];

    return organic.map(
        (
            item,
            index
        ) => ({

            position:
                typeof item.position ===
                "number"
                    ? item.position
                    : index + 1,

            title:
                item.title ||
                "",

            link:
                item.link ||
                item.redirect_link ||
                "",

            redirect_link:
                item.redirect_link ||
                "",

            displayed_link:
                item.displayed_link ||
                item.link ||
                item.redirect_link ||
                "",

            snippet:
                item.snippet ||
                ""
        })
    );
}

/* Strips "www." so "site.com" and "www.site.com" match as the same host. */
function registrableHost(
    hostname
) {

    return String(
        hostname || ""
    )
        .toLowerCase()
        .replace(
            /^www\./,
            ""
        );
}

function hostsMatch(
    hostnameA,
    hostnameB
) {

    const a =
        registrableHost(
            hostnameA
        );

    const b =
        registrableHost(
            hostnameB
        );

    return (
        a !== "" &&
        a === b
    );
}

function hostnameFromLink(
    link
) {

    try {

        return new URL(
            link
        ).hostname;

    } catch {

        return "";
    }
}

function resultBelongsToHost(result, targetHostname) {
    if (!result || !targetHostname) return false;
    const candidates = [result.link, result.redirect_link, result.displayed_link, result.source].filter(Boolean);
    for (const candidate of candidates) {
        const value = String(candidate).trim();
        const host = hostnameFromLink(value);
        if (host && hostsMatch(host, targetHostname)) return true;
        const hostText = value.replace(/^https?:\/\//i, "").split(/[\s/›>]/)[0].replace(/^www\./i, "").toLowerCase();
        if (hostText && hostsMatch(hostText, targetHostname)) return true;
    }
    return false;
}

function findRankMatch(results, targetHostname) {
    return safeArray(results).find(result => resultBelongsToHost(result, targetHostname)) || null;
}

const TRACKING_QUERY_PARAMS = new Set(["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","gclid","fbclid","msclkid","dclid","mc_cid","mc_eid"]);
function normalizeComparableUrl(value) {
    try {
        const u = new URL(String(value || "").trim());
        u.hash = "";
        u.protocol = u.protocol.toLowerCase();
        u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
        if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
        u.pathname = (u.pathname || "/").replace(/\/{2,}/g,"/").replace(/\/+$/,"" ) || "/";
        const kept=[...u.searchParams.entries()].filter(([k])=>!TRACKING_QUERY_PARAMS.has(k.toLowerCase())).sort(([ak,av],[bk,bv])=>ak.localeCompare(bk)||av.localeCompare(bv));
        u.search = kept.length ? "?" + new URLSearchParams(kept).toString() : "";
        return u.toString().replace(/\/$/, u.pathname === "/" ? "/" : "");
    } catch { return ""; }
}

function findExactPageMatch(results, targetUrl) {
    const target = normalizeComparableUrl(targetUrl);
    if (!target) return null;
    return safeArray(results).find(result => {
        const candidates = [result.link, result.redirect_link].filter(Boolean);
        return candidates.some(candidate => normalizeComparableUrl(candidate) === target);
    }) || null;
}


async function findExactPageMatchWithCanonical(results, targetUrl, maxCandidates = 10) {
    const direct = findExactPageMatch(results, targetUrl);
    if (direct) return { match: direct, verification: "serp-url-exact" };

    const targetNorm = normalizeComparableUrl(targetUrl);
    const targetHost = hostnameFromLink(targetUrl);
    const candidates = safeArray(results)
        .filter(r => resultBelongsToHost(r, targetHost))
        .slice(0, maxCandidates);

    for (const result of candidates) {
        const candidateUrl = result.link || result.redirect_link;
        if (!candidateUrl) continue;
        try {
            const fetched = await fetchWebpage(candidateUrl);
            const candidateFinal = normalizeComparableUrl(fetched.finalUrl);
            const page = extractPageContent(fetched.html, fetched.finalUrl);
            const canonical = normalizeComparableUrl(page.canonical);
            if (candidateFinal === targetNorm || canonical === targetNorm) {
                return {
                    match: {
                        ...result,
                        link: fetched.finalUrl || candidateUrl,
                        canonical,
                        matchedBy: candidateFinal === targetNorm ? "fetched-final-url" : "canonical"
                    },
                    verification: candidateFinal === targetNorm ? "fetched-final-url" : "canonical"
                };
            }
        } catch {}
    }
    return { match: null, verification: "not-verified" };
}

/* =========================================================
   EXPRESS SETUP
========================================================= */

// Number of reverse-proxy hops to trust when resolving req.ip (Render/Heroku/nginx = 1).
// If the app is exposed directly to the internet with NO proxy in front, set TRUST_PROXY=false,
// otherwise a client could spoof X-Forwarded-For. Accepts false, a hop count, or a subnet list.
const TRUST_PROXY_RAW = String(process.env.TRUST_PROXY ?? "1").trim();
app.set(
    "trust proxy",
    TRUST_PROXY_RAW.toLowerCase() === "false" ? false : (/^\d+$/.test(TRUST_PROXY_RAW) ? Number(TRUST_PROXY_RAW) : TRUST_PROXY_RAW)
);

app.use(compression({
    threshold: 1024,
    filter: (req, res) => req.headers["x-no-compression"] ? false : compression.filter(req, res)
}));

app.use(
    express.json({
        limit: process.env.JSON_BODY_LIMIT || "8mb"
    })
);


/* =========================================================
   POSTGRESQL AUTH
   Persistent users + sessions live in PostgreSQL. No auth state is
   kept in process memory or JSON files.
========================================================= */
const fs = require("fs");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, derived) => err ? reject(err) : resolve(`${salt}:${derived.toString("hex")}`)));
}
function verifyPassword(password, stored) {
    return new Promise((resolve, reject) => {
        const raw = String(stored || "").trim();
        const parts = raw.split(":");
        const salt = parts[0];
        const keyHex = parts[1];
        if (!salt || !keyHex || !/^[0-9a-f]+$/i.test(keyHex) || keyHex.length % 2 !== 0) return resolve(false);
        // Keep PostgreSQL accounts created by older SEO Agent builds working.
        // Older builds may have used a different scrypt output length; infer it
        // from the stored hash instead of assuming 64 bytes.
        const keyLength = Math.max(16, Math.min(128, Math.floor(keyHex.length / 2)));
        crypto.scrypt(password, salt, keyLength, (err, derived) => {
            if (err) return reject(err);
            const expected = Buffer.from(keyHex, "hex");
            resolve(expected.length === derived.length && crypto.timingSafeEqual(expected, derived));
        });
    });
}
function sessionTokenHash(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}
async function ensureAuthTables() {
    // PostgreSQL is the sole authentication store. This is intentionally
    // idempotent so a fresh database can start without a manual auth migration.
    await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await query(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username))`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email))`);
    await query(`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
    )`);
    await query(`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)`);
    await query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at TIMESTAMPTZ
    )`);
    await query(`CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx ON password_reset_tokens(expires_at)`);
    await query(`DROP TABLE IF EXISTS quiz_attempts`);
}


async function ensureApplicationSchema() {
    // The admin dashboard reads the same PostgreSQL tables written by the
    // application. Run the idempotent schema at startup so a fresh/partial
    // database cannot leave the admin panel full of 500 errors.
    const fs = require("fs");
    const schemaFiles = [
        path.join(__dirname, "db", "schema.sql"),
        path.join(__dirname, "db", "activity-schema.sql")
    ];
    for (const file of schemaFiles) {
        if (!fs.existsSync(file)) continue;
        const sql = fs.readFileSync(file, "utf8");
        if (sql.trim()) await query(sql);
    }
}

const SESSION_RETENTION_DAYS = Number(process.env.SESSION_RETENTION_DAYS) || 90;
async function purgeExpiredSessions() {
    try {
        const r = await query(`DELETE FROM sessions WHERE expires_at < NOW() - ($1::int * INTERVAL '1 day')`, [SESSION_RETENTION_DAYS]);
        if (r.rowCount) console.log(`Session cleanup: removed ${r.rowCount} expired session(s).`);
    } catch (e) { console.error("Session cleanup failed:", e.message); }
}

async function createSession(user) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    // Always create a fresh, explicitly active session. The activity migration
    // adds last_seen_at/ended_at; keeping the write here makes recovery/login
    // work consistently on upgraded databases as well as fresh databases.
    await query(`INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at, ended_at) VALUES ($1,$2,$3,NOW(),NULL)`, [sessionTokenHash(token), user.id, expiresAt]);
    return token;
}
async function currentSession(req) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const result = await query(`
        SELECT s.user_id, s.expires_at, u.username, u.email, u.role
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW() AND s.ended_at IS NULL
        LIMIT 1
    `, [sessionTokenHash(token)]);
    return result.rows[0] || null;
}
async function requireAgentUser(req, res) {
    try {
        const session = await currentSession(req);
        if (!session) {
            res.status(401).json({ success:false, error:"Please sign in to use this SEO Agent feature." });
            return null;
        }
        return { userId: session.user_id, username: session.username, email: session.email, role: session.role };
    } catch (error) {
        console.error("Session lookup failed:", error);
        res.status(503).json({ success:false, error:"Authentication service is temporarily unavailable." });
        return null;
    }
}
async function requireAdmin(req, res) {
    const user = await requireAgentUser(req, res);
    if (!user) return null;
    if (user.role !== "admin") {
        res.status(403).json({ success:false, error:"This account does not have admin access." });
        return null;
    }
    return user;
}
async function logAdminAction(adminUserId, action, targetType = null, targetId = null, metadata = {}) {
    try {
        await query(
            `INSERT INTO admin_audit_log (id, admin_user_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
            [crypto.randomUUID(), adminUserId, action, targetType, targetId, JSON.stringify(metadata || {})]
        );
    } catch (error) {
        console.error("Admin audit log write failed:", error);
    }
}

/* ---- Brute-force protection for authentication (in-memory, per instance) ---- */
function makeRateLimiter({ windowMs, max, message }) {
    const store = new Map();
    setInterval(() => { const now = Date.now(); for (const [k, r] of store) if (now - r.startedAt > windowMs) store.delete(k); }, 5 * 60 * 1000).unref();
    return function limiter(req, res, next) {
        const key = getClientIP(req), now = Date.now();
        let rec = store.get(key);
        if (!rec || now - rec.startedAt >= windowMs) { rec = { startedAt: now, count: 0 }; store.set(key, rec); }
        rec.count += 1;
        if (rec.count > max) {
            res.set("Retry-After", String(Math.ceil((windowMs - (now - rec.startedAt)) / 1000)));
            return res.status(429).json({ success: false, error: message });
        }
        next();
    };
}
const signupLimiter = makeRateLimiter({ windowMs: 60 * 60 * 1000, max: Number(process.env.SIGNUP_RATE_LIMIT_MAX) || 10, message: "Too many sign-up attempts from this network. Please try again later." });
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS_PER_IP = Number(process.env.LOGIN_MAX_FAILS_PER_IP) || 20;
const LOGIN_MAX_FAILS_PER_ACCOUNT_IP = Number(process.env.LOGIN_MAX_FAILS_PER_ACCOUNT_IP) || 8;
const loginFailures = new Map();
setInterval(() => { const now = Date.now(); for (const [k, r] of loginFailures) if (now - r.first > LOGIN_FAIL_WINDOW_MS) loginFailures.delete(k); }, 5 * 60 * 1000).unref();
function loginFailCount(key) {
    const r = loginFailures.get(key);
    if (!r) return 0;
    if (Date.now() - r.first > LOGIN_FAIL_WINDOW_MS) { loginFailures.delete(key); return 0; }
    return r.count;
}
function loginRecordFailure(...keys) {
    const now = Date.now();
    for (const key of keys) {
        const r = loginFailures.get(key);
        if (!r || now - r.first > LOGIN_FAIL_WINDOW_MS) loginFailures.set(key, { first: now, count: 1 });
        else r.count += 1;
    }
}
// Keyed by IP + identifier so an attacker cannot lock a victim out from another network.
const DUMMY_PASSWORD_HASH = "00112233445566778899aabbccddeeff:" + "00".repeat(64);

const passwordResetLimiter = makeRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.PASSWORD_RESET_RATE_LIMIT_MAX) || 8,
    message: "Too many password reset attempts. Please try again later."
});

/* Direct username-only recovery. No email, verification code, reset link, or existing session is required. */
app.post("/api/auth/reset-password", passwordResetLimiter, async (req, res) => {
    const username = String(req.body?.username || req.body?.identifier || "").trim();
    const password = String(req.body?.password || "");
    const confirm = String(req.body?.confirmPassword || "");
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) return res.status(400).json({success:false,error:"Enter the username for your account."});
    if (password.length < 8 || password.length > 256 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return res.status(400).json({success:false,error:"Password must be at least 8 characters and include a letter and a number."});
    if (password !== confirm) return res.status(400).json({success:false,error:"Passwords do not match."});
    try {
        const result = await query(`SELECT id, username, email, role FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`, [username]);
        if (!result.rows[0]) return res.status(404).json({success:false,error:"No user account was found with that username."});
        const userRow = result.rows[0];
        const passwordHash = await hashPassword(password);
        // Never store plaintext passwords. The new password is immediately written to password_hash.
        await query(`UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [passwordHash, userRow.id]);
        await query(`UPDATE sessions SET ended_at=NOW(), last_seen_at=NOW() WHERE user_id=$1 AND ended_at IS NULL`, [userRow.id]);
        const token = await createSession(userRow);
        await logLogin({ userId:userRow.id, event:"password_reset_login", identifier:userRow.username, req });
        const entitlement=(await query(`SELECT plan, plan_expires_at FROM users WHERE id=$1 LIMIT 1`,[userRow.id])).rows[0]||{};
        res.set("Cache-Control","no-store");
        res.json({success:true,message:"Password updated successfully.",token,user:{id:userRow.id,username:userRow.username,email:userRow.email,role:userRow.role,plan:entitlement.plan||"free",planExpiresAt:entitlement.plan_expires_at||null}});
    } catch (error) {
        console.error("Direct password reset error:", error);
        res.status(500).json({success:false,error:"Could not reset your password. Please try again."});
    }
});

app.post("/api/auth/signup", signupLimiter, async (req, res) => {
    try {
        const username = String(req.body?.username || "").trim();
        const email = String(req.body?.email || "").trim().toLowerCase();
        const password = String(req.body?.password || "");
        if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ success:false, error:"Username must be 3–24 characters and use letters, numbers or underscores." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success:false, error:"Enter a valid email address." });
        if (password.length > 256) return res.status(400).json({ success:false, error:"Password must be 256 characters or fewer." });
        if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return res.status(400).json({ success:false, error:"Password must be at least 8 characters and include a letter and a number." });
        const existing = await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2) LIMIT 1`, [username, email]);
        if (existing.rows.length) return res.status(409).json({ success:false, error:"That username or email is already registered." });
        const user = { id: crypto.randomUUID(), username, email, passwordHash: await hashPassword(password) };
        await query(`INSERT INTO users (id, username, email, password_hash, role, plan, plan_expires_at) VALUES ($1,$2,$3,$4,'user','trial',NOW() + INTERVAL '30 days')`, [user.id, user.username, user.email, user.passwordHash]);
        await logLogin({ userId:user.id, event:"signup", identifier:email, req });
        const token = await createSession(user);
        res.json({ success:true, token, user:{ id:user.id, username:user.username, email:user.email, role:"user" } });
    } catch (error) {
        if (error && error.code === "23505") return res.status(409).json({ success:false, error:"That username or email is already registered." });
        console.error("Signup error:", error);
        res.status(500).json({ success:false, error:"Could not create your account." });
    }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const identifier = String(req.body?.identifier || "").trim().toLowerCase().slice(0, 254);
        const password = String(req.body?.password || "").slice(0, 1024);
        const ipKey = `ip:${getClientIP(req)}`;
        const acctKey = `acct:${getClientIP(req)}|${identifier}`;
        if (loginFailCount(ipKey) >= LOGIN_MAX_FAILS_PER_IP || loginFailCount(acctKey) >= LOGIN_MAX_FAILS_PER_ACCOUNT_IP) {
            res.set("Retry-After", String(Math.ceil(LOGIN_FAIL_WINDOW_MS / 1000)));
            return res.status(429).json({ success:false, error:"Too many failed sign-in attempts. Please wait 15 minutes and try again." });
        }
        const result = await query(`SELECT id, username, email, password_hash, role, plan, plan_expires_at FROM users WHERE LOWER(email)=$1 OR LOWER(username)=$1 LIMIT 1`, [identifier]);
        const user = result.rows[0];
        if (!user) {
            // Burn the same scrypt cost as a real check so response time does not reveal which accounts exist.
            await verifyPassword(password, DUMMY_PASSWORD_HASH).catch(() => false);
            loginRecordFailure(ipKey, acctKey);
            await logLogin({ userId:null, event:"failed_login", identifier, req });
            return res.status(401).json({ success:false, error:"Incorrect username/email or password." });
        }
        const validPassword = await verifyPassword(password, user.password_hash);
        if (!validPassword) { loginRecordFailure(ipKey, acctKey); await logLogin({ userId:user.id, event:"failed_login", identifier, req }); return res.status(401).json({ success:false, error:"Incorrect username/email or password." }); }
        loginFailures.delete(acctKey);
        // If this is a legacy scrypt hash, transparently upgrade it after a
        // successful login while keeping the same PostgreSQL account.
        const storedHash = String(user.password_hash || "");
        const storedKey = storedHash.split(":")[1] || "";
        const token = await createSession(user);
        await logLogin({ userId:user.id, event:"login", req });
        if (user.role === "admin") await logAdminAction(user.id, "admin_login", "user", user.id, { username: user.username });
        res.json({ success:true, token, user:{ id:user.id, username:user.username, email:user.email, role:user.role, plan:user.plan||"free", planExpiresAt:user.plan_expires_at||null } });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ success:false, error:"Could not sign you in." });
    }
});

app.get("/api/auth/health", async (req, res) => {
    try { await query("SELECT 1"); res.set("Cache-Control","no-store").json({ success:true }); }
    catch (e) { res.status(503).json({ success:false, error:"Authentication database unavailable." }); }
});

app.get("/api/auth/me", async (req, res) => {
    try {
        const session = await currentSession(req);
        if (!session) return res.status(401).json({ success:false, error:"Session expired. Please sign in again." });
        const planRow = (await query(`SELECT plan, plan_expires_at FROM users WHERE id=$1 LIMIT 1`, [session.user_id])).rows[0] || {};
        res.set("Cache-Control", "no-store");
        res.json({ success:true, user:{ id:session.user_id, username:session.username, email:session.email, role:session.role, plan:planRow.plan||"free", planExpiresAt:planRow.plan_expires_at||null } });
    } catch (error) {
        res.status(503).json({ success:false, error:"Authentication service is temporarily unavailable." });
    }
});

app.post("/api/auth/logout", async (req, res) => {
    try {
        const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
        if (token) {
            const session = await currentSession(req).catch(()=>null);
            await query(`UPDATE sessions SET ended_at=NOW(), last_seen_at=NOW() WHERE token_hash=$1`, [sessionTokenHash(token)]);
            if (session) await logLogin({ userId:session.user_id, event:"logout", req });
        }
        res.json({success:true});
    } catch (error) {
        res.status(500).json({success:false, error:"Could not sign you out."});
    }
});

app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    next();
});

require("./lib/billing").install(app, { query, currentSession });
require("./lib/pro").install(app, { query, currentSession });

/* Log authenticated API requests after the response. Admin telemetry endpoints
   are excluded to avoid turning the dashboard refresh loop into user activity. */
app.use("/api", async (req,res,next)=>{
    const skip=req.path.startsWith("/admin/") || req.path.startsWith("/telemetry/") || req.path.startsWith("/auth/");
    const started=Date.now();
    res.on("finish", async ()=>{
        if(skip) return;
        try{
            const user=await telemetryUser(req); if(!user) return;
            await query(`UPDATE sessions SET last_seen_at=NOW(), last_path=$2 WHERE token_hash=$1`,[sessionTokenHash(telemetrySessionToken(req)),req.path.slice(0,500)]);
            await logActivity({userId:user.user_id,feature:featureForPath(req.path),method:req.method,path:req.path,statusCode:res.statusCode,success:res.statusCode<400,durationMs:Date.now()-started,req,metadata:{queryKeys:Object.keys(req.query||{})}});
        }catch(e){/* activity must never break requests */}
    });
    try {
        const user = await telemetryUser(req);
        return runWithContext({ userId: user?.user_id || null, feature: featureForPath(req.path) }, () => next());
    } catch (_) {
        return runWithContext({ userId: null, feature: featureForPath(req.path) }, () => next());
    }
});



/* =========================================================
   LIVE USER TELEMETRY + REQUEST ACTIVITY
   Tracks authenticated app usage without recording passwords,
   keystrokes, or form values. Pointer movement is aggregated.
========================================================= */
function telemetrySessionToken(req) {
    return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}
async function telemetryUser(req) {
    try {
        const token = telemetrySessionToken(req);
        if (!token) return null;
        const row = await query(`SELECT s.token_hash, s.user_id, s.expires_at, u.username, u.email, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND s.ended_at IS NULL LIMIT 1`, [sessionTokenHash(token)]);
        return row.rows[0] || null;
    } catch (_) { return null; }
}

app.post("/api/telemetry/heartbeat", async (req, res) => {
    const user = await telemetryUser(req);
    if (!user) return res.status(401).json({success:false,error:"Session expired."});
    try {
        const b=req.body||{}, tokenHash=sessionTokenHash(telemetrySessionToken(req));
        const pathValue=String(b.path||"").slice(0,500);
        const pageTitle=String(b.title||"").slice(0,200);
        const x=Number.isFinite(Number(b.x))?Math.max(0,Math.min(10000,Math.round(Number(b.x)))):null;
        const y=Number.isFinite(Number(b.y))?Math.max(0,Math.min(10000,Math.round(Number(b.y)))):null;
        const vw=Number.isFinite(Number(b.vw))?Math.max(0,Math.min(10000,Math.round(Number(b.vw)))):null;
        const vh=Number.isFinite(Number(b.vh))?Math.max(0,Math.min(10000,Math.round(Number(b.vh)))):null;
        const moves=Math.max(0,Math.min(100000,Number(b.mouseMoves)||0));
        const clicks=Math.max(0,Math.min(100000,Number(b.clicks)||0));
        const views=Math.max(0,Math.min(100000,Number(b.pageViews)||0));
        const idle=Math.max(0,Math.min(86400,Number(b.idleSeconds)||0));
        await query(`UPDATE sessions SET last_seen_at=NOW(), last_path=$2 WHERE token_hash=$1`,[tokenHash,pathValue]);
        await query(`INSERT INTO user_presence(user_id,session_token_hash,last_seen_at,page_path,page_title,cursor_x,cursor_y,viewport_width,viewport_height,mouse_moves,clicks,page_views,idle_seconds,updated_at)
                     VALUES($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
                     ON CONFLICT(user_id) DO UPDATE SET session_token_hash=EXCLUDED.session_token_hash,last_seen_at=EXCLUDED.last_seen_at,page_path=EXCLUDED.page_path,page_title=EXCLUDED.page_title,cursor_x=EXCLUDED.cursor_x,cursor_y=EXCLUDED.cursor_y,viewport_width=EXCLUDED.viewport_width,viewport_height=EXCLUDED.viewport_height,mouse_moves=user_presence.mouse_moves+EXCLUDED.mouse_moves,clicks=user_presence.clicks+EXCLUDED.clicks,page_views=user_presence.page_views+EXCLUDED.page_views,idle_seconds=EXCLUDED.idle_seconds,updated_at=NOW()`,
                     [user.user_id,tokenHash,pathValue,pageTitle,x,y,vw,vh,moves,clicks,views,idle]);
        res.json({success:true,receivedAt:new Date().toISOString()});
    } catch(e){ console.error("telemetry heartbeat:",e.message); res.status(500).json({success:false,error:"Telemetry update failed."}); }
});

app.post("/api/telemetry/events", async (req, res) => {
    const user = await telemetryUser(req);
    if (!user) return res.status(401).json({success:false,error:"Session expired."});
    try {
        const tokenHash=sessionTokenHash(telemetrySessionToken(req));
        const allowed=new Set(["page_view","click","feature_start","feature_complete","feature_error","idle_start","idle_end","visibility","session_start","session_end"]);
        const raw=Array.isArray(req.body?.events)?req.body.events.slice(0,50):[];
        for(const e of raw){
            const type=String(e?.type||""); if(!allowed.has(type)) continue;
            const metadata={};
            if(e?.feature) metadata.feature=String(e.feature).slice(0,120);
            if(e?.section) metadata.section=String(e.section).slice(0,120);
            if(e?.status) metadata.status=String(e.status).slice(0,80);
            const target=String(e?.target||"").slice(0,160);
            const pathValue=String(e?.path||"").slice(0,500);
            const duration=Math.max(0,Math.min(86400000,Number(e?.durationMs)||0));
            const x=Number.isFinite(Number(e?.x))?Math.round(Number(e.x)):null;
            const y=Number.isFinite(Number(e?.y))?Math.round(Number(e.y)):null;
            await query(`INSERT INTO ui_activity(id,user_id,session_token_hash,event_type,page_path,target,duration_ms,cursor_x,cursor_y,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[crypto.randomUUID(),user.user_id,tokenHash,type,pathValue,target,duration,x,y,JSON.stringify(metadata)]);
        }
        res.json({success:true,count:raw.length});
    } catch(e){ console.error("telemetry events:",e.message); res.status(500).json({success:false,error:"Activity event write failed."}); }
});

// Liveness (no dependencies) and readiness (database + Python engine) for load balancers / Render.
app.get("/healthz", (req, res) => res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) }));
app.get("/readyz", async (req, res) => {
    const checks = { database: false, pythonEngine: false };
    try { await dbHealth(); checks.database = true; } catch (_) {}
    try { const r = await fetch(`${PYTHON_SEO_ENGINE_URL}/health`, { signal: AbortSignal.timeout(3000) }); checks.pythonEngine = r.ok; } catch (_) {}
    const ready = checks.database; // the engine being down degrades features but should not take the site out of rotation
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        ),
        {
            maxAge: "5m",
            etag: true,
            lastModified: true
        }
    )
);

/* =========================================================
   CONFIG
========================================================= */

const FETCH_TIMEOUT_MS = 20000;

const MAX_REDIRECTS = 5;

const RATE_LIMIT_WINDOW_MS =
    10 * 60 * 1000;

const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 30;
// Separate, more generous bucket for the Python-engine proxy routes (crawl, rank, keywords...)
// which were previously completely unthrottled and could burn SerpApi quota.
const ENGINE_RATE_LIMIT_MAX_REQUESTS = Number(process.env.ENGINE_RATE_LIMIT_MAX_REQUESTS) || 120;
const engineRateLimitStore = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, r] of engineRateLimitStore) if (now - r.startedAt > RATE_LIMIT_WINDOW_MS) engineRateLimitStore.delete(k);
}, 5 * 60 * 1000).unref();
function engineRateLimiter(req, res, next) {
    const ip = getClientIP(req), now = Date.now();
    let rec = engineRateLimitStore.get(ip);
    if (!rec || now - rec.startedAt >= RATE_LIMIT_WINDOW_MS) { rec = { startedAt: now, count: 0 }; engineRateLimitStore.set(ip, rec); }
    rec.count += 1;
    if (rec.count > ENGINE_RATE_LIMIT_MAX_REQUESTS) {
        res.set("Retry-After", String(Math.ceil((RATE_LIMIT_WINDOW_MS - (now - rec.startedAt)) / 1000)));
        return res.status(429).json({ success: false, error: "Too many requests. Please wait a few minutes and try again." });
    }
    next();
}

const rateLimitStore = new Map();

/* Clean old rate-limit entries */
setInterval(
    () => {
        const now =
            Date.now();

        for (
            const [
                key,
                record
            ] of rateLimitStore
        ) {

            if (
                now -
                    record.startedAt >
                RATE_LIMIT_WINDOW_MS
            ) {

                rateLimitStore.delete(
                    key
                );
            }
        }
    },
    5 * 60 * 1000
).unref();

/* =========================================================
   RATE LIMITING
========================================================= */

function getClientIP(req) {
    // SECURITY: never read X-Forwarded-For directly. The left-most entry is fully
    // client-controlled, so trusting it let anyone bypass every rate limit by sending
    // a different fake header on each request. Express resolves the real client IP
    // from the trusted proxy hop (see app.set("trust proxy", ...)) into req.ip.
    return req.ip || req.socket?.remoteAddress || "unknown";
}

function aiRateLimiter(
    req,
    res,
    next
) {

    const ip =
        getClientIP(req);

    const now =
        Date.now();

    let record =
        rateLimitStore.get(ip);

    if (
        !record ||
        now -
            record.startedAt >=
            RATE_LIMIT_WINDOW_MS
    ) {

        record = {
            startedAt: now,
            count: 0
        };

        rateLimitStore.set(
            ip,
            record
        );
    }

    record.count += 1;

    if (
        record.count >
        RATE_LIMIT_MAX_REQUESTS
    ) {

        const retryAfter =
            Math.ceil(
                (
                    RATE_LIMIT_WINDOW_MS -
                    (
                        now -
                        record.startedAt
                    )
                ) / 1000
            );

        res.set(
            "Retry-After",
            String(
                retryAfter
            )
        );

        return res.status(
            429
        ).json({

            success: false,

            error:
                "Too many analysis requests. Please try again later."
        });
    }

    next();
}

/* =========================================================
   URL VALIDATION
========================================================= */

/*
 * CUSTOMIZABLE BLOCK 1 of 2: BARE-DOMAIN NORMALIZATION
 * ------------------------------------------------------
 * Lets a user type just "studyhours.com" instead of
 * "https://studyhours.com" — a scheme is added automatically
 * before the URL is parsed/validated below.
 *
 * To change the default scheme (e.g. force "http://" for an
 * internal tool), edit DEFAULT_URL_SCHEME only.
 */
const DEFAULT_URL_SCHEME =
    "https://";

const HAS_SCHEME_REGEX =
    /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;

function normalizeWebsiteInput(
    rawUrl
) {

    let url =
        typeof rawUrl ===
        "string"
            ? rawUrl.trim()
            : "";

    if (!url) {
        return url;
    }

    /* Already has a scheme (http://, https://, ftp://, etc.) — leave it alone. */
    if (
        HAS_SCHEME_REGEX.test(
            url
        )
    ) {

        return url;
    }

    /* Protocol-relative input ("//studyhours.com") — strip the leading slashes. */
    url =
        url.replace(
            /^\/\/+/,
            ""
        );

    return (
        DEFAULT_URL_SCHEME +
        url
    );
}

/*
 * CUSTOMIZABLE BLOCK 2 of 2: WEBSITE-NAME FORMAT CHECK
 * ------------------------------------------------------
 * Confirms the hostname actually looks like a real domain
 * (e.g. "studyhours.com") rather than a typo or a single word
 * (e.g. "studyhours", "studyhours,com", "studyhours..com").
 * This is a FORMAT check only — it does not confirm the site
 * is reachable. Reachability is already verified later by
 * assertSafeRemoteUrl() via a live DNS lookup.
 *
 * To allow single-label hosts (e.g. an internal "myapp/" host),
 * relax DOMAIN_NAME_REGEX below.
 */
const DOMAIN_NAME_REGEX =
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

function isValidHostnameFormat(
    hostname
) {

    /* Raw IPv4 / IPv6 addresses are handled separately by the SSRF checks. */
    if (
        net.isIP(
            hostname
        ) !== 0
    ) {

        return true;
    }

    return DOMAIN_NAME_REGEX.test(
        hostname
    );
}

function validateUrl(
    rawUrl
) {

    const url =
        normalizeWebsiteInput(
            rawUrl
        );

    if (!url) {
        throw new Error(
            "Please enter a website URL."
        );
    }

    if (
        url.length >
        2048
    ) {

        throw new Error(
            "The URL is too long."
        );
    }

    let parsedURL;

    try {

        parsedURL =
            new URL(url);

    } catch {

        throw new Error(
            "Invalid URL."
        );
    }

    if (
        parsedURL.protocol !==
            "http:" &&
        parsedURL.protocol !==
            "https:"
    ) {

        throw new Error(
            "Only HTTP and HTTPS URLs are supported."
        );
    }

    if (
        parsedURL.username ||
        parsedURL.password
    ) {

        throw new Error(
            "URLs containing embedded credentials are not supported."
        );
    }

    if (
        !parsedURL.hostname
    ) {

        throw new Error(
            "The URL does not contain a valid hostname."
        );
    }

    if (
        !isValidHostnameFormat(
            parsedURL.hostname
        )
    ) {

        throw new Error(
            "Please enter a valid website name, e.g. studyhours.com."
        );
    }

    return parsedURL.toString();
}

/* =========================================================
   SAFE HELPERS
========================================================= */

function safeArray(
    value
) {

    return Array.isArray(
        value
    )
        ? value
        : [];
}

/*
 * IMPORTANT:
 * This function must remain defined before
 * extractPageContent().
 */
function cleanText(
    value
) {

    return String(
        value || ""
    )
        .replace(
            /&nbsp;/gi,
            " "
        )
        .replace(
            /&amp;/gi,
            "&"
        )
        .replace(
            /&quot;/gi,
            '"'
        )
        .replace(
            /&#39;/gi,
            "'"
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

/* =========================================================
   PRIVATE / RESERVED IP PROTECTION
========================================================= */

function isPrivateIPv4(
    ip
) {

    const parts =
        ip
            .split(".")
            .map(
                Number
            );

    if (
        parts.length !== 4 ||
        parts.some(
            value =>
                !Number.isInteger(
                    value
                ) ||
                value < 0 ||
                value > 255
        )
    ) {

        return false;
    }

    const [
        a,
        b
    ] = parts;

    if (a === 0) {
        return true;
    }

    if (a === 10) {
        return true;
    }

    if (
        a === 100 &&
        b >= 64 &&
        b <= 127
    ) {
        return true;
    }

    if (a === 127) {
        return true;
    }

    if (
        a === 169 &&
        b === 254
    ) {
        return true;
    }

    if (
        a === 172 &&
        b >= 16 &&
        b <= 31
    ) {
        return true;
    }

    if (
        a === 192 &&
        b === 168
    ) {
        return true;
    }

    if (
        a === 192 &&
        b === 0
    ) {
        return true;
    }

    if (
        a === 198 &&
        (
            b === 18 ||
            b === 19
        )
    ) {
        return true;
    }

    if (
        a >= 224
    ) {
        return true;
    }

    return false;
}

function normalizeIPv6(
    ip
) {

    const value =
        String(
            ip || ""
        )
            .trim()
            .toLowerCase();

    if (
        value.startsWith(
            "::ffff:"
        )
    ) {

        const mapped =
            value.slice(7);

        if (
            net.isIP(
                mapped
            ) === 4
        ) {

            return {
                type:
                    "ipv4",
                value:
                    mapped
            };
        }
    }

    return {
        type:
            "ipv6",
        value
    };
}

function isPrivateIPv6(
    ip
) {

    const normalized =
        normalizeIPv6(ip);

    if (
        normalized.type ===
        "ipv4"
    ) {

        return isPrivateIPv4(
            normalized.value
        );
    }

    let value =
        normalized.value
            .split("%")[0];

    if (
        value === "::" ||
        value === "::1"
    ) {

        return true;
    }

    if (
        /^fe[89ab]/i.test(
            value
        )
    ) {

        return true;
    }

    if (
        /^f[cd]/i.test(
            value
        )
    ) {

        return true;
    }

    if (
        /^ff/i.test(
            value
        )
    ) {

        return true;
    }

    if (
        value.startsWith(
            "2001:db8:"
        )
    ) {

        return true;
    }

    return false;
}

function isPrivateOrReservedIP(
    ip
) {

    const type =
        net.isIP(ip);

    if (
        type === 4
    ) {

        return isPrivateIPv4(
            ip
        );
    }

    if (
        type === 6
    ) {

        return isPrivateIPv6(
            ip
        );
    }

    return false;
}

function isBlockedHostname(
    hostname
) {

    const value =
        String(
            hostname || ""
        )
            .toLowerCase()
            .replace(
                /\.$/,
                ""
            );

    if (!value) {
        return true;
    }

    if (
        value ===
            "localhost" ||
        value.endsWith(
            ".localhost"
        ) ||
        value.endsWith(
            ".local"
        ) ||
        value.endsWith(
            ".internal"
        )
    ) {

        return true;
    }

    return false;
}

async function assertSafeRemoteUrl(
    rawUrl
) {

    const url =
        validateUrl(
            rawUrl
        );

    const parsed =
        new URL(url);

    if (
        isBlockedHostname(
            parsed.hostname
        )
    ) {

        throw new Error(
            "This hostname is not allowed."
        );
    }

    const ipType =
        net.isIP(
            parsed.hostname
        );

    if (
        ipType !== 0
    ) {

        if (
            isPrivateOrReservedIP(
                parsed.hostname
            )
        ) {

            throw new Error(
                "Private or reserved IP addresses are not allowed."
            );
        }

        return url;
    }

    let addresses;

    try {

        addresses =
            await dns.lookup(
                parsed.hostname,
                {
                    all: true,
                    verbatim: true
                }
            );

    } catch {

        throw new Error(
            "The hostname could not be resolved."
        );
    }

    if (
        !addresses.length
    ) {

        throw new Error(
            "The hostname did not resolve to an IP address."
        );
    }

    for (
        const entry of addresses
    ) {

        if (
            isPrivateOrReservedIP(
                entry.address
            )
        ) {

            throw new Error(
                "The website resolves to a private or reserved IP address, which is not allowed."
            );
        }
    }

    return url;
}

/* =========================================================
   FETCH WEBSITE
========================================================= */

async function fetchWebpage(
    initialUrl
) {

    let currentUrl =
        await assertSafeRemoteUrl(
            initialUrl
        );

    console.log(
        "Fetching webpage:",
        currentUrl
    );

    for (
        let redirectCount = 0;
        redirectCount <=
            MAX_REDIRECTS;
        redirectCount += 1
    ) {

        const controller =
            new AbortController();

        const timeout =
            setTimeout(
                () => {
                    controller.abort();
                },
                FETCH_TIMEOUT_MS
            );

        try {

            const response =
                await fetch(
                    currentUrl,
                    {
                        method: "GET",

                        redirect:
                            "manual",

                        signal:
                            controller.signal,

                        headers: {

                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SEO-Agent/1.0",

                            "Accept":
                                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                            "Accept-Language":
                                "en-US,en;q=0.9"
                        }
                    }
                );

            if (
                response.status >=
                    300 &&
                response.status <
                    400
            ) {

                const location =
                    response.headers.get(
                        "location"
                    );

                if (
                    !location
                ) {

                    throw new Error(
                        "The website returned a redirect without a destination."
                    );
                }

                if (
                    redirectCount >=
                    MAX_REDIRECTS
                ) {

                    throw new Error(
                        "Too many redirects."
                    );
                }

                const nextUrl =
                    new URL(
                        location,
                        currentUrl
                    ).toString();

                currentUrl =
                    await assertSafeRemoteUrl(
                        nextUrl
                    );

                console.log(
                    "Following redirect:",
                    currentUrl
                );

                continue;
            }

            if (
                !response.ok
            ) {

                throw new Error(
                    `Website returned HTTP ${response.status}.`
                );
            }

            const contentType =
                response
                    .headers
                    .get(
                        "content-type"
                    ) || "";

            if (
                !contentType
                    .toLowerCase()
                    .includes(
                        "text/html"
                    )
            ) {

                throw new Error(
                    `The URL returned ${contentType || "an unsupported content type"}, not HTML.`
                );
            }

            const html =
                await response.text();

            if (
                !html.trim()
            ) {

                throw new Error(
                    "The webpage returned empty HTML."
                );
            }

            return {
                html,

                finalUrl:
                    currentUrl,

                contentType
            };

        } catch (
            error
        ) {

            if (
                error.name ===
                "AbortError"
            ) {

                throw new Error(
                    "The website took too long to respond."
                );
            }

            throw new Error(
                `Failed to fetch website: ${error.message}`
            );

        } finally {

            clearTimeout(
                timeout
            );
        }
    }

    throw new Error(
        "Unable to fetch the website."
    );
}

/* =========================================================
   EXTRACT PAGE CONTENT
========================================================= */

function extractPageContent(
    html,
    url
) {

    let source =
        String(
            html || ""
        );

    const titleMatch =
        source.match(
            /<title[^>]*>([\s\S]*?)<\/title>/i
        );

    const descriptionMatch =
        source.match(
            /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
        ) ||
        source.match(
            /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i
        );

    const canonicalMatch =
        source.match(
            /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
        );

    const robotsMatch =
        source.match(
            /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i
        ) ||
        source.match(
            /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']robots["']/i
        );

    const viewportMatch =
        source.match(
            /<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']*)["']/i
        ) ||
        source.match(
            /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']viewport["']/i
        );

    const h1 = [
        ...source.matchAll(
            /<h1[^>]*>([\s\S]*?)<\/h1>/gi
        )
    ]
        .map(
            match =>
                cleanText(
                    match[1]
                )
        )
        .filter(Boolean)
        .slice(0, 20);

    const h2 = [
        ...source.matchAll(
            /<h2[^>]*>([\s\S]*?)<\/h2>/gi
        )
    ]
        .map(
            match =>
                cleanText(
                    match[1]
                )
        )
        .filter(Boolean)
        .slice(0, 50);

    const h3 = [
        ...source.matchAll(
            /<h3[^>]*>([\s\S]*?)<\/h3>/gi
        )
    ]
        .map(
            match =>
                cleanText(
                    match[1]
                )
        )
        .filter(Boolean)
        .slice(0, 50);

    const images = [
        ...source.matchAll(
            /<img\b[^>]*>/gi
        )
    ]
        .slice(0, 100)
        .map(
            match => {

                const tag =
                    match[0];

                const srcMatch =
                    tag.match(
                        /\bsrc=["']([^"']*)["']/i
                    );

                const altMatch =
                    tag.match(
                        /\balt=["']([^"']*)["']/i
                    );

                return {
                    src:
                        srcMatch
                            ? srcMatch[1]
                            : "",

                    alt:
                        altMatch
                            ? altMatch[1]
                            : ""
                };
            }
        );

    const links = [
        ...source.matchAll(
            /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
        )
    ]
        .slice(0, 150)
        .map(
            match => ({

                href:
                    match[1] ||
                    "",

                text:
                    cleanText(
                        match[2] ||
                        ""
                    )
            })
        );

    const structuredData = [
        ...source.matchAll(
            /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
        )
    ]
        .map(
            match =>
                match[1].trim()
        )
        .filter(Boolean)
        .slice(0, 10);

    let text =
        source
            .replace(
                /<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi,
                " "
            )
            .replace(
                /<[^>]+>/g,
                " "
            );

    text =
        cleanText(
            text
        );

    return {

        url:
            url || "",

        finalUrl:
            url || "",

        title:
            titleMatch
                ? cleanText(
                    titleMatch[1]
                )
                : "",

        metaDescription:
            descriptionMatch
                ? cleanText(
                    descriptionMatch[1]
                )
                : "",

        canonical:
            canonicalMatch
                ? canonicalMatch[1]
                : "",

        robots:
            robotsMatch
                ? cleanText(
                    robotsMatch[1]
                )
                : "",

        viewport:
            viewportMatch
                ? cleanText(
                    viewportMatch[1]
                )
                : "",

        structuredData:
            safeArray(
                structuredData
            ),

        h1:
            safeArray(h1),

        h2:
            safeArray(h2),

        h3:
            safeArray(h3),

        images:
            safeArray(images),

        links:
            safeArray(links),

        text:
            text || ""
    };
}

/* =========================================================
   GEMINI
========================================================= */

const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60000;
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function isTransientAiError(error) {
    const msg = String(error?.message || error || "");
    return /\b(429|500|502|503|504)\b|overloaded|unavailable|rate.?limit|timed out|ECONNRESET|ETIMEDOUT|fetch failed|quota/i.test(msg);
}

async function generateGroq(prompt, maxOutputTokens = 1400, temperature = 0.1) {
    if (!GROQ_API_KEY) throw new Error("Groq is not configured. Add GROQ_API_KEY to .env.");
    const startedAt = Date.now();
    try {
        const response = await fetch(GROQ_BASE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
            body: JSON.stringify({ model: GROQ_MODEL, temperature, max_tokens: maxOutputTokens, messages: [{ role: "user", content: String(prompt || "") }] }),
            signal: AbortSignal.timeout(AI_TIMEOUT_MS)
        });
        const data = await response.json().catch(() => ({}));
        const durationMs = Date.now() - startedAt;
        if (!response.ok) {
            const detail = data?.error?.message || data?.error || `Groq returned HTTP ${response.status}.`;
            await logApiUsage({ userId: currentUserId(), provider: "groq", operation: "chat.completions", success: false, durationMs, tokensEstimate: estimateTokens(prompt), errorMessage: String(detail).slice(0,500), metadata: { model: GROQ_MODEL, feature: currentFeature() } });
            throw new Error(String(detail));
        }
        const text = data?.choices?.[0]?.message?.content || "";
        if (!String(text).trim()) throw new Error("Groq returned an empty response.");
        const usage = data?.usage || {};
        await logApiUsage({ userId: currentUserId(), provider: "groq", operation: "chat.completions", success: true, durationMs, tokensEstimate: Number(usage.total_tokens || estimateTokens(prompt, text)), metadata: { model: GROQ_MODEL, feature: currentFeature() } });
        return String(text).trim();
    } catch (error) {
        if (!String(error?.message || "").includes("Groq returned")) {
            await logApiUsage({ userId: currentUserId(), provider: "groq", operation: "chat.completions", success: false, durationMs: Date.now()-startedAt, tokensEstimate: estimateTokens(prompt), errorMessage: String(error.message || error).slice(0,500), metadata: { model: GROQ_MODEL, feature: currentFeature() } });
        }
        throw error;
    }
}

async function generateAI(prompt, maxOutputTokens = 1400, temperature = 0.1) {
    const startedAt = Date.now();
    if (ai) {
        try {
            let response;
            for (let attempt = 0; ; attempt++) {
                try {
                    response = await withTimeout(ai.models.generateContent({ model: MODEL, contents: prompt, config: { temperature, maxOutputTokens } }), AI_TIMEOUT_MS, "Gemini");
                    break;
                } catch (err) {
                    // One quick retry for transient overload / rate-limit errors before falling back to Groq.
                    if (attempt >= 1 || !isTransientAiError(err)) throw err;
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
            const text = response.text || "";
            if (text.trim()) {
                await logApiUsage({ userId: currentUserId(), provider: "gemini", operation: "generateContent", success: true, durationMs: Date.now()-startedAt, tokensEstimate: estimateTokens(prompt,text), metadata: { model: MODEL, feature: currentFeature() } });
                return text.trim();
            }
            throw new Error("Gemini returned an empty response.");
        } catch (error) {
            await logApiUsage({ userId: currentUserId(), provider: "gemini", operation: "generateContent", success: false, durationMs: Date.now()-startedAt, tokensEstimate: estimateTokens(prompt), errorMessage: String(error.message || error).slice(0,500), metadata: { model: MODEL, feature: currentFeature() } });
            if (!GROQ_API_KEY) throw error;
            console.warn("Gemini failed; using Groq fallback:", error.message);
        }
    } else if (!GROQ_API_KEY) {
        throw new Error("No AI provider is configured. Add GEMINI_API_KEY or GROQ_API_KEY to .env.");
    }
    return generateGroq(prompt, maxOutputTokens, temperature);
}

/* =========================================================
   JSON PARSING
========================================================= */

function parseModelJSON(
    text
) {

    const cleaned =
        String(
            text || ""
        )
            .replace(
                /^```json\s*/i,
                ""
            )
            .replace(
                /^```\s*/i,
                ""
            )
            .replace(
                /\s*```$/i,
                ""
            )
            .trim();

    try {

        return JSON.parse(
            cleaned
        );

    } catch {

        const start =
            cleaned.indexOf(
                "{"
            );

        const end =
            cleaned.lastIndexOf(
                "}"
            );

        if (
            start !== -1 &&
            end > start
        ) {

            try {

                return JSON.parse(
                    cleaned.slice(
                        start,
                        end + 1
                    )
                );

            } catch {
                // continue
            }
        }

        throw new Error(
            "Gemini returned invalid JSON."
        );
    }
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/api/health",
    (
        req,
        res
    ) => {

        res.json({

            success:
                true,

            status:
                "online",

            agent:
                "SEO Agent",

            model:
                MODEL
        });
    }
);

/* =========================================================
   DASHBOARD
========================================================= */


/* =========================================================
   PYTHON SEO ENGINE — SINGLE SOURCE OF TRUTH
   All measurable SEO/analysis sections are routed through the
   FastAPI engine. Node remains the web/auth/export shell.
========================================================= */
const PYTHON_SEO_ENDPOINTS = new Set([
    "analyze","site-audit","keywords","content-gap","rank-check",
    "top-rankings","competitors","seo-actions","crawl","rank-track",
    "keyword-opportunity","keyword-verify","content-plan",
    "verify-url","internal-link-opportunities",
    "monitor-snapshot","domain-authority","technical-check",
    "gsc-import"
]);

app.use("/api", async (req, res, next) => {
    if (req.method !== "POST") return next();
    const endpoint = String(req.path || "").replace(/^\/+/, "");
    if (!PYTHON_SEO_ENDPOINTS.has(endpoint)) return next();
    let limited = true;
    engineRateLimiter(req, res, () => { limited = false; });
    if (limited) return;
    try {
        const response = await fetch(`${PYTHON_SEO_ENGINE_URL}/${endpoint}`, {
            method: "POST",
            headers: engineHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(req.body || {}),
            signal: AbortSignal.timeout(190000)
        });
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); } catch {
            return res.status(502).json({success:false,error:"Python SEO Engine returned invalid JSON.",details:raw.slice(0,500)});
        }
        return res.status(response.status).json(data);
    } catch (error) {
        console.error(`PYTHON SEO ENGINE ERROR [${endpoint}]:`, error);
        return res.status(502).json({
            success:false,
            error:`Could not reach the Python SEO Engine at ${PYTHON_SEO_ENGINE_URL}.`,
            details:error.message
        });
    }
});

function deterministicDashboardScore(evidence) {
    // Dashboard evidence is intentionally narrower than the full Python audit.
    // Score only signals actually measured here and cap a score when the evidence
    // set is incomplete, so an AI response can never turn missing measurements into
    // a false 100/100.
    const checks = [
        { status: /^https:\/\//i.test(String(evidence.url || "")) ? "pass" : "fail", weight: 8 },
        { status: "pass", weight: 12 }, // HTTP status is verified by fetchWebpage()
        { status: evidence.title ? (evidence.title.length >= 30 && evidence.title.length <= 60 ? "pass" : "warning") : "fail", weight: 10 },
        { status: evidence.metaDescription ? (evidence.metaDescription.length >= 70 && evidence.metaDescription.length <= 170 ? "pass" : "warning") : "fail", weight: 8 },
        { status: Array.isArray(evidence.h1) && evidence.h1.length === 1 ? "pass" : (Array.isArray(evidence.h1) && evidence.h1.length > 1 ? "warning" : "fail"), weight: 10 },
        { status: Number(evidence.wordCount || 0) >= 300 ? "pass" : "warning", weight: 5 },
        { status: Number(evidence.internalLinks || 0) > 0 ? "pass" : "warning", weight: 6 },
        { status: evidence.hasViewport ? "pass" : "warning", weight: 3 },
        { status: Number(evidence.images || 0) === 0 || Number(evidence.imagesMissingAlt || 0) === 0 ? "pass" : "warning", weight: 5 },
        { status: evidence.canonical ? "pass" : "info", weight: 2 },
        { status: evidence.structuredDataCount > 0 ? "pass" : "info", weight: 1 }
    ];
    const scored = checks.filter(c => c.status !== "info");
    const total = scored.reduce((n, c) => n + c.weight, 0);
    const earned = scored.reduce((n, c) => n + (c.status === "pass" ? c.weight : c.status === "warning" ? c.weight * 0.35 : 0), 0);
    let score = total ? Math.round((earned / total) * 100) : 0;
    const incomplete = checks.some(c => c.status === "info");
    if (incomplete && score >= 100) score = 99;
    return { score: Math.max(0, Math.min(100, score)), incomplete, measured: checks.length, scored: scored.length };
}

app.post(
    "/api/analyze",
    aiRateLimiter,
    async (req, res) => {
        try {
            const url = validateUrl(req.body.url);
            const fetched = await fetchWebpage(url);
            const page = extractPageContent(fetched.html, fetched.finalUrl);
            const wordCount = cleanText(page.text).split(/\s+/).filter(Boolean).length;
            const internalLinks = safeArray(page.links).filter(l => {
                const u = normalizeAbsoluteLink(l.href, page.finalUrl);
                return u && hostsMatch(hostnameFromLink(u), hostnameFromLink(page.finalUrl));
            }).length;
            const evidence = {
                url: page.finalUrl,
                title: page.title || "",
                metaDescription: page.metaDescription || "",
                h1: safeArray(page.h1),
                h2: safeArray(page.h2),
                h3: safeArray(page.h3),
                wordCount,
                internalLinks,
                images: safeArray(page.images).length,
                imagesMissingAlt: safeArray(page.images).filter(img => !cleanText(img.alt)).length,
                canonical: page.canonical || "",
                robots: page.robots || "",
                hasViewport: !!page.viewport,
                structuredDataCount: safeArray(page.structuredData).length,
                textExcerpt: cleanText(page.text).slice(0, 2500)
            };
            const deterministic = deterministicDashboardScore(evidence);
            const prompt = `You are a senior SEO auditor. Analyze ONLY the verified crawl evidence below.
Do not claim rankings, search volume, traffic, backlinks, Search Console data, or competitor facts.
Do not assume a missing field is a failure if it was not observable. Distinguish "verified", "not detected", and "not measurable".
Return concise professional findings grounded in exact evidence.

VERIFIED CRAWL EVIDENCE:
${JSON.stringify(evidence, null, 2)}

AUTHORITATIVE SCORE: ${deterministic.score}/100. Evidence coverage: ${deterministic.scored}/${deterministic.measured} measurable checks; some optional signals may be not detected. Do not output a different score.

Return:
SEO_SCORE: ${deterministic.score}
CRITICAL_ISSUES: number
WARNINGS: number
PASSED: number
SUMMARY:
maximum 2 sentences
FINDINGS:
- CRITICAL | issue | evidence-based explanation
- WARNING | issue | evidence-based explanation
- PASSED | item | evidence-based explanation
TOP_ACTIONS:
1. ...
2. ...
3. ...
KEYWORD_OPPORTUNITIES:
- topic
- topic
- topic`;
            const text = await generateAI(prompt, 1600, 0.1);
            if (!text.trim()) throw new Error("Gemini returned an empty response.");
            const normalizedText = String(text).replace(/SEO_SCORE\s*:\s*-?\d+/i, `SEO_SCORE: ${deterministic.score}`);
            res.json({ success: true, url: page.finalUrl, evidence, score: deterministic.score, score_complete: !deterministic.incomplete, text: normalizedText });
        } catch (error) {
            console.error("DASHBOARD ANALYSIS ERROR:", error);
            res.status(500).json({ success: false, error: error.message || "SEO analysis failed." });
        }
    }
);

/* =========================================================
   SITE AUDIT
========================================================= */

app.post(
    "/api/site-audit",
    aiRateLimiter,
    async (req,res) => {
        try {
            const url = validateUrl(req.body?.url);
            const section = String(req.body?.section || "all").toLowerCase();
            const allowed = new Set(["all","technical","onpage","indexing"]);
            if (!allowed.has(section)) return res.status(400).json({success:false,error:"Invalid audit section."});
            // Python is the deterministic evidence source for all measurable SEO
            // checks. Do not ask Gemini to invent/format audit facts. This also
            // removes the old invalid-JSON failure mode and keeps scoring consistent.
            const data = await pythonPost("site-audit",{url,section});
            return res.json(data);
        } catch (error) {
            console.error("SITE AUDIT ERROR:",error);
            return res.status(502).json({success:false,error:error.message || "Site audit failed."});
        }
    }
);

/* =========================================================
   KEYWORDS
========================================================= */

app.post(
    "/api/keywords",
    aiRateLimiter,
    async (
        req,
        res
    ) => {

        try {

            const url =
                validateUrl(
                    req.body.url
                );

            const seed =
                typeof req.body.seed ===
                "string"
                    ? req.body.seed.trim()
                    : "";

            const intent =
                typeof req.body.intent ===
                "string"
                    ? req.body.intent.trim()
                    : "all";

            const excludeKeywords =
                Array.isArray(
                    req.body.excludeKeywords
                )

                    ? req.body
                        .excludeKeywords

                        .filter(
                            item =>
                                typeof item ===
                                "string"
                        )

                        .map(
                            item =>
                                item
                                    .trim()
                                    .toLowerCase()
                        )

                        .filter(
                            Boolean
                        )

                        .slice(
                            0,
                            200
                        )

                    : [];

            const batch =
                Number.isFinite(
                    Number(
                        req.body.batch
                    )
                )
                    ? Number(
                        req.body.batch
                    )
                    : 1;

            console.log(
                "Keyword analysis:",
                url,
                "batch:",
                batch,
                "excluded:",
                excludeKeywords.length
            );

            const fetched =
                await fetchWebpage(
                    url
                );

            const page =
                extractPageContent(
                    fetched.html,
                    fetched.finalUrl
                );

            const country = resolveCountry(req.body.country);
            const researchTerm = seed || safeArray(page.h1)[0] || page.title;
            const liveInsights = await fetchSerpInsights(researchTerm, {
                num: 10,
                gl: country.gl,
                hl: country.hl,
                google_domain: country.google_domain
            });

            const prompt = `
You are a senior SEO keyword strategist.

Analyze this exact webpage and generate a FRESH batch
of keyword opportunities.

URL:
${page.finalUrl}

TITLE:
${page.title}

META DESCRIPTION:
${page.metaDescription}

H1:
${safeArray(
    page.h1
).join("\n")}

H2:
${safeArray(
    page.h2
).join("\n")}

PAGE TEXT:
${page.text}

OPTIONAL SEED KEYWORD:
${seed || "None"}

REQUESTED INTENT:
${intent}

BATCH NUMBER:
${batch}

LIVE GOOGLE SIGNALS FOR THE SEED/TOPIC (${country.label}):
Related searches: ${liveInsights.relatedSearches.join(" | ") || "none"}
People also ask: ${liveInsights.relatedQuestions.join(" | ") || "none"}
Top organic result titles: ${liveInsights.organic.slice(0,10).map(r => r.title).join(" | ") || "none"}

KEYWORDS ALREADY SHOWN:
${
    excludeKeywords.length
        ? excludeKeywords.join(
            "\n"
        )
        : "None"
}

FRESHNESS RULES:

1. Return genuinely new opportunities.
2. Never repeat an excluded keyword.
3. Do not lightly rephrase excluded keywords.
4. Keep every keyword tightly relevant to the webpage.
5. The seed is a starting point, not something to repeat mechanically.
6. Explore different useful search angles.
7. Consider:
   - service variations
   - audience variations
   - subject variations
   - use cases
   - problems solved
   - long-tail searches
   - FAQs
   - comparisons
   - local intent when genuinely relevant
8. Do not introduce unrelated topics merely because
   the seed phrase can be inserted into them.

Do NOT invent:

- Search volume
- CPC
- Keyword difficulty
- Rankings
- Traffic
- Backlinks

Return ONLY valid JSON:

{
  "keywords": [
    {
      "keyword": "string",
      "topic": "string",
      "priority": "High | Medium | Low",
      "intent": "Informational | Commercial | Transactional | Navigational",
      "recommendation": "Title | H1 | H2 | Body | FAQ | Supporting page"
    }
  ]
}

Return 12 to 18 fresh opportunities.
`;

            const text =
                await generateAI(
                    prompt,
                    1900,
                    0.65
                );

            const result =
                parseModelJSON(
                    text
                );

            const seen =
                new Set(
                    excludeKeywords
                );

            const freshKeywords =
                Array.isArray(
                    result &&
                    result.keywords
                )

                    ? result
                        .keywords
                        .filter(
                            item => {

                                if (
                                    !item ||
                                    typeof item.keyword !==
                                        "string"
                                ) {

                                    return false;
                                }

                                const key =
                                    item
                                        .keyword
                                        .trim()
                                        .toLowerCase();

                                if (
                                    !key ||
                                    seen.has(
                                        key
                                    )
                                ) {

                                    return false;
                                }

                                seen.add(
                                    key
                                );

                                return true;
                            }
                        )
                        .slice(
                            0,
                            18
                        )

                    : [];

            res.json({

                success:
                    true,

                keywords:
                    freshKeywords,

                batch,
                research: {
                    source: "Live Google SERP via SerpApi + page crawl + Gemini classification",
                    country: { code: country.code, label: country.label },
                    seed: researchTerm,
                    relatedSearches: liveInsights.relatedSearches,
                    relatedQuestions: liveInsights.relatedQuestions
                }
            });

        } catch (
            error
        ) {

            console.error(
                "KEYWORD ERROR:",
                error
            );

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    "Keyword analysis failed."
            });
        }
    }
);

/* =========================================================
   CONTENT
========================================================= */

app.post(
    "/api/content",
    aiRateLimiter,
    async (
        req,
        res
    ) => {

        try {

            const url =
                validateUrl(
                    req.body.url
                );

            const goal =
                typeof req.body.goal ===
                "string"
                    ? req.body.goal.trim()
                    : "improve-existing";

            const tone =
                typeof req.body.tone ===
                "string"
                    ? req.body.tone.trim()
                    : "professional";

            const topic =
                typeof req.body.topic ===
                "string"
                    ? req.body.topic.trim()
                    : "";

            console.log(
                "Content analysis:",
                url
            );

            const fetched =
                await fetchWebpage(
                    url
                );

            const page =
                extractPageContent(
                    fetched.html,
                    fetched.finalUrl
                );

            const prompt = `
You are a senior SEO content strategist.

Analyze this webpage.

URL:
${page.finalUrl}

TITLE:
${page.title}

META DESCRIPTION:
${page.metaDescription}

H1:
${safeArray(
    page.h1
).join("\n")}

H2:
${safeArray(
    page.h2
).join("\n")}

PAGE TEXT:
${page.text}

CONTENT GOAL:
${goal}

TONE:
${tone}

OPTIONAL TOPIC:
${topic || "Derive from the webpage"}

Create a professional SEO content brief.

Do NOT invent:

- rankings
- traffic
- search volume
- backlinks
- Search Console data

Return ONLY valid JSON:

{
  "primary_intent": "string",
  "angle": "string",
  "title": "string",
  "meta_description": "string",
  "headings": [
    "H1: ...",
    "H2: ...",
    "H2: ..."
  ],
  "entities": [
    "topic",
    "topic"
  ],
  "ctas": [
    "CTA",
    "CTA"
  ]
}

Provide:

- one strong title
- one meta description
- 6 to 10 headings
- 5 to 10 entity/topic suggestions
- 2 to 4 CTA ideas
`;

            const text =
                await generateAI(
                    prompt,
                    1700,
                    0.1
                );

            const brief =
                parseModelJSON(
                    text
                );
            const draftPrompt = `You are an expert SEO content writer. Using ONLY the verified webpage context below, create a useful original content draft that improves topical coverage and search intent. Do not invent rankings, traffic, search volume, backlinks, or Search Console data. Write approximately 700-1000 words with a clear H1, H2/H3 sections, concise paragraphs, useful bullets, and a natural CTA. Topic: ${topic || page.title || (page.h1[0] || "the page topic")}. Goal: ${goal}. Tone: ${tone}. Existing title: ${page.title}. Existing H1: ${safeArray(page.h1).join(" | ")}. Existing headings: ${safeArray(page.h2).join(" | ")}. Existing content excerpt: ${page.text.slice(0,7000)}`;
            const draft = await generateAI(draftPrompt, 2600, 0.4);

            res.json({

                success:
                    true,

                brief: {

                    primary_intent:
                        brief &&
                        brief.primary_intent
                            ? brief.primary_intent
                            : "",

                    angle:
                        brief &&
                        brief.angle
                            ? brief.angle
                            : "",

                    title:
                        brief &&
                        brief.title
                            ? brief.title
                            : "",

                    meta_description:
                        brief &&
                        brief.meta_description
                            ? brief.meta_description
                            : "",

                    headings:
                        Array.isArray(
                            brief &&
                            brief.headings
                        )
                            ? brief.headings
                            : [],

                    entities:
                        Array.isArray(
                            brief &&
                            brief.entities
                        )
                            ? brief.entities
                            : [],

                    ctas:
                        Array.isArray(
                            brief &&
                            brief.ctas
                        )
                            ? brief.ctas
                            : []
                },
                draft
            });

        } catch (
            error
        ) {

            console.error(
                "CONTENT ERROR:",
                error
            );

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    "Content generation failed."
            });
        }
    }
);

/* =========================================================
   CONTENT GAP ANALYSIS
========================================================= */

app.post(
    "/api/content-gap",
    aiRateLimiter,
    async (
        req,
        res
    ) => {

        try {

            const url =
                validateUrl(
                    req.body.url
                );

            const topic =
                typeof req.body.topic ===
                "string"
                    ? req.body.topic.trim()
                    : "";

            const tone =
                typeof req.body.tone ===
                "string"
                    ? req.body.tone.trim()
                    : "professional";

            console.log(
                "Content gap analysis:",
                url
            );

            const fetched =
                await fetchWebpage(
                    url
                );

            const page =
                extractPageContent(
                    fetched.html,
                    fetched.finalUrl
                );

            const prompt = `
You are a senior SEO content strategist specializing in content gap analysis.

Analyze this webpage to find CONTENT GAPS: important subtopics, questions,
and supporting information that a thorough, expert-level resource on this
subject would normally include, but that this page currently does not cover,
or covers only briefly.

URL:
${page.finalUrl}

TITLE:
${page.title}

META DESCRIPTION:
${page.metaDescription}

H1:
${safeArray(
    page.h1
).join("\n")}

H2:
${safeArray(
    page.h2
).join("\n")}

H3:
${safeArray(
    page.h3
).join("\n")}

PAGE TEXT:
${page.text}

FOCUS TOPIC (use if provided, otherwise infer the page's main topic):
${topic || "Infer the primary topic from the page content above"}

TONE FOR WRITTEN CONTENT:
${tone}

Identify content gaps by comparing what the page currently covers against
what a comprehensive, expert-level resource on this topic would typically
include: missing subtopics, unanswered user questions, missing definitions
or examples, missing comparisons, missing use cases, missing FAQs, or
missing supporting sections that would improve topical depth and search
intent coverage.

Do NOT invent:

- rankings
- traffic
- search volume
- backlinks
- Google Search Console data
- named competitor URLs or unverifiable brand claims

For EACH content gap, write ready-to-publish replacement content that could
be inserted directly into the page to close that gap: well-structured,
factually careful, written in the requested tone, free of invented
statistics, and written in full paragraphs (with a short bullet list only
where genuinely useful).

Return ONLY valid JSON:

{
  "page_topic": "string",
  "coverage_summary": "2-3 sentence summary of how completely the page currently covers the topic",
  "gaps": [
    {
      "gap_title": "short name of the missing subtopic",
      "priority": "high | medium | low",
      "why_it_matters": "1-2 sentences on why this gap hurts SEO or user value",
      "suggested_heading": "a heading to add to the page, e.g. H2: ...",
      "search_intent": "informational | commercial | transactional | navigational",
      "fill_content": "200 to 350 words of ready-to-publish content that fills this gap"
    }
  ]
}

Return between 4 and 6 gaps, ordered from highest to lowest priority.
Keep the JSON valid and parsable.
`;

            const text =
                await generateAI(
                    prompt,
                    3500,
                    0.3
                );

            const result =
                parseModelJSON(
                    text
                );

            const gaps =
                Array.isArray(
                    result &&
                    result.gaps
                )
                    ? result.gaps
                        .filter(
                            item =>
                                item &&
                                typeof item.gap_title ===
                                    "string"
                        )
                        .slice(
                            0,
                            8
                        )
                    : [];

            res.json({

                success:
                    true,

                gapAnalysis: {

                    page_topic:
                        result &&
                        result.page_topic
                            ? result.page_topic
                            : "",

                    coverage_summary:
                        result &&
                        result.coverage_summary
                            ? result.coverage_summary
                            : "",

                    gaps
                }
            });

        } catch (
            error
        ) {

            console.error(
                "CONTENT GAP ERROR:",
                error
            );

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    "Content gap analysis failed."
            });
        }
    }
);

/* =========================================================
   RANK CHECK (your site's position for a keyword)
========================================================= */

app.post(
    "/api/rank-check",
    aiRateLimiter,
    async (
        req,
        res
    ) => {

        try {

            const url =
                validateUrl(
                    req.body.url
                );

            const keyword =
                typeof req.body.keyword ===
                "string"
                    ? req.body.keyword.trim()
                    : "";

            if (!keyword) {

                throw new Error(
                    "Please provide a keyword to check."
                );
            }

            const siteHostname =
                new URL(
                    url
                ).hostname;

            const country =
                resolveCountry(
                    req.body.country
                );

            console.log(
                "Rank check:",
                keyword,
                "|",
                siteHostname,
                "|",
                country.label
            );

            const results =
                await fetchSerpResults(
                    keyword,
                    {
                        num:
                            RANK_CHECK_SCAN_DEPTH,
                        gl: country.gl,
                        hl: country.hl,
                        google_domain: country.google_domain
                    }
                );

            let matchDepth = results.length;
            let matched = findExactPageMatch(results, url);
            const domainMatch = matched || findRankMatch(results, siteHostname);
            if (!matched && results.length < 100) {
                const deepResults = await fetchSerpResults(keyword, {
                    num: 100, gl: country.gl, hl: country.hl, google_domain: country.google_domain
                });
                matchDepth = deepResults.length;
                matched = findExactPageMatch(deepResults, url);
                if (deepResults.length > results.length) results.splice(0, results.length, ...deepResults);
            }

            res.json({

                success:
                    true,

                keyword,

                url,

                siteHostname,

                country:
                    { code: country.code, label: country.label },

                scannedResults:
                    matchDepth,

                ranked:
                    !!matched,

                position:
                    matched
                        ? matched.position
                        : null,

                matchedResult:
                    matched ||
                    null,

                domainPosition:
                    domainMatch ? domainMatch.position : null,

                topResults:
                    results.slice(
                        0,
                        10
                    )
            });

        } catch (
            error
        ) {

            console.error(
                "RANK CHECK ERROR:",
                error
            );

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    "Rank check failed."
            });
        }
    }
);

/* =========================================================
   TOP RANKINGS (top pages for a keyword, no site required)
========================================================= */

app.post(
    "/api/top-rankings",
    aiRateLimiter,
    async (
        req,
        res
    ) => {

        try {

            const keyword =
                typeof req.body.keyword ===
                "string"
                    ? req.body.keyword.trim()
                    : "";

            if (!keyword) {

                throw new Error(
                    "Please provide a keyword."
                );
            }

            const country =
                resolveCountry(
                    req.body.country
                );

            console.log(
                "Top rankings:",
                keyword,
                "|",
                country.label
            );

            const results =
                await fetchSerpResults(
                    keyword,
                    {
                        num:
                            TOP_RANKINGS_RESULT_COUNT,
                        gl: country.gl,
                        hl: country.hl,
                        google_domain: country.google_domain
                    }
                );

            res.json({

                success:
                    true,

                keyword,

                country:
                    { code: country.code, label: country.label },

                results
            });

        } catch (
            error
        ) {

            console.error(
                "TOP RANKINGS ERROR:",
                error
            );

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    "Fetching top rankings failed."
            });
        }
    }
);

/* =========================================================
   COMPETITOR ANALYSIS (SerpApi + Gemini)
========================================================= */

/* How many competitor pages get their full content fetched (not just the
   SERP title/snippet) for genuine "deep research" before Gemini reasons
   about them. Kept small — each one is a live outbound fetch. */
const COMPETITOR_DEEP_FETCH_COUNT = 4;

/* Fetches and extracts real page content for a handful of live competitor
   URLs, in parallel, so the analysis is grounded in what's actually on
   their page (structure, depth, headings) instead of just a SERP snippet.
   A competitor whose page can't be fetched (blocked, timeout, etc.) is
   never faked — it just falls back to snippet-only data for that one. */
async function fetchCompetitorSummaries(candidates) {

    const targets =
        candidates.slice(
            0,
            COMPETITOR_DEEP_FETCH_COUNT
        );

    const settled =
        await Promise.allSettled(
            targets.map(
                async item => {
                    const fetched =
                        await fetchWebpage(
                            item.link
                        );
                    const page =
                        extractPageContent(
                            fetched.html,
                            fetched.finalUrl
                        );
                    return {
                        link: item.link,
                        title: page.title || item.title,
                        metaDescription: page.metaDescription || "",
                        h1: safeArray(page.h1).slice(0, 5),
                        h2: safeArray(page.h2).slice(0, 12),
                        wordCount: cleanText(page.text).split(/\s+/).filter(Boolean).length,
                        textExcerpt: cleanText(page.text).slice(0, 1200)
                    };
                }
            )
        );

    const deepByLink = new Map();

    settled.forEach(
        (outcome, i) => {
            if (outcome.status === "fulfilled") {
                deepByLink.set(targets[i].link, outcome.value);
            }
        }
    );

    return candidates.map(
        item => ({
            ...item,
            deep: deepByLink.get(item.link) || null
        })
    );
}

app.post(
    "/api/competitors",
    aiRateLimiter,
    async (
        req,
        res
    ) => {

        try {

            const url =
                validateUrl(
                    req.body.url
                );

            const providedKeyword =
                typeof req.body.keyword ===
                "string"
                    ? req.body.keyword.trim()
                    : "";

            const siteHostname =
                new URL(
                    url
                ).hostname;

            const fetched =
                await fetchWebpage(
                    url
                );

            const page =
                extractPageContent(
                    fetched.html,
                    fetched.finalUrl
                );

            /* Fall back to the page's own H1 / title if no keyword was typed. */
            const searchKeyword =
                providedKeyword ||
                (
                    safeArray(
                        page.h1
                    )[0] ||
                    ""
                ) ||
                page.title ||
                "";

            if (!searchKeyword) {

                throw new Error(
                    "Could not detect a topic for this page automatically — please enter a keyword."
                );
            }

            const country =
                resolveCountry(
                    req.body.country
                );

            console.log(
                "Competitor search:",
                searchKeyword,
                "|",
                siteHostname,
                "|",
                country.label
            );

            const serpResults =
                await fetchSerpResults(
                    searchKeyword,
                    {
                        num:
                            TOP_RANKINGS_RESULT_COUNT,
                        gl: country.gl,
                        hl: country.hl,
                        google_domain: country.google_domain
                    }
                );

            const competitorCandidates =
                await fetchCompetitorSummaries(
                    serpResults
                        .filter(
                            item =>
                                !hostsMatch(
                                    hostnameFromLink(
                                        item.link
                                    ),
                                    siteHostname
                                )
                        )
                        .slice(
                            0,
                            COMPETITOR_RESULT_COUNT
                        )
                );

            const prompt = `
You are a senior SEO competitive-analysis strategist doing DEEP RESEARCH —
you have been given each competitor's actual crawled page content below,
not just a search snippet, so ground your analysis in that real content
wherever it's available.

TARGET PAGE (the site we are helping):
URL: ${page.finalUrl}
Title: ${page.title}
Meta description: ${page.metaDescription}
H1: ${safeArray(page.h1).join(", ")}
H2: ${safeArray(page.h2).slice(0, 15).join(", ")}
Page text excerpt:
${page.text}

SEARCH KEYWORD USED: ${searchKeyword}

SEARCH REGION: ${country.label} (google.${country.gl === "us" ? "com" : country.gl}, results as Google actually shows them in this region — not a generic/US default)

CURRENT TOP-RANKING PAGES FOR THIS KEYWORD (from live Google results in ${country.label}, excluding the target page itself):
${
    competitorCandidates.length
        ? competitorCandidates
            .map(
                item =>
                    item.deep
                        ? `#${item.position} ${item.deep.title}\nURL: ${item.link}\nMeta description: ${item.deep.metaDescription}\nH1: ${item.deep.h1.join(" | ") || "(none)"}\nH2s: ${item.deep.h2.join(" | ") || "(none)"}\nWord count: ${item.deep.wordCount}\nCrawled content excerpt: ${item.deep.textExcerpt}`
                        : `#${item.position} ${item.title}\nURL: ${item.link}\nSnippet (page could not be fully crawled, snippet only): ${item.snippet}`
            )
            .join("\n\n")
        : "None — the target page is not being outranked by any other indexed result for this keyword."
}

Compare the TARGET PAGE against each competing page above. For each competitor,
explain in plain terms what they appear to be doing well, where the target
page could still beat them, and specifically how they seem to be outranking
(or could outrank) the target page (structure, content depth, angle, freshness,
intent match — NOT invented backlink or traffic numbers).

Do NOT invent:
- rankings, traffic, search volume, backlink counts, or Google Search Console data
- domain authority or any other unverifiable third-party metric

Return ONLY valid JSON in this exact shape:

{
  "primary_keyword": "the keyword actually used for this search",
  "target_overview": "2-3 sentences on how the target page is currently positioned for this keyword",
  "competitors": [
    {
      "name": "site or brand name",
      "url": "the competitor's URL",
      "serp_position": 1,
      "strengths": "1-2 sentences on what this competitor does well",
      "gaps": "1-2 sentences on where this competitor is weak or incomplete",
      "how_they_beat_target": "1-2 sentences on specifically why/how this page could outrank the target"
    }
  ],
  "recommendations": [
    "3 to 6 short, concrete, actionable recommendations for the target page to compete better"
  ]
}

Keep the JSON valid and parsable. Include one entry in "competitors" for
each page listed above (or an empty array if none were listed).
`;

            const text =
                await generateAI(
                    prompt,
                    3000,
                    0.3
                );

            const result =
                parseModelJSON(
                    text
                );

            const competitors =
                Array.isArray(
                    result &&
                    result.competitors
                )
                    ? result.competitors
                        .filter(
                            item =>
                                item &&
                                (
                                    item.name ||
                                    item.url
                                )
                        )
                        .slice(
                            0,
                            COMPETITOR_RESULT_COUNT
                        )
                    : [];

            const recommendations =
                Array.isArray(
                    result &&
                    result.recommendations
                )
                    ? result.recommendations
                        .filter(
                            item =>
                                typeof item ===
                                "string" &&
                                item.trim()
                        )
                        .slice(
                            0,
                            8
                        )
                    : [];

            res.json({

                success:
                    true,

                country:
                    { code: country.code, label: country.label },

                competitorAnalysis: {

                    primary_keyword:
                        (
                            result &&
                            result.primary_keyword
                        ) ||
                        searchKeyword,

                    target_overview:
                        (
                            result &&
                            result.target_overview
                        ) ||
                        "",

                    competitors,

                    recommendations
                }
            });

        } catch (
            error
        ) {

            console.error(
                "COMPETITOR ANALYSIS ERROR:",
                error
            );

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    "Competitor analysis failed."
            });
        }
    }
);

/* =========================================================
   FREE SEO OPTIMIZER FEATURES
   - Deterministic action engine (no AI/API cost)
   - Multi-page crawler (no external API)
   - Persistent-friendly rank tracker endpoint (SerpApi only when run)
   - AI recommendations endpoint (Gemini only on explicit request)
========================================================= */

function normalizeAbsoluteLink(href, baseUrl) {
    try {
        const raw = String(href || "").trim();
        if (!raw || raw.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) return null;
        const absolute = new URL(raw, baseUrl);
        if (!["http:", "https:"].includes(absolute.protocol)) return null;
        absolute.hash = "";
        return absolute.toString();
    } catch {
        return null;
    }
}

function buildSeoActions(page) {
    const actions = [];
    const title = cleanText(page.title);
    const meta = cleanText(page.metaDescription);
    const h1 = safeArray(page.h1);
    const h2 = safeArray(page.h2);
    const images = safeArray(page.images);
    const links = safeArray(page.links);
    const structured = safeArray(page.structuredData);
    const wordCount = cleanText(page.text).split(/\s+/).filter(Boolean).length;
    const add = (priority, category, titleText, description, fix, field = "") =>
        actions.push({ id: `${category}-${actions.length + 1}`, priority, category, title: titleText, description, recommended_fix: fix, field, status: "open" });

    if (!title) add("critical", "On-page", "Missing page title", "The page has no detectable <title>.", "Add a unique, descriptive title that matches the page intent.");
    else if (title.length < 30) add("warning", "On-page", "Title is short", `The title is ${title.length} characters.`, "Expand it with the primary topic and a clear value proposition.");
    else if (title.length > 60) add("warning", "On-page", "Title may be too long", `The title is ${title.length} characters.`, "Shorten the title so the most important wording appears early.");

    if (!meta) add("critical", "On-page", "Missing meta description", "No meta description was detected.", "Write a unique, useful description summarizing the page and its search intent.");
    else if (meta.length < 120) add("warning", "On-page", "Meta description is short", `The description is ${meta.length} characters.`, "Expand it with the page topic, benefit and a natural call to action.");
    else if (meta.length > 170) add("warning", "On-page", "Meta description may be too long", `The description is ${meta.length} characters.`, "Trim the description so the key message appears early.");

    if (h1.length === 0) add("critical", "Content", "Missing H1", "No H1 heading was detected.", "Add one clear H1 describing the primary topic of the page.");
    else if (h1.length > 1) add("warning", "Content", "Multiple H1 headings", `Detected ${h1.length} H1 headings.`, "Prefer one primary H1 and use H2/H3 headings for subsections.");

    if (h2.length === 0) add("warning", "Content", "No H2 headings", "No H2 headings were detected.", "Break substantial content into descriptive H2 sections.");

    if (!page.viewport) add("warning", "Technical", "Missing mobile viewport", "No viewport meta tag was detected.", "Add a responsive viewport meta tag.");

    const missingAlt = images.filter(img => !cleanText(img.alt)).length;
    if (images.length && missingAlt) add(missingAlt > 3 ? "critical" : "warning", "Accessibility", "Images missing alt text", `${missingAlt} of ${images.length} detected images have no alt text.`, "Add concise, descriptive alt text to informative images; use empty alt for decorative images.");

    const internal = links.filter(l => {
        const u = normalizeAbsoluteLink(l.href, page.finalUrl);
        return u && hostsMatch(hostnameFromLink(u), hostnameFromLink(page.finalUrl));
    }).length;
    if (internal === 0) add("warning", "Internal links", "No internal links detected", "No same-site links were detected on the page.", "Add contextual links to relevant pages to improve navigation and topical discovery.");

    if (!page.canonical) add("warning", "Technical", "Missing canonical URL", "No canonical link was detected.", "Add a canonical URL when this page has a preferred indexable URL.");

    if (page.robots && /noindex/i.test(page.robots)) add("critical", "Indexability", "Page contains noindex", `Robots directive: ${page.robots}`, "Remove noindex if this page is intended to appear in organic search.");

    if (!structured.length) add("warning", "Structured data", "No JSON-LD detected", "No JSON-LD structured data was detected.", "Add relevant Schema.org JSON-LD where it genuinely describes the page.");

    if (wordCount < 300) add("warning", "Content", "Very little visible text", `Only about ${wordCount} words were detected.`, "Ensure the page fully answers its search intent with useful, original content; do not add filler.");

    if (!/^https:/i.test(page.finalUrl)) add("critical", "Security", "Page is not using HTTPS", "The analyzed URL is not HTTPS.", "Serve the page over HTTPS and redirect HTTP to HTTPS.");

    return actions;
}

function makeActionSummary(actions, page = null) {
    const authoritative = page ? deterministicPageEvidence(page, page.finalUrl || page.url).score : null;
    return {
        score: authoritative,
        critical: actions.filter(a => a.priority === "critical").length,
        warnings: actions.filter(a => a.priority === "warning").length,
        passed: 0,
        actions
    };
}

app.post("/api/seo-actions", aiRateLimiter, async (req, res) => {
    try {
        const url = validateUrl(req.body.url);
        const fetched = await fetchWebpage(url);
        const page = extractPageContent(fetched.html, fetched.finalUrl);
        const result = makeActionSummary(buildSeoActions(page), page);
        res.json({ success: true, url: page.finalUrl, page: {
            title: page.title, metaDescription: page.metaDescription,
            h1: page.h1, wordCount: page.text.split(/\s+/).filter(Boolean).length
        }, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "SEO optimization failed." });
    }
});

app.post("/api/crawl", aiRateLimiter, async (req, res) => {
    try {
        const startUrl = validateUrl(req.body.url);
        const maxPages = Math.max(1, Math.min(Number(req.body.maxPages) || 25, 50));
        const country = resolveCountry(req.body.country);
        const start = new URL(startUrl);
        const startKey = normalizeComparableUrl(start.toString());
        const queue = [startKey];
        const queued = new Set(queue);
        const visited = new Set();
        const pages = [];
        const siteIssues = [];

        while (queue.length && pages.length < maxPages) {
            const current = normalizeComparableUrl(queue.shift());
            if (!current || visited.has(current)) continue;
            visited.add(current);
            try {
                const fetched = await fetchWebpage(current);
                const page = extractPageContent(fetched.html, fetched.finalUrl);
                const actions = buildSeoActions(page);
                const internalLinks = safeArray(page.links)
                    .map(l => normalizeAbsoluteLink(l.href, page.finalUrl))
                    .filter(Boolean)
                    .filter(u => hostsMatch(hostnameFromLink(u), start.hostname));
                const canonical = normalizeAbsoluteLink(page.canonical, page.finalUrl) || page.canonical || "";
                pages.push({
                    url: page.finalUrl,
                    title: page.title,
                    status: 200,
                    score: deterministicPageEvidence(page, page.finalUrl).score,
                    critical: deterministicPageEvidence(page, page.finalUrl).checks.filter(c => c.status === "fail").length,
                    warnings: deterministicPageEvidence(page, page.finalUrl).checks.filter(c => c.status === "warning").length,
                    wordCount: page.text.split(/\s+/).filter(Boolean).length,
                    internalLinks: internalLinks.length,
                    actions: actions.slice(0, 8),
                    canonical
                });
                actions.forEach(a => siteIssues.push({ ...a, url: page.finalUrl }));
                for (const link of internalLinks) {
                    try {
                        const u = new URL(link);
                        const normalized = normalizeComparableUrl(u.toString());
                        if (hostsMatch(u.hostname,start.hostname) && normalized && !queued.has(normalized) && !visited.has(normalized) && queue.length + pages.length < maxPages * 2) {
                            queued.add(normalized);
                            queue.push(normalized);
                        }
                    } catch {}
                }
            } catch (error) {
                pages.push({ url: current, title: "", status: 0, score: 0, critical: 1, warnings: 0, wordCount: 0, internalLinks: 0, actions: [{ priority: "critical", category: "Crawl", title: "Page could not be fetched", description: error.message || "Fetch failed.", recommended_fix: "Verify the URL and server response.", status: "open" }], error: error.message || "Fetch failed." });
            }
        }

        const avgScore = pages.length ? Math.round(pages.reduce((n, p) => n + p.score, 0) / pages.length) : 0;
        const critical = siteIssues.filter(a => a.priority === "critical").length;
        const warnings = siteIssues.filter(a => a.priority === "warning").length;
        const topActions = siteIssues.sort((a,b) => ({critical:0,warning:1}[a.priority] ?? 2) - ({critical:0,warning:1}[b.priority] ?? 2)).slice(0, 30);
        res.json({ success: true, startUrl, pages, summary: { pagesCrawled: pages.length, queued: queue.length, score: avgScore, critical, warnings, topActions } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "Crawl failed." });
    }
});

app.post("/api/rank-track", aiRateLimiter, async (req, res) => {
    try {
        const url = validateUrl(req.body.url);
        const keywords = Array.isArray(req.body.keywords) ? req.body.keywords : [];
        const cleanKeywords = [...new Set(keywords.map(k => String(k || "").trim()).filter(Boolean))].slice(0, 10);
        if (!cleanKeywords.length) throw new Error("Add at least one keyword.");
        const hostname = new URL(url).hostname;
        const country = resolveCountry(req.body.country);
        const results = [];
        for (const keyword of cleanKeywords) {
            let serp = await fetchSerpResults(keyword, { num: RANK_CHECK_SCAN_DEPTH, gl: country.gl, hl: country.hl, google_domain: country.google_domain });
            let exactCheck = await findExactPageMatchWithCanonical(serp, url, 10);
            let match = exactCheck.match || findRankMatch(serp, hostname);
            if (!match && serp.length < 100) {
                const deeper = await fetchSerpResults(keyword, { num: 100, gl: country.gl, hl: country.hl, google_domain: country.google_domain });
                if (deeper.length > serp.length) serp = deeper;
                exactCheck = await findExactPageMatchWithCanonical(serp, url, 10);
                match = exactCheck.match || findRankMatch(serp, hostname);
            }
            results.push({ keyword, position: match ? match.position : null, found: !!match, scannedResults: serp.length, matchedResult: match || null, checkedAt: new Date().toISOString() });
        }
        res.json({ success: true, url, country: { code: country.code, label: country.label, googleDomain: country.google_domain }, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "Rank tracking failed." });
    }
});

app.post("/api/ai-recommendations", aiRateLimiter, async (req, res) => {
    try {
        const payload = req.body && typeof req.body === "object" ? req.body : {};
        const compact = {
            url: String(payload.url || "").slice(0, 500),
            score: Number(payload.score) || 0,
            critical: Number(payload.critical) || 0,
            warnings: Number(payload.warnings) || 0,
            actions: safeArray(payload.actions).slice(0, 12).map(a => ({
                priority: a.priority, category: a.category, title: a.title, description: a.description, recommended_fix: a.recommended_fix
            })),
            crawl: payload.crawl ? {
                pagesCrawled: Number(payload.crawl.pagesCrawled) || 0,
                score: Number(payload.crawl.score) || 0,
                critical: Number(payload.crawl.critical) || 0,
                warnings: Number(payload.crawl.warnings) || 0
            } : null
        };
        const prompt = `You are an SEO implementation advisor. Based ONLY on the verified data below, create a concise prioritized action plan. Never invent rankings, traffic, search volume, backlinks, Search Console data, or competitor facts.
DATA:
${JSON.stringify(compact)}
Return ONLY valid JSON:
{"summary":"2 short sentences","priorities":[{"priority":"critical|high|medium|low","task":"string","why":"string","implementation":"specific practical steps"}],"quick_wins":["string","string","string"]}`;
        const text = await generateAI(prompt, 1800, 0.2);
        const result = parseModelJSON(text);
        res.json({ success: true, recommendations: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || "AI recommendations failed." });
    }
});


/* =========================================================
   RANK #1 PLANNER
   Give a keyword -> estimate volume/difficulty from live SERP
   signals -> AI opportunities + a concrete task checklist ->
   later, crawl the site and verify which tasks are actually
   implemented.
========================================================= */

/*
 * Fetches raw SerpApi data for a keyword and returns the organic
 * results PLUS the extra signals (related searches, related
 * questions, ads count, total results) used to estimate search
 * volume and difficulty. SerpApi does not expose real Keyword
 * Planner volume, so everything derived from this is clearly
 * labeled as an AI estimate, never presented as exact data.
 */
async function fetchSerpInsights(keyword, { num = 10, gl = SERPAPI_DEFAULT_COUNTRY, hl = SERPAPI_DEFAULT_LANGUAGE, google_domain = "google.com" } = {}) {
    const apiKey = requireSerpApiKey();
    const params = new URLSearchParams({ engine: "google", q: keyword, num: String(num), gl, hl, google_domain, no_cache: "true", api_key: apiKey });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const startedAt = Date.now();
    let response;
    try {
        response = await fetch(`${SERPAPI_BASE_URL}?${params.toString()}`, { signal: controller.signal });
    } catch (error) {
        await logApiUsage({ userId: currentUserId(), provider: "serpapi", operation: "google_search", success: false, durationMs: Date.now()-startedAt, errorMessage: String(error.message||error).slice(0,500), metadata: { feature: currentFeature() } });
        throw new Error("Could not reach SerpApi. Please try again.");
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        await logApiUsage({ userId: currentUserId(), provider: "serpapi", operation: "google_search", success: false, durationMs: Date.now()-startedAt, errorMessage: `HTTP ${response.status}`, metadata: { feature: currentFeature() } });
        throw new Error(`SerpApi request failed with status ${response.status}.`);
    }

    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("SerpApi returned an unreadable response.");
    }
    if (data.error) {
        await logApiUsage({ userId: currentUserId(), provider: "serpapi", operation: "google_search", success: false, durationMs: Date.now()-startedAt, errorMessage: String(data.error).slice(0,500), metadata: { feature: currentFeature() } });
        throw new Error(data.error);
    }
    await logApiUsage({ userId: currentUserId(), provider: "serpapi", operation: "google_search", success: true, durationMs: Date.now()-startedAt, metadata: { feature: currentFeature(), keyword: String(keyword).slice(0,120) } });

    const organic = Array.isArray(data.organic_results) ? data.organic_results : [];

    return {
        organic: organic.map((item, index) => ({
            position: typeof item.position === "number" ? item.position : index + 1,
            title: item.title || "",
            link: item.link || item.redirect_link || "",
            redirect_link: item.redirect_link || "",
            displayed_link: item.displayed_link || item.link || item.redirect_link || "",
            snippet: item.snippet || ""
        })),
        searchMetadata: {
            id: data.search_metadata && data.search_metadata.id ? String(data.search_metadata.id) : "",
            googleUrl: data.search_metadata && data.search_metadata.google_url ? String(data.search_metadata.google_url) : "",
            rawHtmlFile: data.search_metadata && data.search_metadata.raw_html_file ? String(data.search_metadata.raw_html_file) : "",
            createdAt: data.search_metadata && data.search_metadata.created_at ? String(data.search_metadata.created_at) : "",
            processedAt: data.search_metadata && data.search_metadata.processed_at ? String(data.search_metadata.processed_at) : ""
        },
        relatedSearches: safeArray(data.related_searches).map(r => r.query).filter(Boolean).slice(0, 10),
        relatedQuestions: safeArray(data.related_questions).map(r => r.question).filter(Boolean).slice(0, 8),
        adsCount: safeArray(data.ads).length,
        totalResults: (data.search_information && data.search_information.total_results) || null,
        hasAnswerBox: !!data.answer_box,
        hasShopping: !!(data.shopping_results && data.shopping_results.length)
    };
}

/* How many organic results to scan for the Rank #1 Planner's "current
   position" check. This used to be a flat 10 (page 1 only), which is why
   a page genuinely ranking, say, #14 was reported as "not ranking at all"
   instead of showing its real position. Matches the Rank Checker's depth. */
const KEYWORD_OPPORTUNITY_SCAN_DEPTH = RANK_CHECK_SCAN_DEPTH;

app.post("/api/keyword-opportunity", aiRateLimiter, async (req, res) => {
    try {
        const url = validateUrl(req.body.url);
        const keyword = typeof req.body.keyword === "string" ? req.body.keyword.trim().slice(0, 100) : "";
        if (!keyword) throw new Error("Enter a keyword to research.");

        const country = resolveCountry(req.body.country);

        console.log("Rank #1 research:", keyword, "for", url, "|", country.label);

        const [fetched, insights] = await Promise.all([
            fetchWebpage(url),
            fetchSerpInsights(keyword, { num: KEYWORD_OPPORTUNITY_SCAN_DEPTH, gl: country.gl, hl: country.hl, google_domain: country.google_domain })
        ]);

        const page = extractPageContent(fetched.html, fetched.finalUrl);
        const hostname = new URL(page.finalUrl).hostname;
        let exactVerification = await findExactPageMatchWithCanonical(insights.organic, page.finalUrl, 10);
        let currentMatch = exactVerification.match;
        const domainInitialMatch = findRankMatch(insights.organic, hostname);
        let domainMatch = domainInitialMatch;
        let rankScanResults = insights.organic;
        if (!currentMatch && rankScanResults.length < 100) {
            const deeper = await fetchSerpInsights(keyword, {
                num: 100, gl: country.gl, hl: country.hl, google_domain: country.google_domain
            });
            exactVerification = await findExactPageMatchWithCanonical(deeper.organic, page.finalUrl, 10);
            currentMatch = exactVerification.match;
            domainMatch = domainMatch || findRankMatch(deeper.organic, hostname);
            if (deeper.organic.length > rankScanResults.length) {
                rankScanResults = deeper.organic;
                insights.searchMetadata = deeper.searchMetadata || insights.searchMetadata;
            }
        }

        const topTenForDisplay = insights.organic.slice(0, 10).map(r => ({
            position: r.position, title: r.title, link: r.link, snippet: r.snippet
        }));

        /* Deep-research the real top competitors (not just page-1 snippets) so
           Gemini's reasoning is grounded in actual crawled content. */
        const compactCompetitors = await fetchCompetitorSummaries(
            topTenForDisplay.filter(item => !hostsMatch(hostnameFromLink(item.link), hostname))
        );

        const prompt = `You are a senior SEO strategist doing DEEP RESEARCH. A user wants THIS page to rank #1 on Google for ONE target keyword, in ONE specific country.

TARGET KEYWORD:
${keyword}

SEARCH REGION: ${country.label} (${country.google_domain}, gl=${country.gl}) — reason about this exact region's results, not a generic/US default.

PAGE TO RANK:
${page.finalUrl}
Title: ${page.title || "(missing)"}
Meta description: ${page.metaDescription || "(missing)"}
H1: ${safeArray(page.h1).join(" | ") || "(missing)"}
H2s: ${safeArray(page.h2).join(" | ") || "(none)"}
Word count: ${cleanText(page.text).split(/\s+/).filter(Boolean).length}

LIVE GOOGLE RESULTS FOR ${country.label} (top ${topTenForDisplay.length} shown, ${rankScanResults.length} scanned), from SerpApi. Competitors below include real crawled page content where available, not just snippets — use it:
${
    compactCompetitors.length
        ? compactCompetitors
            .map(
                item =>
                    item.deep
                        ? `#${item.position} ${item.deep.title}\nURL: ${item.link}\nMeta description: ${item.deep.metaDescription}\nH1: ${item.deep.h1.join(" | ") || "(none)"}\nH2s: ${item.deep.h2.join(" | ") || "(none)"}\nWord count: ${item.deep.wordCount}\nCrawled content excerpt: ${item.deep.textExcerpt}`
                        : `#${item.position} ${item.title}\nURL: ${item.link}\nSnippet (page could not be fully crawled): ${item.snippet}`
            )
            .join("\n\n")
        : "None — no other indexed result currently outranks the target page for this keyword in this region."
}

THIS TARGET PAGE'S CURRENT POSITION: ${currentMatch ? `#${currentMatch.position}` : `Target page not found in the top ${rankScanResults.length} results scanned for ${country.label}`}
DOMAIN-LEVEL POSITION (diagnostic only): ${domainMatch ? `#${domainMatch.position}` : `Domain not found in the scanned results`}

SERP SIGNALS (for an estimate only, not real Keyword Planner data):
- Related searches count: ${insights.relatedSearches.length} (${insights.relatedSearches.join(", ") || "none"})
- Related questions count: ${insights.relatedQuestions.length}
- Ads shown: ${insights.adsCount}
- Total indexed results reported by Google: ${insights.totalResults ?? "unknown"}
- Answer box present: ${insights.hasAnswerBox}
- Shopping results present: ${insights.hasShopping}

TASK:
1. Do NOT invent a monthly search-volume number or range. Google organic SERP data does not provide Google Ads Keyword Planner volume. Return volume.level as "Not verified", volume.range as "", and explain the live SERP signals observed.
2. Estimate ranking DIFFICULTY qualitatively from the live SERP and crawled competitors. Label it as a "SERP-based assessment", not a measured metric.
3. List 4-8 concrete OPPORTUNITIES: specific gaps between this page and the current top-ranking pages (topics they cover that this page doesn't, content depth, freshness, format, structure, intent match). Ground these in the crawled competitor content above wherever it's available.
4. Produce a TASK CHECKLIST of 6-12 specific, verifiable, on-page/technical actions this exact page needs to realistically compete for position #1 on this keyword. Each task must be something later observable in the page's HTML/content (title, meta description, H1/H2 structure, word count/depth, internal links, schema, image alt text, keyword placement) — do not include tasks that require external data like backlinks or Search Console.
5. For each competitor listed above, give a short "why_ranking" (1-2 sentences on specifically what lets that page rank here, grounded in its crawled content where available) — do not invent backlink or traffic data.

Do NOT invent exact rankings, traffic, or backlink data.

Return ONLY valid JSON:
{
  "volume": {"level":"Not verified","range":"","reasoning":"string"},
  "difficulty": {"level":"string","reasoning":"string"},
  "opportunities": [{"title":"string","detail":"string"}],
  "tasks": [{"id":"string (short slug)","title":"string","description":"string","category":"On-page|Content|Technical|Structure","priority":"high|medium|low"}],
  "competitor_notes": [{"link":"the exact competitor URL from the list above","why_ranking":"string"}]
}`;

        const text = await generateAI(prompt, 2200, 0.3);
        const result = parseModelJSON(text);

        const tasks = safeArray(result && result.tasks)
            .filter(t => t && typeof t.title === "string" && t.title.trim())
            .slice(0, 12)
            .map((t, i) => ({
                id: (typeof t.id === "string" && t.id.trim()) ? t.id.trim().slice(0, 60) : `task-${i + 1}`,
                title: t.title.trim().slice(0, 200),
                description: typeof t.description === "string" ? t.description.trim().slice(0, 500) : "",
                category: typeof t.category === "string" ? t.category.trim().slice(0, 40) : "On-page",
                priority: ["high", "medium", "low"].includes(String(t.priority).toLowerCase()) ? String(t.priority).toLowerCase() : "medium"
            }));

        const whyRankingByLink = new Map(
            safeArray(result && result.competitor_notes)
                .filter(n => n && typeof n.link === "string")
                .map(n => [n.link, typeof n.why_ranking === "string" ? n.why_ranking.trim().slice(0, 400) : ""])
        );

        const competitorsWithReasoning = compactCompetitors.map(c => ({
            position: c.position,
            title: c.deep ? c.deep.title : c.title,
            link: c.link,
            snippet: c.snippet,
            whyRanking: whyRankingByLink.get(c.link) || ""
        }));

        res.json({
            success: true,
            keyword,
            url: page.finalUrl,
            country: { code: country.code, label: country.label },
            scannedResults: rankScanResults.length,
            currentPosition: currentMatch ? currentMatch.position : null,
            domainPosition: domainMatch ? domainMatch.position : null,
            rankEvidence: currentMatch ? {
                matchedUrl: currentMatch.link || currentMatch.redirect_link || "",
                position: currentMatch.position,
                title: currentMatch.title || "",
                snippet: currentMatch.snippet || "",
                displayedLink: currentMatch.displayed_link || "",
                matchType: "exact-target-page",
                matchVerification: exactVerification.verification,
                googleUrl: insights.searchMetadata && insights.searchMetadata.googleUrl ? insights.searchMetadata.googleUrl : "",
                rawHtmlFile: insights.searchMetadata && insights.searchMetadata.rawHtmlFile ? insights.searchMetadata.rawHtmlFile : "",
                searchId: insights.searchMetadata && insights.searchMetadata.id ? insights.searchMetadata.id : "",
                checkedAt: new Date().toISOString(),
                scannedResults: rankScanResults.length
            } : {
                matchedUrl: domainMatch ? (domainMatch.link || domainMatch.redirect_link || "") : "",
                position: domainMatch ? domainMatch.position : null,
                title: domainMatch ? domainMatch.title || "" : "",
                snippet: domainMatch ? domainMatch.snippet || "" : "",
                displayedLink: domainMatch ? domainMatch.displayed_link || "" : "",
                matchType: domainMatch ? "domain-only-not-target-page" : "not-found",
                matchVerification: exactVerification.verification,
                googleUrl: insights.searchMetadata && insights.searchMetadata.googleUrl ? insights.searchMetadata.googleUrl : "",
                rawHtmlFile: insights.searchMetadata && insights.searchMetadata.rawHtmlFile ? insights.searchMetadata.rawHtmlFile : "",
                searchId: insights.searchMetadata && insights.searchMetadata.id ? insights.searchMetadata.id : "",
                checkedAt: new Date().toISOString(),
                scannedResults: rankScanResults.length
            },
            topSerpResults: rankScanResults.slice(0, 10).map(r => ({
                position: r.position,
                title: r.title,
                link: r.link || r.redirect_link || "",
                snippet: r.snippet || "",
                displayedLink: r.displayed_link || ""
            })),
            // Never surface AI-invented search-volume numbers. Organic SERP data is
            // not Google Ads Keyword Planner data, so volume is explicitly unverified.
            volume: {
                level: "Not verified",
                range: "",
                reasoning: "No Google Ads Keyword Planner volume was queried. This report uses live Google SERP signals only; monthly volume is intentionally not fabricated."
            },
            difficulty: (result && result.difficulty) || { level: "Unknown", reasoning: "Could not be assessed from the live SERP." },
            opportunities: safeArray(result && result.opportunities).slice(0, 8),
            competitors: competitorsWithReasoning,
            tasks,
            research: {
                source: "Live Google SERP via SerpApi + direct page crawl + Gemini grounded analysis",
                googleDomain: country.google_domain,
                searchMetadata: insights.searchMetadata || {},
                scannedResults: rankScanResults.length,
                liveSignals: {
                    relatedSearches: insights.relatedSearches,
                    relatedQuestions: insights.relatedQuestions,
                    adsCount: insights.adsCount,
                    totalResults: insights.totalResults,
                    answerBox: insights.hasAnswerBox,
                    shopping: insights.hasShopping
                }
            }
        });

    } catch (error) {
        console.error("KEYWORD OPPORTUNITY ERROR:", error);
        res.status(500).json({ success: false, error: error.message || "Keyword research failed." });
    }
});

app.post("/api/keyword-verify", aiRateLimiter, async (req, res) => {
    try {
        const startUrl = validateUrl(req.body.url);
        const keyword = typeof req.body.keyword === "string" ? req.body.keyword.trim().slice(0, 100) : "";
        if (!keyword) throw new Error("Missing target keyword.");
        const country = resolveCountry(req.body.country);

        const tasks = safeArray(req.body.tasks)
            .filter(t => t && typeof t.title === "string")
            .slice(0, 12)
            .map(t => ({
                id: String(t.id || "").slice(0, 60),
                title: t.title.trim().slice(0, 200),
                completed: !!t.completed
            }));
        if (!tasks.length) throw new Error("No tasks to verify.");

        const maxPages = Math.max(1, Math.min(Number(req.body.maxPages) || 20, 30));
        const start = new URL(startUrl);
        const startKey = normalizeComparableUrl(start.toString());
        const queue = [startKey];
        const queued = new Set(queue);
        const visited = new Set();
        const pages = [];

        while (queue.length && pages.length < maxPages) {
            const current = normalizeComparableUrl(queue.shift());
            if (!current || visited.has(current)) continue;
            visited.add(current);
            try {
                const fetched = await fetchWebpage(current);
                const page = extractPageContent(fetched.html, fetched.finalUrl);
                pages.push({
                    url: page.finalUrl,
                    title: page.title,
                    metaDescription: page.metaDescription,
                    h1: safeArray(page.h1).slice(0, 5),
                    h2: safeArray(page.h2).slice(0, 10),
                    wordCount: cleanText(page.text).split(/\s+/).filter(Boolean).length,
                    hasSchema: safeArray(page.structuredData).length > 0,
                    canonical: page.canonical || "",
                    imagesMissingAlt: safeArray(page.images).filter(img => !cleanText(img.alt)).length,
                    imagesTotal: safeArray(page.images).length,
                    excerpt: cleanText(page.text).slice(0, 600)
                });
                const internalLinks = safeArray(page.links)
                    .map(l => normalizeAbsoluteLink(l.href, page.finalUrl))
                    .filter(Boolean)
                    .filter(u => hostsMatch(hostnameFromLink(u), start.hostname));
                for (const link of internalLinks) {
                    if (!queued.has(link) && !visited.has(link) && queue.length + pages.length < maxPages * 2) {
                        queued.add(link);
                        queue.push(link);
                    }
                }
            } catch (error) {
                pages.push({ url: current, error: error.message || "Fetch failed." });
            }
        }

        // Fresh regional Google check after the crawl: completion must include
        // current SERP evidence, not just a checkbox or stale planner result.
        const liveSerp = await fetchSerpResults(keyword, {
            num: RANK_CHECK_SCAN_DEPTH,
            gl: country.gl,
            hl: country.hl,
            google_domain: country.google_domain
        });
        let liveExactVerification = await findExactPageMatchWithCanonical(liveSerp, startUrl, 10);
        let liveRankMatch = liveExactVerification.match;
        let liveDomainMatch = findRankMatch(liveSerp, start.hostname);
        let liveRankResults = liveSerp;
        if (!liveRankMatch && liveSerp.length < 100) {
            const deeper = await fetchSerpResults(keyword, {
                num: 100, gl: country.gl, hl: country.hl, google_domain: country.google_domain
            });
            liveExactVerification = await findExactPageMatchWithCanonical(deeper, startUrl, 10);
            liveRankMatch = liveExactVerification.match;
            liveDomainMatch = liveDomainMatch || findRankMatch(deeper, start.hostname);
            if (deeper.length > liveRankResults.length) liveRankResults = deeper;
        }

        const prompt = `You are a professional SEO auditor verifying implementation work, not inventing anything.

TARGET KEYWORD: ${keyword}

The user self-reported completing these tasks:
${JSON.stringify(tasks)}

Freshly crawled pages from the site (only what is actually observable in the HTML):
${JSON.stringify(pages).slice(0, 12000)}

For EACH task above, decide, using ONLY evidence visible in the crawled pages:
- "verified": clearly implemented and observable in the crawl
- "partial": some progress but incomplete or inconsistent across pages
- "not_detected": no evidence found in the crawl, even if the user marked it complete

Also give an overall RATING from 0-100 reflecting how ready this site is to compete for position #1 on this keyword, plus up to 5 short professional WARNINGS (real, specific, evidence-based — no generic filler) and a 2-sentence SUMMARY in a professional tone.

Do NOT invent rankings, traffic, or backlink data. Only comment on what is verifiable in the crawled content.

Return ONLY valid JSON:
{
  "verification": [{"id":"string matches a task id","status":"verified|partial|not_detected","note":"short evidence-based reason"}],
  "rating": {"score": number, "label":"string"},
  "warnings": ["string"],
  "summary": "string"
}`;

        const text = await generateAI(prompt, 2000, 0.15);
        const result = parseModelJSON(text);

        const byId = new Map(safeArray(result && result.verification).map(v => [String(v.id), v]));
        const verification = tasks.map(t => {
            const v = byId.get(t.id);
            return {
                id: t.id,
                title: t.title,
                status: v && ["verified", "partial", "not_detected"].includes(v.status) ? v.status : "not_detected",
                note: (v && typeof v.note === "string") ? v.note.slice(0, 300) : "No evidence found in the crawl."
            };
        });

        res.json({
            success: true,
            keyword,
            country: { code: country.code, label: country.label },
            liveRank: liveRankMatch ? liveRankMatch.position : null,
            domainRank: liveDomainMatch ? liveDomainMatch.position : null,
            rankScanDepth: liveRankResults.length,
            rankEvidence: liveRankMatch ? { matchedUrl: liveRankMatch.link || liveRankMatch.redirect_link || "", position: liveRankMatch.position, matchType: "exact-target-page", matchVerification: liveExactVerification.verification } : { matchedUrl: liveDomainMatch ? (liveDomainMatch.link || liveDomainMatch.redirect_link || "") : "", position: liveDomainMatch ? liveDomainMatch.position : null, matchType: liveDomainMatch ? "domain-only-not-target-page" : "not-found" },
            pagesCrawled: pages.length,
            verification,
            crawlEvidence: pages.map(p => ({
                url: p.url,
                title: p.title || "",
                wordCount: p.wordCount || 0,
                h1: p.h1 || [],
                h2: p.h2 || [],
                hasSchema: !!p.hasSchema,
                canonical: p.canonical || "",
                imagesMissingAlt: p.imagesMissingAlt || 0,
                imagesTotal: p.imagesTotal || 0
            })),
            rating: {
                score: Math.max(0, Math.min(100, Number(result && result.rating && result.rating.score) || 0)),
                label: (result && result.rating && result.rating.label) || ""
            },
            warnings: safeArray(result && result.warnings).slice(0, 5),
            summary: (result && result.summary) || ""
        });

    } catch (error) {
        console.error("KEYWORD VERIFY ERROR:", error);
        res.status(500).json({ success: false, error: error.message || "Verification crawl failed." });
    }
});

/* =========================================================
   CONTENT PLAN — supporting pages + blog topic ideas
   Given the page + target keyword, suggests what OTHER pages
   (blog, FAQ, comparison, etc.) should exist to support it,
   plus concrete high-intent blog topic ideas, using real SERP
   "related searches"/"related questions" signals + Gemini.
========================================================= */

app.post("/api/content-plan", aiRateLimiter, async (req, res) => {
    try {
        const url = validateUrl(req.body.url);
        const keyword = typeof req.body.keyword === "string" ? req.body.keyword.trim().slice(0, 100) : "";
        if (!keyword) throw new Error("Enter a target keyword first.");

        const country = resolveCountry(req.body.country);

        console.log("Content plan:", keyword, "for", url, "|", country.label);

        const [fetched, insights] = await Promise.all([
            fetchWebpage(url),
            fetchSerpInsights(keyword, { num: 10, gl: country.gl, hl: country.hl, google_domain: country.google_domain })
        ]);

        const page = extractPageContent(fetched.html, fetched.finalUrl);

        const prompt = `You are a senior SEO content strategist planning a SUPPORTING CONTENT STRUCTURE around one target page, using real SERP demand signals.

TARGET KEYWORD: ${keyword}
SEARCH REGION: ${country.label}

TARGET PAGE:
${page.finalUrl}
Title: ${page.title || "(missing)"}
Meta description: ${page.metaDescription || "(missing)"}
H1: ${safeArray(page.h1).join(" | ") || "(missing)"}
Page type inferred from H1/H2/content: reason about whether this looks like a service page, product page, homepage, etc.

REAL SERP DEMAND SIGNALS for this keyword (from live Google, ${country.label}):
- Related searches: ${insights.relatedSearches.join(", ") || "none returned"}
- Related "People also ask" questions: ${insights.relatedQuestions.join(" | ") || "none returned"}
- Ads shown: ${insights.adsCount} (commercial-intent signal)
- Answer box present: ${insights.hasAnswerBox}

TASK:
1. Recommend 4-8 SUPPORTING PAGE TYPES this site should build to establish topical authority around this keyword and earn more organic entry points (examples: a Blog/Resources hub, an FAQ page, a Comparison/"X vs Y" page, a Case Studies page, a Pricing page, a How-it-works/Process page, location-specific landing pages if relevant). For each, explain WHY in one sentence, tied to the keyword/page type — do not just list generic pages.
2. From the real related searches/questions above (and your own knowledge of what people search around this topic), produce 6-10 concrete BLOG TOPIC ideas that are high-intent-match for this keyword's audience. For each: a specific, publishable title (not a generic label), the search INTENT (Informational | Commercial | Navigational | Transactional), an AI-ESTIMATED relative volume level (Low | Medium | High — reasoned from how many related searches/questions echo it, NOT real Keyword Planner data, say so implicitly by keeping it a level not a number), and a one-sentence angle for why it supports the target keyword.

Do NOT invent exact search volume numbers, backlink data, or claim these pages already exist on the site.

Return ONLY valid JSON:
{
  "supportingPages": [{"title":"string, e.g. 'Blog / Resources Hub'","type":"Blog|FAQ|Comparison|Case Studies|Pricing|Process|Location|Other","reason":"string"}],
  "blogTopics": [{"title":"string, a real publishable blog title","intent":"Informational|Commercial|Navigational|Transactional","volumeLevel":"Low|Medium|High","reason":"string"}]
}`;

        const text = await generateAI(prompt, 2000, 0.4);
        const result = parseModelJSON(text);

        const supportingPages = safeArray(result && result.supportingPages)
            .filter(p => p && typeof p.title === "string" && p.title.trim())
            .slice(0, 8)
            .map((p, i) => ({
                id: `page-${i + 1}`,
                title: p.title.trim().slice(0, 150),
                type: typeof p.type === "string" ? p.type.trim().slice(0, 40) : "Other",
                reason: typeof p.reason === "string" ? p.reason.trim().slice(0, 400) : ""
            }));

        const blogTopics = safeArray(result && result.blogTopics)
            .filter(t => t && typeof t.title === "string" && t.title.trim())
            .slice(0, 10)
            .map((t, i) => ({
                id: `blog-${i + 1}`,
                title: t.title.trim().slice(0, 200),
                intent: ["Informational", "Commercial", "Navigational", "Transactional"].includes(t.intent) ? t.intent : "Informational",
                volumeLevel: ["Low", "Medium", "High"].includes(t.volumeLevel) ? t.volumeLevel : "Medium",
                reason: typeof t.reason === "string" ? t.reason.trim().slice(0, 400) : ""
            }));

        res.json({
            success: true,
            keyword,
            url: page.finalUrl,
            country: { code: country.code, label: country.label },
            supportingPages,
            blogTopics
        });

    } catch (error) {
        console.error("CONTENT PLAN ERROR:", error);
        res.status(500).json({ success: false, error: error.message || "Content plan generation failed." });
    }
});

/* =========================================================
   PDF EXPORT
========================================================= */

function pdfSafe(value) {
    return String(value ?? "")
        .replace(/https?:\/\/[^\s]+/g, m => m)
        .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

function reportToPdfLines(report) {
    const r = report && typeof report === "object" ? report : {};
    const lines = [];
    const add = (text="", indent=0) => {
        const prefix = " ".repeat(indent);
        String(text).split(/\r?\n/).forEach(line => lines.push(prefix + pdfSafe(line)));
    };
    const heading = (text) => { lines.push(""); lines.push("============================================================"); lines.push(pdfSafe(text).toUpperCase()); lines.push("============================================================"); };
    const jsonBlock = (value, max=12000) => {
        if (value == null) { add("No data captured."); return; }
        let text; try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
        add(text.slice(0,max));
    };

    add("SEO AGENT - FULL SEO PERFORMANCE REPORT");
    add("Generated: " + new Date().toLocaleString());
    add("");
    if (r.dashboard) { heading("1. Dashboard / Executive Analysis"); if (r.dashboard.url) add("URL: " + r.dashboard.url); if (r.dashboard.text) add(r.dashboard.text); else jsonBlock(r.dashboard); }
    if (r.audit) { heading("2. Site Audit"); add("Overall status: " + (r.audit.overall_status || "—")); (r.audit.checks || []).forEach(c => add(`[${c.status || "—"}] ${c.name || "SEO check"} - ${c.details || ""}`)); }
    if (r.keywords) { heading("3. Keyword Intelligence"); jsonBlock(r.keywords); }
    if (r.content) { heading("4. Content Analysis / Brief"); jsonBlock(r.content); }
    if (r.contentGap) { heading("5. Content Gap Analysis"); jsonBlock(r.contentGap); }
    if (r.rank) { heading("6. Rank Checker"); jsonBlock(r.rank); }
    if (r.topRankings) { heading("7. Top Rankings / SERP Results"); jsonBlock(r.topRankings); }
    if (r.competitors) { heading("8. Competitor Intelligence"); jsonBlock(r.competitors); }
    if (r.optimizer) { heading("9. SEO Optimizer"); jsonBlock(r.optimizer); }
    if (r.siteHealth) { heading("10. Site Health"); jsonBlock(r.siteHealth); }
    if (r.opportunities) { heading("11. Opportunities / Action Plan"); jsonBlock(r.opportunities); }
    if (r.rankTracker) { heading("12. Rank Tracker"); jsonBlock(r.rankTracker); }
    if (r.ai) { heading("13. AI Implementation Plan"); jsonBlock(r.ai); }
    heading("14. Report Coverage");
    add("This PDF contains the SEO data captured by the SEO Agent during this browser session.");
    add("URL-based intelligence is included for every completed section; sections without completed data are not fabricated.");
    return lines;
}

function buildSimplePdf(lines) {
    const pageW=612, pageH=792, margin=42, fontSize=9, leading=12, maxChars=92;
    const wrapped=[];
    for (const raw of lines) {
        const text=String(raw || "");
        if (!text) { wrapped.push(""); continue; }
        let rest=text;
        while(rest.length>maxChars){
            let cut=rest.lastIndexOf(" ",maxChars);
            if(cut<20) cut=maxChars;
            wrapped.push(rest.slice(0,cut)); rest=rest.slice(cut).trimStart();
        }
        wrapped.push(rest);
    }
    const linesPerPage=Math.floor((pageH-2*margin-40)/leading);
    const pages=[];
    for(let i=0;i<wrapped.length;i+=linesPerPage) pages.push(wrapped.slice(i,i+linesPerPage));
    if(!pages.length) pages.push([""]);
    const objects=[];
    const addObj=x=>{objects.push(x);return objects.length;};
    const catalog=addObj(null), pagesObj=addObj(null), font=addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const pageRefs=[];
    for(const pageLines of pages){
        let content="BT\n/F1 9 Tf\n42 750 Td\n12 TL\n";
        for(const line of pageLines){
            const escaped=line.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)");
            content += `(${escaped}) Tj T*\n`;
        }
        content += "ET";
        const stream=addObj(`<< /Length ${Buffer.byteLength(content,"latin1")} >>\nstream\n${content}\nendstream`);
        const page=addObj(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`);
        pageRefs.push(page);
    }
    objects[catalog-1]=`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj-1]=`<< /Type /Pages /Kids [${pageRefs.map(x=>x+" 0 R").join(" ")}] /Count ${pageRefs.length} >>`;
    let pdf="%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets=[0];
    for(let i=0;i<objects.length;i++){ offsets.push(Buffer.byteLength(pdf,"latin1")); pdf += `${i+1} 0 obj\n${objects[i]}\nendobj\n`; }
    const xref=Buffer.byteLength(pdf,"latin1");
    pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
    for(let i=1;i<offsets.length;i++) pdf += String(offsets[i]).padStart(10,"0")+" 00000 n \n";
    pdf += `trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf,"latin1");
}


/* =========================================================
   FREE SEO INTELLIGENCE LAB
   Deterministic evidence-first tools. No AI is allowed to
   manufacture metrics here: every displayed fact comes from
   a fresh page fetch, crawl, or user-supplied Search Console
   export.
========================================================= */

function seoTokenSet(text) {
    return new Set(
        cleanText(String(text || ""))
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, " ")
            .split(/\s+/)
            .filter(t => t.length >= 3)
            .slice(0, 3000)
    );
}

function tokenOverlap(a, b) {
    const A = seoTokenSet(a);
    const B = seoTokenSet(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    return Math.round((shared / Math.max(1, Math.min(A.size, B.size))) * 100);
}

function scoreVerifiedChecks(checks) {
    const weights = {
        "http-status":12, title:10, "meta-description":8, h1:10, "content-depth":5,
        canonical:2, schema:1, "images-alt":5, "internal-links":6, https:8,
        "viewport":3, "redirect-chain":5, "html-content-type":6, "language":2
    };
    const scored = safeArray(checks).filter(c => c.status !== "info" && (weights[c.id] || 0) > 0);
    const total = scored.reduce((n,c)=>n+(weights[c.id]||0),0);
    if (!total) return 100;
    const earned = scored.reduce((n,c)=>n+(c.status === "pass" ? (weights[c.id]||0) : c.status === "warning" ? (weights[c.id]||0)*0.35 : 0),0);
    return Math.max(0,Math.min(100,Math.round(earned/total*100)));
}

function deterministicPageEvidence(page, finalUrl) {
    const text = cleanText(page.text || "");
    const title = String(page.title || "");
    const meta = String(page.metaDescription || "");
    const h1 = safeArray(page.h1).map(String);
    const h2 = safeArray(page.h2).map(String);
    const images = safeArray(page.images);
    const links = safeArray(page.links);
    const structuredData = safeArray(page.structuredData);

    const checks = [
        { id:"http-status", label:"HTTP status", status:"pass", value:"200", evidence:`Fetched successfully: ${finalUrl}` },
        { id:"title", label:"Title", status:title ? (title.length >= 30 && title.length <= 65 ? "pass" : "warning") : "fail", value:title || "Missing", evidence:title ? `${title.length} characters` : "No <title> found." },
        { id:"meta-description", label:"Meta description", status:meta ? (meta.length >= 70 && meta.length <= 170 ? "pass" : "warning") : "fail", value:meta || "Missing", evidence:meta ? `${meta.length} characters` : "No meta description found." },
        { id:"h1", label:"H1", status:h1.length === 1 ? "pass" : h1.length > 1 ? "warning" : "fail", value:h1.join(" | ") || "Missing", evidence:`${h1.length} H1 tag(s) detected.` },
        { id:"content-depth", label:"Visible word count", status:text.split(/\s+/).filter(Boolean).length >= 300 ? "pass" : "warning", value:String(text.split(/\s+/).filter(Boolean).length), evidence:"Counted from extracted visible page text; not an AI estimate." },
        { id:"canonical", label:"Canonical", status:page.canonical ? "pass" : "info", value:page.canonical || "Not detected", evidence:page.canonical ? "Canonical tag detected in HTML." : "No canonical tag detected." },
        { id:"schema", label:"Structured data", status:structuredData.length ? "pass" : "info", value:String(structuredData.length), evidence:structuredData.length ? `${structuredData.length} structured-data block(s) detected.` : "No structured-data block detected." },
        { id:"images-alt", label:"Image ALT text", status:images.length ? (images.filter(i => cleanText(i.alt)).length === images.length ? "pass" : "warning") : "pass", value:`${images.filter(i => cleanText(i.alt)).length}/${images.length}`, evidence:images.length ? `${images.filter(i => !cleanText(i.alt)).length} image(s) missing ALT text.` : "No images detected." },
        { id:"internal-links", label:"Internal links", status:links.length ? "pass" : "warning", value:String(links.length), evidence:"Links extracted from the fetched HTML." },
        { id:"https", label:"HTTPS", status:String(finalUrl).startsWith("https://") ? "pass" : "fail", value:String(finalUrl).startsWith("https://") ? "HTTPS" : "HTTP", evidence:"Based on the final fetched URL." }
    ];

    const weights = {"http-status":12,title:10,"meta-description":8,h1:10,"content-depth":5,canonical:2,schema:1,"images-alt":5,"internal-links":6,https:8};
    const scored = checks.filter(c => c.status !== "info" && (weights[c.id] || 0) > 0);
    const totalWeight = scored.reduce((n,c) => n + (weights[c.id] || 0), 0);
    const earned = scored.reduce((n,c) => n + (c.status === "pass" ? (weights[c.id] || 0) : c.status === "warning" ? (weights[c.id] || 0) * 0.35 : 0), 0);
    const score = totalWeight ? Math.round(earned / totalWeight * 100) : 100;
    return { finalUrl, title, metaDescription:meta, h1, h2, wordCount:text.split(/\s+/).filter(Boolean).length, checks, score, scoreMethod:"Weighted verified checks: pass=100%, warning=35%, fail=0%; informational checks do not affect score.", fetchedAt:new Date().toISOString() };
}

app.post("/api/verify-url", aiRateLimiter, async (req, res) => {
    try {
        const requestedUrl = validateUrl(req.body.url);
        const fetched = await fetchWebpage(requestedUrl);
        const page = extractPageContent(fetched.html, fetched.finalUrl);
        const evidence = deterministicPageEvidence(page, fetched.finalUrl);
        res.json({ success:true, requestedUrl, ...evidence });
    } catch (error) {
        res.status(500).json({ success:false, error:error.message || "Verification failed." });
    }
});


/* =========================================================
   BACKLINK OPPORTUNITY BUILDER
========================================================= */
app.post("/api/backlink-opportunities", aiRateLimiter, async (req, res) => {
  try {
    const url = validateUrl(req.body.url);
    const type = String(req.body.type || "all").trim();
    const count = Math.max(3, Math.min(Number(req.body.count) || 10, 25));
    const excluded = new Set((Array.isArray(req.body.excludeUrls) ? req.body.excludeUrls : []).map(x => String(x).toLowerCase()));
    const catalog = [
      ["Google Business Profile","business","Create/claim an accurate business profile","https://www.google.com/business/"],
      ["Bing Places","business","Create or update the business listing","https://www.bingplaces.com/"],
      ["Apple Business Connect","business","Manage the official business listing","https://businessconnect.apple.com/"],
      ["Product Hunt","community","Participate only when genuinely relevant","https://www.producthunt.com/"],
      ["Medium","article","Publish useful original content where appropriate","https://medium.com/new-story"],
      ["Dev.to","article","Publish an original technical/resource article if relevant","https://dev.to/"],
      ["Hashnode","article","Publish a relevant original technical article","https://hashnode.com/"],
      ["WordPress.com","web20","Create a useful supporting publication, not a link farm","https://wordpress.com/start/"],
      ["Blogger","web20","Create a useful supporting publication where relevant","https://www.blogger.com/"],
      ["Tumblr","web20","Publish genuinely useful supporting content","https://www.tumblr.com/register"],
      ["Pinterest","social-bookmarking","Share useful visual content when appropriate","https://www.pinterest.com/signup/"],
      ["Flipboard","social-bookmarking","Share genuinely useful editorial content","https://flipboard.com/"],
      ["Diigo","social-bookmarking","Curate a useful resource where appropriate","https://www.diigo.com/sign-up"],
      ["Pearltrees","resource","Curate a genuinely useful resource collection","https://www.pearltrees.com/"],
      ["Scoop.it","resource","Curate useful topical content where appropriate","https://www.scoop.it/"],
      ["Wakelet","resource","Build a useful resource collection","https://wakelet.com/signup"],
      ["Flickr","image-submission","Publish original visual assets when relevant","https://www.flickr.com/"],
      ["Behance","image-submission","Publish an original project/case study when relevant","https://www.behance.net/"],
      ["Dribbble","image-submission","Publish original design work when relevant","https://dribbble.com/signup/new"],
      ["Pexels","image-submission","Submit original images when appropriate","https://www.pexels.com/join/"],
      ["PRLog","digital-pr","Use only for legitimate newsworthy announcements","https://www.prlog.org/"],
      ["OpenPR","digital-pr","Submit a legitimate newsworthy press release","https://www.openpr.com/"],
      ["Newswire","digital-pr","Use legitimate editorial/press workflows only","https://www.newswire.com/"],
      ["Featured","digital-pr","Answer relevant expert questions with original expertise","https://featured.com/"],
      ["PodcastGuests","community","Find relevant podcast opportunities for genuine expertise","https://podcastguests.com/"],
      ["Meetup","community","Participate in relevant communities/events","https://www.meetup.com/"],
      ["Eventbrite","community","Create a legitimate relevant event/resource","https://www.eventbrite.com/"],
      ["OpenStreetMap","business","Add accurate location information when applicable","https://www.openstreetmap.org/"],
      ["ORCID","article","Create/update an author profile when academically relevant","https://orcid.org/register"],
      ["Zenodo","article","Publish legitimate research/resources when appropriate","https://zenodo.org/signup/"]
    ];
    const allowed = type === "all" ? catalog : catalog.filter(x => x[1] === type);
    const pool = (allowed.length ? allowed : catalog).filter(x => !excluded.has(x[3].toLowerCase()));
    if (!pool.length) return res.json({success:true,url,type,items:[],available:0,source:"Gemini API + verified destination catalog"});
    const prompt = `You are an ethical SEO link-building strategist.\nWebsite: ${url}\nRequested type: ${type}\nChoose up to ${count} opportunities ONLY from this verified catalog. Never invent a platform or URL. Do not claim traffic, authority, existing backlinks, or guaranteed ranking benefits.\nReturn ONLY JSON: {"items":[{"name":"","category":"","action":"","why":"","quality_note":""}]}\nCatalog:\n${JSON.stringify(pool.map(x=>({name:x[0],category:x[1],submitUrl:x[3],baseAction:x[2]})),null,2)}`;
    let parsed;
    try { parsed = parseModelJSON(await generateAI(prompt, 2200, 0.2)); }
    catch(e) { return res.status(502).json({success:false,error:`Gemini backlink generation failed: ${e.message}`}); }
    const byName = new Map(pool.map(x=>[x[0].toLowerCase(),x]));
    const items = (Array.isArray(parsed?.items)?parsed.items:[]).map(x=>{
      const row=byName.get(String(x.name||"").toLowerCase()); if(!row) return null;
      return {name:row[0],category:row[1],action:String(x.action||row[2]).slice(0,500),why:String(x.why||"Relevant participation may create a legitimate discovery or referral opportunity.").slice(0,700),qualityNote:String(x.quality_note||"Verify relevance, editorial rules, and whether links are permitted.").slice(0,700),submitUrl:row[3]};
    }).filter(Boolean).slice(0,count);
    res.json({success:true,url,type,count:items.length,items,available:pool.length,source:"Gemini API + verified destination catalog",note:"These are opportunities, not guaranteed backlinks."});
  } catch(error) { res.status(400).json({success:false,error:error.message||"Backlink generation failed."}); }
});

app.post("/api/internal-link-opportunities", aiRateLimiter, async (req, res) => {
    try {
        const startUrl = validateUrl(req.body.url);
        const targetKeyword = String(req.body.keyword || "").trim().slice(0, 150);
        const maxPages = Math.max(5, Math.min(Number(req.body.maxPages) || 25, 50));
        const start = new URL(startUrl);
        const startKey = normalizeComparableUrl(start.toString());
        const queue = [startKey];
        const queued = new Set(queue);
        const visited = new Set();
        const records = [];
        const inbound = new Map();

        while (queue.length && records.length < maxPages) {
            const current = normalizeComparableUrl(queue.shift());
            if (!current || visited.has(current)) continue;
            visited.add(current);
            try {
                const fetched = await fetchWebpage(current);
                const page = extractPageContent(fetched.html, fetched.finalUrl);
                const links = safeArray(page.links)
                    .map(l => normalizeAbsoluteLink(l.href, page.finalUrl))
                    .filter(Boolean)
                    .filter(u => hostsMatch(hostnameFromLink(u), start.hostname));
                const uniqueLinks = [...new Set(links)];
                for (const link of uniqueLinks) {
                    inbound.set(normalizeComparableUrl(link), (inbound.get(normalizeComparableUrl(link)) || 0) + 1);
                    if (!queued.has(link) && !visited.has(link) && queue.length + records.length < maxPages * 2) {
                        queued.add(link); queue.push(link);
                    }
                }
                records.push({
                    url:page.finalUrl,
                    title:page.title || "",
                    text:cleanText(page.text || ""),
                    wordCount:cleanText(page.text || "").split(/\s+/).filter(Boolean).length,
                    links:uniqueLinks
                });
            } catch {}
        }

        const target = records.find(r => normalizeComparableUrl(r.url) === normalizeComparableUrl(startUrl)) || records[0];
        const candidates = records
            .filter(r => target && normalizeComparableUrl(r.url) !== normalizeComparableUrl(target.url))
            .map(r => {
                const relevance = targetKeyword ? tokenOverlap(`${r.title} ${r.text}`, targetKeyword) : tokenOverlap(r.title, target ? target.title : "");
                const anchor = targetKeyword || (target ? target.title : "relevant page");
                return {
                    sourceUrl:r.url,
                    sourceTitle:r.title,
                    suggestedTarget:target ? target.url : startUrl,
                    suggestedAnchor:anchor,
                    relevance,
                    reason:targetKeyword
                        ? `The source page has ${relevance}% token overlap with the supplied topic. This is a deterministic relevance signal, not a ranking claim.`
                        : `The source and target pages share ${relevance}% of the smaller token set. This is a deterministic topical similarity signal.`
                };
            })
            .filter(x => x.relevance >= (targetKeyword ? 10 : 15))
            .sort((a,b) => b.relevance - a.relevance)
            .slice(0, 20);

        const orphanCandidates = records
            .filter(r => (inbound.get(normalizeComparableUrl(r.url)) || 0) === 0 && normalizeComparableUrl(r.url) !== normalizeComparableUrl(startUrl))
            .map(r => ({url:r.url,title:r.title,reason:"No inbound internal link was observed from the pages crawled in this run. This is crawl-scope evidence, not proof that the page is globally orphaned."}))
            .slice(0, 20);

        res.json({
            success:true,
            startUrl,
            keyword:targetKeyword,
            pagesCrawled:records.length,
            crawlScope:"Same-domain pages discovered from the supplied starting URL.",
            opportunities:candidates,
            orphanCandidates,
            generatedAt:new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success:false, error:error.message || "Internal-link analysis failed." });
    }
});

/* Search Console CSV import helper. This endpoint only validates
   user-supplied rows; it never invents GSC metrics. The browser UI
   can parse a CSV export locally and send the normalized rows here. */

app.post("/api/monitor-snapshot", aiRateLimiter, async (req, res) => {
    try {
        const url = validateUrl(req.body.url);
        const keyword = String(req.body.keyword || "").trim().slice(0, 120);
        const country = resolveCountry(req.body.country);
        const fetched = await fetchWebpage(url);
        const page = extractPageContent(fetched.html, fetched.finalUrl);
        const evidence = deterministicPageEvidence(page, fetched.finalUrl);
        let rank = null, rankEvidence = null, scannedResults = 0;
        if (keyword) {
            let serp = await fetchSerpResults(keyword, { num: RANK_CHECK_SCAN_DEPTH, gl:country.gl, hl:country.hl, google_domain:country.google_domain });
            let exactVerification = await findExactPageMatchWithCanonical(serp, fetched.finalUrl, 10);
            let exact = exactVerification.match;
            if (!exact && serp.length < 100) {
                const deeper = await fetchSerpResults(keyword, { num:100, gl:country.gl, hl:country.hl, google_domain:country.google_domain });
                if (deeper.length > serp.length) serp = deeper;
                exactVerification = await findExactPageMatchWithCanonical(serp, fetched.finalUrl, 10);
                exact = exactVerification.match;
            }
            scannedResults = serp.length;
            if (exact) {
                rank = exact.position;
                rankEvidence = { position:exact.position, url:exact.link || exact.redirect_link || "", title:exact.title || "", snippet:exact.snippet || "", matchType:"exact-target-page", matchVerification:exactVerification.verification };
            } else {
                const domain = findRankMatch(serp, new URL(fetched.finalUrl).hostname);
                rankEvidence = domain
                    ? { position:domain.position, url:domain.link || domain.redirect_link || "", title:domain.title || "", snippet:domain.snippet || "", matchType:"domain-only-not-target-page" }
                    : { position:null, url:"", title:"", snippet:"", matchType:"not-found" };
            }
        }
        res.json({success:true, url, finalUrl:fetched.finalUrl, keyword, country:{code:country.code,label:country.label,googleDomain:country.google_domain}, evidence, rank, rankEvidence, scannedResults, checkedAt:new Date().toISOString()});
    } catch (error) {
        res.status(500).json({success:false,error:error.message || "Monitor snapshot failed."});
    }
});

app.post("/api/gsc-import", (req, res) => {
    try {
        const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 5000) : [];
        if (!rows.length) throw new Error("No Search Console rows supplied.");
        const allowed = ["query","page","clicks","impressions","ctr","position","country","device","date"];
        const normalized = rows.map(row => {
            const out = {};
            for (const key of allowed) {
                if (row && row[key] !== undefined) out[key] = row[key];
            }
            return out;
        });
        const numeric = key => normalized.reduce((sum,r) => sum + (Number(r[key]) || 0), 0);
        const impressions = numeric("impressions");
        const clicks = numeric("clicks");
        const weightedPosition = impressions
            ? normalized.reduce((sum,r) => sum + ((Number(r.position)||0) * (Number(r.impressions)||0)), 0) / impressions
            : null;
        res.json({
            success:true,
            source:"User-supplied Google Search Console export",
            rows:normalized.length,
            totals:{
                clicks,
                impressions,
                ctr:impressions ? clicks / impressions : null,
                averagePosition:weightedPosition
            },
            rows:normalized
        });
    } catch (error) {
        res.status(400).json({success:false,error:error.message || "Search Console import failed."});
    }
});

app.post("/api/export-pdf", (req,res) => {
    try {
        const pdf=buildSimplePdf(reportToPdfLines(req.body?.report));
        res.setHeader("Content-Type","application/pdf");
        res.setHeader("Content-Disposition",`attachment; filename="seo-report-${new Date().toISOString().slice(0,10)}.pdf"`);
        res.send(pdf);
    } catch(error) {
        res.status(500).json({success:false,error:error.message || "PDF export failed."});
    }
});


/* =========================================================
   PAGE SPEED API  –  POST /api/pagespeed
========================================================= */

/*
 * BUG FIX (slow / incomplete output): the previous version sent ONE request
 * asking Google's PSI API to run all 4 Lighthouse categories together.
 * PSI's audit runtime scales with how many categories are requested in a
 * single call — a combined 4-category run commonly takes 40-90s+ for mobile,
 * which regularly exceeded hosting/proxy timeouts and came back as "nothing
 * happened" with no partial data at all.
 *
 * Fix: request each category as its OWN parallel call (Promise.allSettled).
 * A single-category Lighthouse run is much faster on Google's side, and
 * since all 4 run concurrently, total wall time is roughly the slowest
 * *individual* category (~15-30s) instead of one huge combined run.
 * It also means if one category is slow/fails, the other three still come
 * back — the user gets real, partial results instead of a blank failure.
 */
const PAGESPEED_TIMEOUT_MS = 180000; // per single-category request, run in parallel
const PAGESPEED_CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

async function fetchPageSpeedCategory(url, strategy, category, key) {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${encodeURIComponent(strategy)}&category=${encodeURIComponent(category)}&key=${key}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGESPEED_TIMEOUT_MS);

    let r;
    try {
        r = await fetch(apiUrl, { signal: controller.signal });
    } catch (fetchErr) {
        if (fetchErr.name === "AbortError") {
            throw new Error(`timed out after ${PAGESPEED_TIMEOUT_MS / 1000}s`);
        }
        throw new Error("could not reach PageSpeed Insights");
    } finally {
        clearTimeout(timeout);
    }

    const rawText = await r.text();
    let data;
    try {
        data = JSON.parse(rawText);
    } catch {
        throw new Error(`non-JSON response (HTTP ${r.status}): ${rawText.slice(0, 150)}`);
    }

    if (data.error) {
        throw new Error((data.error.message || "PageSpeed API error") + (data.error.code ? ` (code ${data.error.code})` : ""));
    }

    return data;
}

app.post("/api/pagespeed", aiRateLimiter, async (req, res) => {
    try {
        // BUG FIX: this endpoint used to send req.body.url straight to Google's
        // PageSpeed API with no normalization. A bare domain like
        // "studyhours.com" (no http:// or https://) is not a valid absolute
        // URL, so Google rejected every category with a 400 "Request contains
        // an invalid argument." validateUrl() adds https:// when missing and
        // rejects genuinely malformed input, same as every other endpoint.
        const url = validateUrl(req.body.url);
        const strategy = (req.body && req.body.strategy) || "mobile";

        const key = (process.env.PAGESPEED_API_KEY || "").trim();
        if (!key) return res.status(400).json({ success: false, error: "PAGESPEED_API_KEY missing from .env" });

        const settled = await Promise.allSettled(
            PAGESPEED_CATEGORIES.map(category => fetchPageSpeedCategory(url, strategy, category, key))
        );

        // Merge whatever succeeded. cats/audits accumulate across the 4 calls
        // since each response only contains categories/audits for the ONE
        // category it was asked for.
        const cats = {};
        const audits = {};
        let cwv = {};
        const failed = [];

        settled.forEach((outcome, i) => {
            const category = PAGESPEED_CATEGORIES[i];
            if (outcome.status === "fulfilled") {
                const data = outcome.value;
                Object.assign(cats, data.lighthouseResult?.categories || {});
                Object.assign(audits, data.lighthouseResult?.audits || {});
                if (!Object.keys(cwv).length) cwv = data.loadingExperience?.metrics || {};
            } else {
                failed.push(`${category} (${outcome.reason?.message || outcome.reason})`);
            }
        });

        // Only a total failure (every category errored/timed out) is a hard
        // error now — any partial success still returns real data.
        if (!Object.keys(cats).length) {
            throw new Error(`PageSpeed audit failed for every category: ${failed.join("; ")}`);
        }

        // score() now returns null (not 0) for a category that failed to
        // load, so the UI can show "—" instead of a misleading "0 / Poor".
        const score = s => (s === undefined || s === null) ? null : Math.round(s * 100);

        const result = {
            url,
            strategy,
            scores: {
                performance:   score(cats.performance?.score),
                accessibility: score(cats.accessibility?.score),
                bestPractices: score(cats["best-practices"]?.score),
                seo:           score(cats.seo?.score)
            },
            metrics: {
                fcp:  audits["first-contentful-paint"]?.displayValue  || "—",
                lcp:  audits["largest-contentful-paint"]?.displayValue || "—",
                tbt:  audits["total-blocking-time"]?.displayValue      || "—",
                cls:  audits["cumulative-layout-shift"]?.displayValue  || "—",
                si:   audits["speed-index"]?.displayValue              || "—",
                tti:  audits["interactive"]?.displayValue              || "—"
            },
            cwv: {
                fcp: cwv.FIRST_CONTENTFUL_PAINT_MS  || null,
                lcp: cwv.LARGEST_CONTENTFUL_PAINT_MS || null,
                fid: cwv.FIRST_INPUT_DELAY_MS        || null,
                cls: cwv.CUMULATIVE_LAYOUT_SHIFT_SCORE || null
            },
            opportunities: Object.values(audits)
                .filter(a => a.score !== null && a.score < 0.9 && a.details?.type === "opportunity" && a.details?.overallSavingsMs > 100)
                .sort((a,b) => (b.details?.overallSavingsMs||0) - (a.details?.overallSavingsMs||0))
                .slice(0, 8)
                .map(a => ({ id: a.id, title: a.title, savings: a.displayValue, description: a.description })),
            diagnostics: Object.values(audits)
                .filter(a => a.score !== null && a.score < 0.9 && a.details?.type === "table" && a.id !== "screenshot-thumbnails")
                .slice(0, 6)
                .map(a => ({ id: a.id, title: a.title, score: a.score, displayValue: a.displayValue })),
            // Categories that failed still surface as a warning instead of
            // silently vanishing, so the user knows the output is partial.
            warnings: failed.length ? failed.map(f => `Could not complete: ${f}`) : []
        };

        return res.json({ success: true, result });
    } catch (err) {
        console.error("PageSpeed error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/* =========================================================
   OPEN PAGE RANK API  –  POST /api/domain-authority
========================================================= */
const OPENPR_TIMEOUT_MS = 20000;

app.post("/api/domain-authority", aiRateLimiter, async (req, res) => {
    try {
        const { domains } = req.body || {};
        if (!domains || !domains.length) return res.status(400).json({ success: false, error: "domains array required" });

        const key = (process.env.OPENPR_API_KEY || "").trim();
        if (!key) return res.status(400).json({ success: false, error: "OPENPR_API_KEY missing from .env" });
        if (key === "your_api_key_here" || /\s/.test(key)) {
            return res.status(400).json({ success: false, error: "OPENPR_API_KEY in .env looks like a placeholder or contains whitespace — copy the key fresh from your OpenPageRank dashboard." });
        }

        const cleaned = domains.slice(0, 100).map(d =>
            String(d).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim()
        ).filter(Boolean);
        if (!cleaned.length) return res.status(400).json({ success: false, error: "No valid domains after cleaning input." });

        const qs = cleaned.map(d => `domains[]=${encodeURIComponent(d)}`).join("&");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), OPENPR_TIMEOUT_MS);
        let r;
        try {
            r = await fetch(`https://openpagerank.com/api/v1.0/getPageRank?${qs}`, {
                headers: { "API-OPR": key },
                signal: controller.signal
            });
        } catch (fetchErr) {
            if (fetchErr.name === "AbortError") throw new Error(`OpenPageRank request timed out after ${OPENPR_TIMEOUT_MS / 1000}s.`);
            throw new Error("Could not reach OpenPageRank. Check your network connection.");
        } finally {
            clearTimeout(timeout);
        }

        const rawText = await r.text();
        let data;
        try {
            data = JSON.parse(rawText);
        } catch {
            // OpenPageRank (or a proxy in front of it) returned something that
            // isn't JSON at all — surface the raw body so the real cause
            // (rate limiting, an HTML error page, a network block, etc.)
            // is visible instead of a generic "invalid API key" guess.
            throw new Error(`OpenPageRank returned a non-JSON response (HTTP ${r.status}): ${rawText.slice(0, 200)}`);
        }

        // The API reports auth/plan failures a few different ways depending on
        // where the failure happens — check all of them and always include the
        // HTTP status so "invalid key" vs "rate limited" vs something else is
        // actually distinguishable instead of collapsing into one message.
        const topLevelError = data.error || data.message || (typeof data.response === "string" ? data.response : null);
        if (!r.ok || topLevelError) {
            // A 401/403 here is OpenPageRank's OWN server rejecting the key —
            // it is not something wrong in this app's request (the header
            // "API-OPR" and "domains[]=" query format are exactly what
            // OpenPageRank's docs specify, and this code sends them correctly).
            // Give a checklist instead of just repeating the raw message, since
            // "Invalid API key" alone doesn't tell the user what to actually do.
            if (r.status === 401 || r.status === 403) {
                throw new Error(
                    `OpenPageRank rejected this API key (HTTP ${r.status}: ${topLevelError || "Invalid API key"}). ` +
                    `This means the key value in your .env is wrong, expired, or not yet active — not a bug in the app. To fix it: ` +
                    `(1) log in at openpagerank.com/auth/login and open your dashboard, ` +
                    `(2) copy the key fresh (don't retype it — copy/paste to avoid missing/extra characters), ` +
                    `(3) if you just signed up, confirm the activation link OpenPageRank emailed you — keys don't work until that's clicked, ` +
                    `(4) paste it into .env as OPENPR_API_KEY=yourkey with no quotes and no spaces around the "=", then restart the server. ` +
                    `You can check what's currently loaded (without exposing the key) at GET /api/env-check.`
                );
            }
            throw new Error(`OpenPageRank error (HTTP ${r.status}${data.status_code ? `, status_code ${data.status_code}` : ""}): ${topLevelError || "Request rejected."}`);
        }

        const results = (Array.isArray(data.response) ? data.response : []).map(item => ({
            domain:   item.domain,
            pr:       item.page_rank_integer  ?? 0,
            prDecimal:item.page_rank_decimal  ?? 0,
            rank:     item.rank               || null,
            status:   item.status_code,
            error:    item.error || ""
        }));

        return res.json({ success: true, results, lastUpdated: data.last_updated });
    } catch (err) {
        console.error("Domain authority error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/* =========================================================
   GOOGLE TRENDS API  –  POST /api/trends
========================================================= */
app.post("/api/trends", aiRateLimiter, async (req, res) => {
    try {
        const { keyword, geo = "", timeframe = "today 12-m" } = req.body || {};
        if (!keyword) return res.status(400).json({ success: false, error: "keyword required" });

        const [overTimeRaw, relatedRaw] = await Promise.allSettled([
            googleTrends.interestOverTime({ keyword, geo, startTime: new Date(Date.now() - 365*24*60*60*1000) }),
            googleTrends.relatedQueries({ keyword, geo })
        ]);

        let timeline = [], related = { rising: [], top: [] };
        const warnings = [];

        if (overTimeRaw.status === "fulfilled") {
            const parsed = JSON.parse(overTimeRaw.value);
            timeline = (parsed.default?.timelineData || []).map(t => ({
                date:  new Date(parseInt(t.time) * 1000).toISOString().slice(0,10),
                value: t.value?.[0] || 0
            }));
        } else {
            console.error("Trends interestOverTime failed:", overTimeRaw.reason);
            warnings.push("Could not fetch the interest-over-time chart from Google Trends.");
        }

        if (relatedRaw.status === "fulfilled") {
            const parsed = JSON.parse(relatedRaw.value);
            const rq = parsed.default?.rankedList || [];
            related.rising = (rq[1]?.rankedKeyword || []).slice(0,10).map(k => ({ query: k.query, value: k.formattedValue }));
            related.top    = (rq[0]?.rankedKeyword || []).slice(0,10).map(k => ({ query: k.query, value: k.formattedValue }));
        } else {
            console.error("Trends relatedQueries failed:", relatedRaw.reason);
            warnings.push("Could not fetch related queries from Google Trends.");
        }

        // Fallback: if the npm Google Trends adapter is blocked/rate-limited,
        // ask SerpApi for a real Google Trends timeseries + related queries.
        if (overTimeRaw.status === "rejected" && !timeline.length && getSerpApiKey()) {
            try {
                const c = resolveCountry(geo || SERPAPI_DEFAULT_COUNTRY);
                const key = getSerpApiKey();
                const qs = new URLSearchParams({engine:"google_trends",q:String(keyword),data_type:"TIMESERIES",date:"today 12-m",geo:c.gl,api_key:key});
                const r = await fetch(`https://serpapi.com/search.json?${qs.toString()}`);
                const d = await r.json();
                const series = d.interest_over_time?.timeline_data || d.timeline_data || [];
                timeline = series.map(x => ({date: new Date(Number(x.timestamp || x.time || 0) * 1000).toISOString().slice(0,10), value:Number(x.values?.[0]?.extracted_value ?? x.value?.[0] ?? x.values?.[0]?.value ?? 0)})).filter(x => Number.isFinite(x.value));
                if (timeline.length) warnings.push("Google Trends npm adapter was unavailable; the chart was recovered from SerpApi Google Trends data.");
            } catch (fallbackErr) {
                warnings.push(`SerpApi Trends fallback failed: ${fallbackErr.message}`);
            }
        }
        if (relatedRaw.status === "rejected" && !related.rising.length && getSerpApiKey()) {
            try {
                const c = resolveCountry(geo || SERPAPI_DEFAULT_COUNTRY);
                const key = getSerpApiKey();
                const qs = new URLSearchParams({engine:"google_trends",q:String(keyword),data_type:"RELATED_QUERIES",date:"today 12-m",geo:c.gl,api_key:key});
                const r = await fetch(`https://serpapi.com/search.json?${qs.toString()}`);
                const d = await r.json();
                const blocks = d.related_queries || d.relatedQueries || {};
                const top = blocks.top || []; const rising = blocks.rising || [];
                related.top = top.slice(0,10).map(x=>({query:x.query||x.keyword||"",value:String(x.value ?? x.extracted_value ?? "")})).filter(x=>x.query);
                related.rising = rising.slice(0,10).map(x=>({query:x.query||x.keyword||"",value:String(x.value ?? x.extracted_value ?? "")})).filter(x=>x.query);
            } catch (fallbackErr) { warnings.push(`SerpApi related-query fallback failed: ${fallbackErr.message}`); }
        }

        // If BOTH providers failed, return a clear error instead of a blank chart.
        if (!timeline.length && !related.rising.length && !related.top.length) {
            const reason = (overTimeRaw.reason && overTimeRaw.reason.message) || String(overTimeRaw.reason);
            throw new Error(`Google Trends request failed (it has no official API and often rate-limits or blocks server IPs): ${reason}`);
        }

        // Compute avg and trend direction
        const values = timeline.map(t => t.value);
        const avg = values.length ? Math.round(values.reduce((a,b) => a+b,0) / values.length) : 0;
        const recentAvg = values.slice(-4).reduce((a,b) => a+b,0) / (values.slice(-4).length || 1);
        const oldAvg    = values.slice(0,4).reduce((a,b) => a+b,0)  / (values.slice(0,4).length || 1);
        const trend = values.length ? (recentAvg > oldAvg * 1.1 ? "rising" : recentAvg < oldAvg * 0.9 ? "falling" : "stable") : "unknown";

        return res.json({ success: true, keyword, timeline, related, warnings, stats: { avg, trend, peak: values.length ? Math.max(...values) : 0 } });
    } catch (err) {
        console.error("Trends error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/* =========================================================
   OPTIONAL PYTHON SEO ENGINE PROXY
   Set PYTHON_ENGINE_URL (for example https://your-engine.onrender.com)
========================================================= */
const PYTHON_ENGINE_URL = PYTHON_SEO_ENGINE_URL;

/* =========================================================
   PYTHON-BACKED TECHNICAL SEO CHECK
   Browser -> Node.js -> Python FastAPI -> real page fetch
   The Python engine is the source of truth for this section.
========================================================= */
app.post("/api/technical-check", async (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
        return res.status(400).json({ success: false, error: "URL is required." });
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 180000);
        let response;
        try {
            response = await fetch(`${PYTHON_ENGINE_URL}/technical`, {
                method: "POST",
                headers: engineHeaders({ "Content-Type": "application/json", "Accept": "application/json" }),
                body: JSON.stringify({ url }),
                signal: controller.signal
            });
        } finally { clearTimeout(timer); }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            return res.status(response.status).json({
                success: false,
                error: data.detail || data.error || "Python SEO Engine rejected the URL."
            });
        }

        const t = data.technical || {};
        const page = t.page || {};
        const checks = [];

        const add = (status, name, details) => {
            checks.push({
                status: status === "pass" ? "pass" : status === "fail" ? "fail" : "warning",
                name,
                details
            });
        };

        const https = Boolean(t.https);
        add(https ? "pass" : "fail", "HTTPS", https
            ? "The final URL is served over HTTPS."
            : "The final URL is not using HTTPS.");

        const statusCode = Number(page.status_code);
        add(Number.isFinite(statusCode) && statusCode >= 200 && statusCode < 400 ? "pass" : "fail",
            "HTTP status",
            Number.isFinite(statusCode) ? `Final page returned HTTP ${statusCode}.` : "The HTTP status could not be verified.");

        const redirectCount = Number(t.redirect_count || 0);
        add(redirectCount <= 1 ? "pass" : "warning",
            "Redirect chain",
            `The request followed ${redirectCount} redirect${redirectCount === 1 ? "" : "s"}.`);

        add(page.viewport ? "pass" : "warning",
            "Mobile viewport",
            page.viewport ? "A viewport meta tag was detected." : "No viewport meta tag was detected.");

        add(page.canonical ? "pass" : "warning",
            "Canonical URL",
            page.canonical ? `Canonical: ${page.canonical}` : "No canonical link was detected.");

        const robots = t.robots_txt || {};
        add(robots.found ? "pass" : "warning",
            "robots.txt",
            robots.found ? `robots.txt returned HTTP ${robots.status}.` : "robots.txt was not found with HTTP 200.");

        const sitemap = t.sitemap || {};
        add(sitemap.found ? "pass" : "warning",
            "XML sitemap",
            sitemap.found ? `sitemap.xml returned HTTP ${sitemap.status}.` : "sitemap.xml was not found with HTTP 200.");

        const robotsDirective = String(page.robots || "");
        add(/noindex/i.test(robotsDirective) ? "fail" : "pass",
            "Indexability directive",
            robotsDirective
                ? `Robots meta directive: ${robotsDirective}`
                : "No robots meta directive was detected, so no page-level noindex was observed.");

        const internalLinks = Number(page.internal_links || 0);
        add(internalLinks > 0 ? "pass" : "warning",
            "Internal links",
            `${internalLinks} same-domain internal link${internalLinks === 1 ? "" : "s"} detected.`);

        const contentType = String(page.content_type || "");
        add(/text\/html/i.test(contentType) ? "pass" : "warning",
            "HTML content type",
            contentType ? `Content-Type: ${contentType}` : "Content-Type was not reported.");

        const schemaBlocks = Number(page.schema_blocks || 0);
        add(schemaBlocks > 0 ? "pass" : "warning",
            "Structured data signal",
            schemaBlocks > 0
                ? `${schemaBlocks} JSON-LD block${schemaBlocks === 1 ? "" : "s"} detected.`
                : "No JSON-LD structured data blocks were detected.");

        const failed = checks.filter(c => c.status === "fail").length;
        const warnings = checks.filter(c => c.status === "warning").length;
        const score = Number.isFinite(Number(data.score)) ? Number(data.score) : scoreVerifiedChecks(checks);
        const overall_status = failed ? "Critical" : warnings ? "Needs Attention" : "Healthy";

        return res.json({
            success: true,
            source: "Python FastAPI SEO Engine",
            engineUrl: PYTHON_ENGINE_URL,
            url: page.url || url,
            technical: t,
            audit: {
                overall_status,
                score,
                checks
            }
        });
    } catch (error) {
        console.error("PYTHON TECHNICAL SEO ERROR:", error);
        return res.status(502).json({
            success: false,
            error: `Could not reach the Python SEO Engine at ${PYTHON_SEO_ENGINE_URL}. Start it on port 8000 or set PYTHON_ENGINE_URL.`
        });
    }
});

app.post("/api/python-engine/:endpoint", async (req, res) => {
    const user = await requireAgentUser(req,res);
    if (!user) return;
    if (!PYTHON_ENGINE_URL) {
        return res.status(503).json({ success:false, error:"Python SEO Engine is not connected. Set PYTHON_ENGINE_URL after deploying seo-engine." });
    }
    const allowed = PYTHON_SEO_ENDPOINTS;
    const endpoint = String(req.params.endpoint || "");
    if (!allowed.has(endpoint)) return res.status(404).json({ success:false, error:"Unknown Python engine endpoint." });
    try {
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),180000);
        let response;
        try {
            response = await fetch(`${PYTHON_SEO_ENGINE_URL}/${endpoint}`, {
                method:"POST", headers:engineHeaders({"Content-Type":"application/json","Accept":"application/json","Cache-Control":"no-store"}), body:JSON.stringify(req.body || {}), signal:controller.signal
            });
        } finally { clearTimeout(timer); }
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
            ? await response.json()
            : { success:false, error:(await response.text()).slice(0,500) || `Python SEO Engine returned HTTP ${response.status}.` };
        // FastAPI commonly returns errors as {detail: "..."}; normalize that
        // to the frontend's {error: "..."} contract so users never see only
        // a useless generic "Request failed with status 503" message.
        if (!response.ok && !data.error) data.error = typeof data.detail === "string" ? data.detail : `Python SEO Engine request failed with status ${response.status}.`;
        if (typeof data.success === "undefined") data.success = response.ok;
        return res.status(response.status).json(data);
    } catch (error) {
        return res.status(502).json({ success:false, error:"Could not reach the Python SEO Engine.", details:error.message });
    }
});


/* =========================================================
   START SERVER
========================================================= */



/* =========================================================
   ENV DEBUG ENDPOINT
========================================================= */

app.get("/api/env-check", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const serpKey     = getSerpApiKey();
    const geminiKey   = GEMINI_API_KEY;
    const pagespeedKey= (process.env.PAGESPEED_API_KEY|| "").trim();
    const openprKey   = (process.env.OPENPR_API_KEY   || "").trim();
    let dbStatus = "unavailable";
    try { await dbHealth(); dbStatus = "healthy"; } catch (_) {}
    res.json({
        DATABASE: dbStatus,
        GEMINI_API_KEY:    geminiKey    ? `set (${geminiKey.length} chars)`    : "MISSING",
        SERPAPI_KEY:       serpKey      ? `set (${serpKey.length} chars)`      : "MISSING",
        PAGESPEED_API_KEY: pagespeedKey ? `set (${pagespeedKey.length} chars)` : "MISSING",
        OPENPR_API_KEY:    openprKey    ? `set (${openprKey.length} chars)`    : "MISSING",
        GROQ_API_KEY:      GROQ_API_KEY ? `set (${GROQ_API_KEY.length} chars)` : "MISSING",
        GROQ_MODEL,
        NODE_ENV:       process.env.NODE_ENV || "(not set)",
        PYTHON_ENGINE_URL: PYTHON_SEO_ENGINE_URL,
        PYTHON_ENGINE_AUTOSTART: AUTO_START_PYTHON_ENGINE ? "enabled" : "disabled",
        PYTHON_ENGINE_PROCESS: pythonEngineProcess ? "running" : "not running",
        PYTHON_ENGINE_SPAWN_ERROR: pythonEngineSpawnError || "",
        ENGINE_SHARED_SECRET: ENGINE_SHARED_SECRET ? "set" : "not set"
    });
});


/* =========================================================
   SEO AGENT PHASE 1-5: persistent projects, history, monitoring,
   AI advisor, content refresh, strategy and PDF reports.
========================================================= */
async function userProjects(userId) {
    const result = await query(`SELECT id, name, url, created_at AS "createdAt", last_audit_at AS "lastAuditAt" FROM projects WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [userId]);
    return result.rows;
}

async function addAlert(userId, alert) {
    await query(`INSERT INTO alerts (id,user_id,url,created_at,score,critical,warnings,message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
        alert.id, userId, alert.url || null, alert.createdAt || new Date(), alert.score ?? null, Number(alert.critical || 0), Number(alert.warnings || 0), alert.message || "SEO alert"
    ]);
}

async function recordAgentAuditRun(userId, url, result, errorMessage=null) {
    const id=crypto.randomUUID();
    const score=result?.score ?? result?.audit?.score ?? null;
    const status=errorMessage ? "failed" : "completed";
    await query(`INSERT INTO audit_runs (id,user_id,url,status,score,started_at,completed_at,error_message,result) VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),$6,$7::jsonb)`,[id,userId,url,status,score,errorMessage||null,JSON.stringify(result||{})]);
    return id;
}

app.get("/api/agent/projects",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{res.json({success:true,projects:await userProjects(u.userId)});}catch(e){res.status(500).json({success:false,error:"Could not load projects."});}});
app.post("/api/agent/projects",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;const rawUrl=String(req.body?.url||"").trim();let url="";try{url=normalizeComparableUrl(validateUrl(rawUrl));}catch(e){return res.status(400).json({success:false,error:e.message||"Enter a valid website URL."});}const name=String(req.body?.name||"").trim()||url;if(!url)return res.status(400).json({success:false,error:"Enter a complete website URL beginning with http:// or https://."});try{const existing=await query(`SELECT id,name,url,created_at AS "createdAt",last_audit_at AS "lastAuditAt" FROM projects WHERE user_id=$1 AND url=$2 LIMIT 1`,[u.userId,url]);let pr=existing.rows[0];if(!pr){const id=crypto.randomUUID();const r=await query(`INSERT INTO projects (id,user_id,name,url) VALUES ($1,$2,$3,$4) RETURNING id,name,url,created_at AS "createdAt",last_audit_at AS "lastAuditAt"`,[id,u.userId,name,url]);pr=r.rows[0];}res.json({success:true,project:pr,projects:await userProjects(u.userId)});}catch(e){if(e.code==='23505')return res.status(409).json({success:false,error:"This project already exists."});res.status(500).json({success:false,error:"Could not save project."});}});
app.delete("/api/agent/projects/:id",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{await query(`DELETE FROM projects WHERE id=$1 AND user_id=$2`,[req.params.id,u.userId]);res.json({success:true,projects:await userProjects(u.userId)});}catch(e){res.status(500).json({success:false,error:"Could not delete project."});}});

app.post("/api/agent/dashboard",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;let url="";try{url=normalizeComparableUrl(validateUrl(req.body?.url));const data=await pythonPost("agent-dashboard",{url});await recordAgentAuditRun(u.userId,url,data);res.json(data)}catch(e){if(url)await recordAgentAuditRun(u.userId,url,{},e.message).catch(()=>{});res.status(502).json({success:false,error:e.message})}});
app.post("/api/agent/action-center",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;let url="";try{url=normalizeComparableUrl(validateUrl(req.body?.url));const data=await pythonPost("agent-action-center",{url});await recordAgentAuditRun(u.userId,url,data);res.json(data)}catch(e){if(url)await recordAgentAuditRun(u.userId,url,{},e.message).catch(()=>{});res.status(502).json({success:false,error:e.message})}});
app.post("/api/agent/keyword-gap",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{res.json(await pythonPost("agent-keyword-gap",req.body||{}))}catch(e){res.status(502).json({success:false,error:e.message})}});
app.post("/api/agent/content-decay",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{res.json(await pythonPost("agent-content-decay",req.body||{}))}catch(e){res.status(502).json({success:false,error:e.message})}});
app.post("/api/agent/rank-history",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const incoming=req.body||{};const targetUrl=normalizeComparableUrl(validateUrl(incoming.url));const country=resolveCountry(incoming.country);const rows=[];for(const keyword of (Array.isArray(incoming.keywords)?incoming.keywords:[]).map(x=>String(x).trim()).filter(Boolean).slice(0,30)){const d=await pythonPost("rank-check",{url:targetUrl,keyword,country:country.code});const position=d.position ?? d.rank ?? null;rows.push({keyword,position,checkedAt:new Date().toISOString(),country:country.label});}const snap={date:new Date().toISOString(),url:targetUrl,country:country.code,keywords:rows};await query(`INSERT INTO rank_snapshots (id,user_id,url,country,snapshot_at,keywords) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[crypto.randomUUID(),u.userId,targetUrl,country.code,snap.date,JSON.stringify(rows)]);const result=await query(`SELECT snapshot_at AS "date",url,country,keywords FROM rank_snapshots WHERE user_id=$1 AND url=$2 ORDER BY snapshot_at DESC LIMIT 200`,[u.userId,targetUrl]);const history=result.rows.map(x=>({date:new Date(x.date).toISOString(),url:x.url,country:x.country,keywords:x.keywords})).reverse();const analyzed=await pythonPost("agent-rank-history",{snapshots:history});res.json({success:true,snapshot:snap,history:history,series:analyzed.series});}catch(e){res.status(502).json({success:false,error:e.message})}});
app.get("/api/agent/rank-history",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const r=await query(`SELECT snapshot_at AS "date",url,country,keywords FROM rank_snapshots WHERE user_id=$1 ORDER BY snapshot_at DESC LIMIT 200`,[u.userId]);res.json({success:true,history:r.rows.map(x=>({date:new Date(x.date).toISOString(),url:x.url,country:x.country,keywords:x.keywords}))});}catch(e){res.status(500).json({success:false,error:"Could not load rank history."});}});

async function aiJson(prompt,maxTokens=2200){const text=await generateAI(prompt,maxTokens,0.2);if(!text.trim())throw new Error("Gemini returned an empty response.");return parseModelJSON(text);}

/* Evidence-grounded conversational SEO assistant. It uses the same verified
   Python evidence as the rest of the product, so the chat cannot silently
   manufacture rankings, traffic, backlinks or search volume. */
app.post("/api/agent/ask", async (req,res) => {
    const u = await requireAgentUser(req,res);
    if (!u) return;
    try {
        const url = String(req.body?.url || "").trim();
        const question = String(req.body?.question || "").trim();
        if (!url) return res.status(400).json({success:false,error:"Enter a website URL for the AI assistant."});
        if (!question) return res.status(400).json({success:false,error:"Enter a question for the AI assistant."});
        if (question.length > 1200) return res.status(400).json({success:false,error:"Question is too long. Keep it under 1,200 characters."});

        const verified = await pythonPost("agent-dashboard",{url});
        const prompt = `You are the conversational AI assistant inside a professional SEO intelligence platform.
Answer the user's question using ONLY the verified SEO evidence supplied below.
Do not invent traffic, rankings, backlinks, search volume, Search Console data, competitor data, or guarantees.
If the evidence does not answer the question, say what is missing and suggest the relevant tool in this application.
Be concise, practical and specific. Return JSON: {"answer":"...","actions":[{"title":"...","what_to_do":"..."}],"evidence":["..."]}.
USER QUESTION:
${question}
VERIFIED SEO EVIDENCE:
${JSON.stringify(verified)}`;

        const aiAnswer = await aiJson(prompt,2200);
        res.json({success:true,url,question,verified,answer:aiAnswer});
    } catch(e) {
        res.status(500).json({success:false,error:e.message});
    }
});
app.post("/api/agent/ai-advisor",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const url=String(req.body?.url||"").trim();const dashboard=await pythonPost("agent-dashboard",{url});const prompt=`You are the SEO Advisor inside a professional SEO application. Explain findings in plain, user-readable language. Use ONLY the verified data below. Do not invent traffic, rankings, backlinks, search volume, or Search Console data. Return detailed JSON with summary, executive_explanation, priorities (array of {priority,title,what_to_do,why_it_matters,evidence,expected_signal,implementation_steps}), quick_wins, next_7_days, risks, measurement_plan, plain_language_takeaway. Keep every statement grounded in the verified data.\nVERIFIED DATA:\n${JSON.stringify(dashboard)}`;const ai=await aiJson(prompt);res.json({success:true,url,verified:dashboard,advisor:ai});}catch(e){res.status(500).json({success:false,error:e.message})}});
app.post("/api/agent/content-refresh",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const url=String(req.body?.url||"").trim();const p=await pythonPost("analyze",{url});const prompt=`Act as an SEO content editor. Rewrite recommendations in clear language and produce a practical refresh brief based ONLY on this verified page evidence. Do not invent ranking, traffic or competitor data. Return detailed JSON: {diagnosis,executive_explanation,refresh_plan:[{priority,title,what_to_change,why_it_matters,evidence,implementation_steps}],recommended_outline:[{heading,purpose,coverage}],draft_opening,quality_checklist,measurement_plan}.\nEVIDENCE:\n${JSON.stringify(p.evidence||p)}`;const ai=await aiJson(prompt,2600);res.json({success:true,url,evidence:p.evidence||p,refresh:ai});}catch(e){res.status(500).json({success:false,error:e.message})}});
app.post("/api/agent/ai-strategy",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const url=String(req.body?.url||"").trim();const dash=await pythonPost("agent-dashboard",{url});const actions=await pythonPost("agent-action-center",{url});const prompt=`Create a 30-day SEO strategy in plain language from this verified evidence. Do not claim guaranteed rankings or fabricate metrics. Return detailed JSON with executive_summary, weeks (array of {week,goal,actions,deliverables,measurement}), goals, priorities, dependencies, risks, success_measurement, operating_principles.\nDASHBOARD:${JSON.stringify(dash)}\nACTIONS:${JSON.stringify(actions)}`;res.json({success:true,url,strategy:await aiJson(prompt,2600),verified:{dashboard:dash,actions}});}catch(e){res.status(500).json({success:false,error:e.message})}});

app.get("/api/agent/monitor/jobs",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const r=await query(`SELECT id,url,every_hours AS "everyHours",next_run_at AS "nextRunAt",enabled,last_run_at AS "lastRunAt",created_at AS "createdAt" FROM monitor_jobs WHERE user_id=$1 ORDER BY created_at DESC`,[u.userId]);res.json({success:true,jobs:r.rows});}catch(e){res.status(500).json({success:false,error:"Could not load monitoring jobs."});}});
app.post("/api/agent/monitor/jobs",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;let url="";try{url=normalizeComparableUrl(validateUrl(req.body?.url));}catch(e){return res.status(400).json({success:false,error:e.message||"Enter a valid website URL."});}const hours=Math.min(Math.max(Number(req.body?.hours||24),1),720);try{const job={id:crypto.randomUUID(),url,everyHours:hours,nextRunAt:new Date(Date.now()+hours*3600000),enabled:true};await query(`INSERT INTO monitor_jobs (id,user_id,url,every_hours,next_run_at,enabled) VALUES ($1,$2,$3,$4,$5,$6)`,[job.id,u.userId,url,hours,job.nextRunAt,true]);res.json({success:true,job:{...job,nextRunAt:job.nextRunAt.toISOString(),lastRunAt:null,createdAt:new Date().toISOString()}});}catch(e){res.status(500).json({success:false,error:"Could not create monitoring job."});}});
app.patch("/api/agent/monitor/jobs/:id",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const fields=[];const params=[];let i=1;if(req.body?.enabled!==undefined){fields.push(`enabled=$${i++}`);params.push(Boolean(req.body.enabled));}if(req.body?.hours!==undefined){const hours=Math.min(Math.max(Number(req.body.hours),1),720);fields.push(`every_hours=$${i++}`);params.push(hours);}if(!fields.length)return res.status(400).json({success:false,error:"No changes supplied."});params.push(req.params.id,u.userId);const r=await query(`UPDATE monitor_jobs SET ${fields.join(", ")} WHERE id=$${i++} AND user_id=$${i} RETURNING id,url,every_hours AS "everyHours",next_run_at AS "nextRunAt",enabled,last_run_at AS "lastRunAt",created_at AS "createdAt"`,params);if(!r.rows[0])return res.status(404).json({success:false,error:"Monitoring job not found."});res.json({success:true,job:r.rows[0]});}catch(e){res.status(500).json({success:false,error:"Could not update monitoring job."});}});
app.delete("/api/agent/monitor/jobs/:id",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const r=await query(`DELETE FROM monitor_jobs WHERE id=$1 AND user_id=$2`,[req.params.id,u.userId]);if(!r.rowCount)return res.status(404).json({success:false,error:"Monitoring job not found."});res.json({success:true});}catch(e){res.status(500).json({success:false,error:"Could not delete monitoring job."});}});
app.post("/api/agent/monitor/run",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{let url="";url=normalizeComparableUrl(validateUrl(req.body?.url));const snap=await pythonPost("monitor-snapshot",{url});const s=snap.snapshot||snap;const previousResult=await query(`SELECT score,critical,warnings FROM monitor_snapshots WHERE user_id=$1 AND url=$2 ORDER BY snapshot_at DESC LIMIT 1`,[u.userId,url]);const previous=previousResult.rows[0]||null;await query(`INSERT INTO monitor_snapshots (id,user_id,url,score,critical,warnings,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,[crypto.randomUUID(),u.userId,url,s.score??null,Number(s.critical||0),Number(s.warnings||0),JSON.stringify(s)]);const scoreChange=previous&&s.score!=null&&previous.score!=null?Number(s.score)-Number(previous.score):null;const message=(s.critical||0)>0?`Your site has ${s.critical} critical SEO issue(s) that need fixing.`:(scoreChange!==null&&scoreChange<0)?`Your SEO score dropped ${Math.abs(scoreChange).toFixed(1)} points since the previous snapshot.`:(s.warnings||0)>0?`Your site has ${s.warnings} SEO warning(s) to review.`:"No new critical SEO problems were detected in this snapshot.";const alert={id:crypto.randomUUID(),url,createdAt:new Date().toISOString(),score:s.score,critical:s.critical||0,warnings:s.warnings||0,message};await addAlert(u.userId,alert);res.json({success:true,snapshot:s,previous,scoreChange,alert});}catch(e){res.status(502).json({success:false,error:e.message})}});
app.get("/api/agent/alerts",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const r=await query(`SELECT id,url,created_at AS "createdAt",score,critical,warnings,message,read_at AS "readAt" FROM alerts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[u.userId]);res.json({success:true,alerts:r.rows});}catch(e){res.status(500).json({success:false,error:"Could not load alerts."});}});

app.post("/api/agent/report-pdf",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),180000);let r;try{r=await fetch(`${PYTHON_SEO_ENGINE_URL}/agent-report-pdf`,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/pdf","Cache-Control":"no-store"},body:JSON.stringify({report:req.body?.report||{}}),signal:controller.signal});}finally{clearTimeout(timer);}const buf=Buffer.from(await r.arrayBuffer());if(!r.ok)return res.status(502).json({success:false,error:buf.toString().slice(0,500)});res.set("Content-Type","application/pdf");res.set("Content-Disposition","attachment; filename=seo-agent-report.pdf");res.send(buf);}catch(e){res.status(502).json({success:false,error:e.name==="AbortError"?"PDF generation timed out.":e.message})}});

/* =========================================================
   ADMIN DASHBOARD (Phase 1)
   Read-only counts drawn directly from PostgreSQL. No metric on
   this endpoint is invented — every figure is a live COUNT/GROUP BY
   against the same tables the app itself writes to.
========================================================= */
app.get("/api/admin/health", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const started = Date.now();
    const health = {
        overall: "degraded",
        database: { status: "unavailable", latencyMs: null },
        python: { status: "unavailable", latencyMs: null, url: PYTHON_SEO_ENGINE_URL },
        uptimeSeconds: process.uptime(),
        memory: { rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) }
    };
    try {
        const dbStart = Date.now();
        await query("SELECT 1 AS ok");
        health.database = { status: "healthy", latencyMs: Date.now() - dbStart };
    } catch (error) {
        console.error("Admin health database error:", error);
    }
    try {
        const pyStart = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(`${PYTHON_SEO_ENGINE_URL}/health`, { signal: controller.signal });
        clearTimeout(timer);
        health.python = {
            status: r.ok ? "healthy" : "error",
            latencyMs: Date.now() - pyStart,
            url: PYTHON_SEO_ENGINE_URL
        };
    } catch (error) {
        health.python = {
            status: "unavailable",
            latencyMs: null,
            url: PYTHON_SEO_ENGINE_URL,
            error: error.name === "AbortError" ? "Health check timed out." : "Engine unavailable."
        };
    }
    health.overall = health.database.status === "healthy" && health.python.status === "healthy"
        ? "healthy" : "degraded";
    res.json({ success: true, generatedAt: new Date().toISOString(), durationMs: Date.now() - started, health });
});

app.get("/api/admin/stats", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const [
            usersTotal,
            usersByRole,
            projectsTotal,
            auditRunsByStatus,
            rankSnapshotsTotal,
            monitorJobsTotal,
            monitorJobsActive,
            alertsTotal,
            alertsUnread,
            sessionsActive,
            recentUsers,
            recentAuditRuns,
            recentAdminActions,
            telemetryToday,
            apiToday
        ] = await Promise.all([
            query(`SELECT COUNT(*)::int AS c FROM users`),
            query(`SELECT role, COUNT(*)::int AS c FROM users GROUP BY role`),
            query(`SELECT COUNT(*)::int AS c FROM projects`),
            query(`SELECT status, COUNT(*)::int AS c FROM audit_runs GROUP BY status`),
            query(`SELECT COUNT(*)::int AS c FROM rank_snapshots`),
            query(`SELECT COUNT(*)::int AS c FROM monitor_jobs`),
            query(`SELECT COUNT(*)::int AS c FROM monitor_jobs WHERE enabled = TRUE`),
            query(`SELECT COUNT(*)::int AS c FROM alerts`),
            query(`SELECT COUNT(*)::int AS c FROM alerts WHERE read_at IS NULL`),
            query(`SELECT COUNT(*)::int AS c FROM sessions WHERE expires_at > NOW()`),
            query(`SELECT id, username, email, role, created_at AS "createdAt" FROM users ORDER BY created_at DESC LIMIT 8`),
            query(`SELECT id, user_id AS "userId", url, status, score, started_at AS "startedAt", completed_at AS "completedAt" FROM audit_runs ORDER BY started_at DESC LIMIT 8`),
            query(`SELECT a.action, a.target_type AS "targetType", a.target_id AS "targetId", a.created_at AS "createdAt", u.username AS "adminUsername" FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_user_id ORDER BY a.created_at DESC LIMIT 8`),
            query(`SELECT COUNT(*)::int AS events, COUNT(*) FILTER (WHERE event_type='click')::int AS clicks, COUNT(*) FILTER (WHERE event_type='page_view')::int AS pages, COUNT(DISTINCT user_id)::int AS users FROM ui_activity WHERE created_at >= CURRENT_DATE`),
            query(`SELECT provider, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE success)::int AS successful, COALESCE(SUM(tokens_estimate),0)::bigint AS tokens, COALESCE(SUM(cost_estimate_usd),0)::numeric AS cost FROM api_usage WHERE created_at >= CURRENT_DATE GROUP BY provider ORDER BY requests DESC`)
        ]);
        const roleMap = { user: 0, admin: 0 };
        for (const row of usersByRole.rows) roleMap[row.role] = row.c;
        const statusMap = { running: 0, completed: 0, failed: 0 };
        for (const row of auditRunsByStatus.rows) statusMap[row.status] = row.c;
        res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            counts: {
                users: usersTotal.rows[0].c,
                usersByRole: roleMap,
                projects: projectsTotal.rows[0].c,
                auditRuns: statusMap.running + statusMap.completed + statusMap.failed,
                auditRunsByStatus: statusMap,
                rankSnapshots: rankSnapshotsTotal.rows[0].c,
                monitorJobs: monitorJobsTotal.rows[0].c,
                monitorJobsActive: monitorJobsActive.rows[0].c,
                alerts: alertsTotal.rows[0].c,
                alertsUnread: alertsUnread.rows[0].c,
                activeSessions: sessionsActive.rows[0].c
            },
            recentUsers: recentUsers.rows,
            recentAuditRuns: recentAuditRuns.rows,
            recentAdminActions: recentAdminActions.rows,
            telemetryToday: telemetryToday.rows[0] || {events:0,clicks:0,pages:0,users:0},
            apiToday: apiToday.rows
        });
    } catch (error) {
        console.error("Admin stats error:", error);
        res.status(500).json({ success:false, error:"Could not load admin dashboard data." });
    }
});

function adminPage(req) {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    return { limit, offset };
}

/* ---- Users ---- */
app.get("/api/admin/users", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const { limit, offset } = adminPage(req);
        const search = String(req.query.search || "").trim().toLowerCase();
        const params = [];
        let where = "";
        if (search) { params.push(`%${search}%`); where = `WHERE LOWER(u.username) LIKE $${params.length} OR LOWER(u.email) LIKE $${params.length}`; }
        const listParams = [...params, limit, offset];
        const rows = await query(`
            SELECT u.id, u.username, u.email, u.role, u.created_at AS "createdAt",
                (SELECT COUNT(*)::int FROM projects p WHERE p.user_id = u.id) AS "projectCount",
                (SELECT COUNT(*)::int FROM audit_runs a WHERE a.user_id = u.id) AS "auditCount",
                (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS "lastSeen"
            FROM users u ${where}
            ORDER BY u.created_at DESC
            LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `, listParams);
        const total = await query(`SELECT COUNT(*)::int AS c FROM users u ${where}`, params);
        res.json({ success:true, users: rows.rows, total: total.rows[0].c });
    } catch (error) {
        console.error("Admin users list error:", error);
        res.status(500).json({ success:false, error:"Could not load users." });
    }
});

app.post("/api/admin/users/:id/role", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const role = String(req.body?.role || "").trim();
    if (!["user", "admin"].includes(role)) return res.status(400).json({ success:false, error:"Role must be 'user' or 'admin'." });
    const targetId = req.params.id;
    if (targetId === admin.userId && role !== "admin") return res.status(400).json({ success:false, error:"You cannot remove your own admin access." });
    try {
        const r = await query(`UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING id, username, email, role`, [role, targetId]);
        if (!r.rows[0]) return res.status(404).json({ success:false, error:"User not found." });
        await logAdminAction(admin.userId, "set_role", "user", targetId, { role, username: r.rows[0].username });
        res.json({ success:true, user: r.rows[0] });
    } catch (error) {
        console.error("Admin set role error:", error);
        res.status(500).json({ success:false, error:"Could not update role." });
    }
});

app.delete("/api/admin/users/:id", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const targetId = req.params.id;
    if (targetId === admin.userId) return res.status(400).json({ success:false, error:"You cannot delete your own account." });
    try {
        const r = await query(`DELETE FROM users WHERE id=$1 RETURNING username, email`, [targetId]);
        if (!r.rows[0]) return res.status(404).json({ success:false, error:"User not found." });
        await logAdminAction(admin.userId, "delete_user", "user", targetId, { username: r.rows[0].username, email: r.rows[0].email });
        res.json({ success:true });
    } catch (error) {
        if (error && error.code === "23503") return res.status(409).json({ success:false, error:"Cannot delete: this admin has audit-log entries tied to their account." });
        console.error("Admin delete user error:", error);
        res.status(500).json({ success:false, error:"Could not delete user." });
    }
});

/* ---- Projects ---- */
app.get("/api/admin/projects", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const { limit, offset } = adminPage(req);
        const rows = await query(`
            SELECT p.id, p.name, p.url, p.created_at AS "createdAt", p.last_audit_at AS "lastAuditAt",
                u.id AS "ownerId", u.username AS "ownerUsername", u.email AS "ownerEmail"
            FROM projects p JOIN users u ON u.id = p.user_id
            ORDER BY p.created_at DESC LIMIT $1 OFFSET $2
        `, [limit, offset]);
        const total = await query(`SELECT COUNT(*)::int AS c FROM projects`);
        res.json({ success:true, projects: rows.rows, total: total.rows[0].c });
    } catch (error) {
        console.error("Admin projects list error:", error);
        res.status(500).json({ success:false, error:"Could not load projects." });
    }
});

app.delete("/api/admin/projects/:id", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const r = await query(`DELETE FROM projects WHERE id=$1 RETURNING name, url`, [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ success:false, error:"Project not found." });
        await logAdminAction(admin.userId, "delete_project", "project", req.params.id, { name: r.rows[0].name, url: r.rows[0].url });
        res.json({ success:true });
    } catch (error) {
        console.error("Admin delete project error:", error);
        res.status(500).json({ success:false, error:"Could not delete project." });
    }
});

/* ---- Audit runs ---- */
app.get("/api/admin/audit-runs", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const { limit, offset } = adminPage(req);
        const status = String(req.query.status || "").trim();
        const params = [];
        let where = "";
        if (["running", "completed", "failed"].includes(status)) { params.push(status); where = `WHERE a.status = $${params.length}`; }
        const listParams = [...params, limit, offset];
        const rows = await query(`
            SELECT a.id, a.url, a.status, a.score, a.started_at AS "startedAt", a.completed_at AS "completedAt", a.error_message AS "errorMessage",
                u.id AS "ownerId", u.username AS "ownerUsername"
            FROM audit_runs a JOIN users u ON u.id = a.user_id
            ${where}
            ORDER BY a.started_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `, listParams);
        const total = await query(`SELECT COUNT(*)::int AS c FROM audit_runs a ${where}`, params);
        res.json({ success:true, auditRuns: rows.rows, total: total.rows[0].c });
    } catch (error) {
        console.error("Admin audit runs list error:", error);
        res.status(500).json({ success:false, error:"Could not load audit runs." });
    }
});

app.get("/api/admin/audit-runs/:id", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const r = await query(`
            SELECT a.id, a.url, a.status, a.score, a.started_at AS "startedAt", a.completed_at AS "completedAt",
                a.error_message AS "errorMessage", a.result,
                u.username AS "ownerUsername", u.email AS "ownerEmail"
            FROM audit_runs a JOIN users u ON u.id = a.user_id WHERE a.id = $1
        `, [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ success:false, error:"Audit run not found." });
        res.json({ success:true, auditRun: r.rows[0] });
    } catch (error) {
        console.error("Admin audit run detail error:", error);
        res.status(500).json({ success:false, error:"Could not load audit run." });
    }
});

app.delete("/api/admin/audit-runs/:id", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const r = await query(`DELETE FROM audit_runs WHERE id=$1 RETURNING url`, [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ success:false, error:"Audit run not found." });
        await logAdminAction(admin.userId, "delete_audit_run", "audit_run", req.params.id, { url: r.rows[0].url });
        res.json({ success:true });
    } catch (error) {
        console.error("Admin delete audit run error:", error);
        res.status(500).json({ success:false, error:"Could not delete audit run." });
    }
});

/* ---- Monitor jobs & alerts ---- */
app.get("/api/admin/monitor-jobs", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const rows = await query(`
            SELECT m.id, m.url, m.every_hours AS "everyHours", m.enabled, m.next_run_at AS "nextRunAt",
                m.last_run_at AS "lastRunAt", m.created_at AS "createdAt", u.username AS "ownerUsername"
            FROM monitor_jobs m JOIN users u ON u.id = m.user_id
            ORDER BY m.created_at DESC LIMIT 100
        `);
        res.json({ success:true, jobs: rows.rows });
    } catch (error) {
        console.error("Admin monitor jobs error:", error);
        res.status(500).json({ success:false, error:"Could not load monitoring jobs." });
    }
});

app.post("/api/admin/monitor-jobs/:id/toggle", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const r = await query(`UPDATE monitor_jobs SET enabled = NOT enabled WHERE id=$1 RETURNING id, enabled, url`, [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ success:false, error:"Monitoring job not found." });
        await logAdminAction(admin.userId, "toggle_monitor_job", "monitor_job", req.params.id, { enabled: r.rows[0].enabled });
        res.json({ success:true, job: r.rows[0] });
    } catch (error) {
        console.error("Admin toggle monitor job error:", error);
        res.status(500).json({ success:false, error:"Could not update monitoring job." });
    }
});

app.delete("/api/admin/monitor-jobs/:id", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const r = await query(`DELETE FROM monitor_jobs WHERE id=$1 RETURNING url`, [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ success:false, error:"Monitoring job not found." });
        await logAdminAction(admin.userId, "delete_monitor_job", "monitor_job", req.params.id, { url: r.rows[0].url });
        res.json({ success:true });
    } catch (error) {
        console.error("Admin delete monitor job error:", error);
        res.status(500).json({ success:false, error:"Could not delete monitoring job." });
    }
});

app.get("/api/admin/alerts", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const rows = await query(`
            SELECT al.id, al.url, al.created_at AS "createdAt", al.score, al.critical, al.warnings,
                al.message, al.read_at AS "readAt", u.username AS "ownerUsername"
            FROM alerts al JOIN users u ON u.id = al.user_id
            ORDER BY al.created_at DESC LIMIT 100
        `);
        res.json({ success:true, alerts: rows.rows });
    } catch (error) {
        console.error("Admin alerts error:", error);
        res.status(500).json({ success:false, error:"Could not load alerts." });
    }
});

app.delete("/api/admin/alerts/:id", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const r = await query(`DELETE FROM alerts WHERE id=$1 RETURNING message`, [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ success:false, error:"Alert not found." });
        await logAdminAction(admin.userId, "delete_alert", "alert", req.params.id, {});
        res.json({ success:true });
    } catch (error) {
        console.error("Admin delete alert error:", error);
        res.status(500).json({ success:false, error:"Could not delete alert." });
    }
});

/* ---- Unified activity feed ---- */
app.get("/api/admin/activity", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const [signups, audits, snapshots, jobs, alertRows, logins] = await Promise.all([
            query(`SELECT username, email, created_at AS ts FROM users ORDER BY created_at DESC LIMIT 20`),
            query(`SELECT a.url, a.status, a.score, a.started_at AS ts, u.username FROM audit_runs a JOIN users u ON u.id=a.user_id ORDER BY a.started_at DESC LIMIT 20`),
            query(`SELECT rs.url, rs.snapshot_at AS ts, u.username FROM rank_snapshots rs JOIN users u ON u.id=rs.user_id ORDER BY rs.snapshot_at DESC LIMIT 20`),
            query(`SELECT mj.url, mj.created_at AS ts, u.username FROM monitor_jobs mj JOIN users u ON u.id=mj.user_id ORDER BY mj.created_at DESC LIMIT 20`),
            query(`SELECT al.message, al.created_at AS ts, u.username FROM alerts al JOIN users u ON u.id=al.user_id ORDER BY al.created_at DESC LIMIT 20`),
            query(`SELECT s.created_at AS ts, u.username FROM sessions s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 20`)
        ]);
        const events = [];
        for (const r of signups.rows) events.push({ ts: r.ts, type: "signup", text: `${r.username} created an account (${r.email})` });
        for (const r of audits.rows) events.push({ ts: r.ts, type: "audit", text: `${r.username} ran an audit on ${r.url} — ${r.status}${r.score != null ? `, score ${Number(r.score).toFixed(1)}` : ""}` });
        for (const r of snapshots.rows) events.push({ ts: r.ts, type: "rank", text: `${r.username} captured a rank snapshot for ${r.url}` });
        for (const r of jobs.rows) events.push({ ts: r.ts, type: "monitor", text: `${r.username} created a monitoring job for ${r.url}` });
        for (const r of alertRows.rows) events.push({ ts: r.ts, type: "alert", text: `Alert for ${r.username}: ${r.message}` });
        for (const r of logins.rows) events.push({ ts: r.ts, type: "login", text: `${r.username} signed in` });
        events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
        res.json({ success:true, events: events.slice(0, 60) });
    } catch (error) {
        console.error("Admin activity feed error:", error);
        res.status(500).json({ success:false, error:"Could not load activity." });
    }
});

/* ---- Agent performance ---- */
app.get("/api/admin/performance", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const [totals, daily, topUsers] = await Promise.all([
            query(`
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status='completed')::int AS completed,
                    COUNT(*) FILTER (WHERE status='failed')::int AS failed,
                    COUNT(*) FILTER (WHERE status='running')::int AS running,
                    AVG(score) FILTER (WHERE score IS NOT NULL) AS "avgScore",
                    AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (WHERE completed_at IS NOT NULL) AS "avgDurationSeconds"
                FROM audit_runs
            `),
            query(`
                SELECT TO_CHAR(DATE(started_at), 'Mon DD') AS day, COUNT(*)::int AS c
                FROM audit_runs
                WHERE started_at > NOW() - INTERVAL '14 days'
                GROUP BY DATE(started_at) ORDER BY DATE(started_at) ASC
            `),
            query(`
                SELECT u.username, COUNT(a.id)::int AS "auditCount"
                FROM audit_runs a JOIN users u ON u.id = a.user_id
                GROUP BY u.username ORDER BY "auditCount" DESC LIMIT 5
            `)
        ]);
        let engineStatus = "unreachable";
        try {
            const r = await fetch(`${PYTHON_SEO_ENGINE_URL}/health`);
            engineStatus = r.ok ? "healthy" : `error (${r.status})`;
        } catch (_) { /* stays 'unreachable' */ }
        const t = totals.rows[0];
        res.json({
            success:true,
            totals: {
                total: t.total,
                completed: t.completed,
                failed: t.failed,
                running: t.running,
                successRate: t.total ? Math.round((t.completed / t.total) * 1000) / 10 : 0,
                avgScore: t.avgScore != null ? Number(t.avgScore).toFixed(1) : null,
                avgDurationSeconds: t.avgDurationSeconds != null ? Math.round(t.avgDurationSeconds) : null
            },
            daily: daily.rows,
            topUsers: topUsers.rows,
            engineStatus,
            engineUrl: PYTHON_SEO_ENGINE_URL
        });
    } catch (error) {
        console.error("Admin performance error:", error);
        res.status(500).json({ success:false, error:"Could not load performance metrics." });
    }
});

/* ---- Full admin audit log ---- */
app.get("/api/admin/audit-log", async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
        const { limit, offset } = adminPage(req);
        const rows = await query(`
            SELECT a.id, a.action, a.target_type AS "targetType", a.target_id AS "targetId", a.metadata,
                a.created_at AS "createdAt", u.username AS "adminUsername"
            FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_user_id
            ORDER BY a.created_at DESC LIMIT $1 OFFSET $2
        `, [limit, offset]);
        const total = await query(`SELECT COUNT(*)::int AS c FROM admin_audit_log`);
        res.json({ success:true, entries: rows.rows, total: total.rows[0].c });
    } catch (error) {
        console.error("Admin audit log error:", error);
        res.status(500).json({ success:false, error:"Could not load the admin audit log." });
    }
});


/* ---- Live users, sessions and detailed activity ---- */
app.get("/api/admin/live-users", async (req,res)=>{
    const admin=await requireAdmin(req,res); if(!admin) return;
    try{
        const rows=await query(`SELECT u.id,u.username,u.email,u.role,p.last_seen_at AS "lastSeenAt",p.page_path AS "pagePath",p.page_title AS "pageTitle",p.cursor_x AS "cursorX",p.cursor_y AS "cursorY",p.viewport_width AS "viewportWidth",p.viewport_height AS "viewportHeight",p.mouse_moves AS "mouseMoves",p.clicks,p.page_views AS "pageViews",p.idle_seconds AS "idleSeconds",p.updated_at AS "updatedAt",s.created_at AS "sessionStartedAt",s.expires_at AS "expiresAt",s.last_path AS "lastPath" FROM user_presence p JOIN users u ON u.id=p.user_id LEFT JOIN sessions s ON s.token_hash=p.session_token_hash WHERE p.last_seen_at>NOW()-INTERVAL '90 seconds' AND s.expires_at>NOW() ORDER BY p.last_seen_at DESC LIMIT 100`);
        res.json({success:true,generatedAt:new Date().toISOString(),users:rows.rows});
    }catch(e){console.error("live users:",e.message);res.status(500).json({success:false,error:"Could not load live users."});}
});
app.get("/api/admin/sessions", async (req,res)=>{
    const admin=await requireAdmin(req,res); if(!admin) return;
    try{
        const limit=Math.min(Math.max(parseInt(req.query.limit)||50,1),200);
        const rows=await query(`SELECT s.token_hash AS "sessionKey",s.created_at AS "startedAt",COALESCE(s.ended_at,CASE WHEN s.expires_at<=NOW() THEN s.expires_at END) AS "endedAt",s.last_seen_at AS "lastSeenAt",s.expires_at AS "expiresAt",s.last_path AS "lastPath",u.id AS "userId",u.username,u.email,u.role,
        (SELECT COUNT(*)::int FROM ui_activity a WHERE a.session_token_hash=s.token_hash) AS "eventCount",
        (SELECT COUNT(*)::int FROM ui_activity a WHERE a.session_token_hash=s.token_hash AND a.event_type='click') AS "clickCount",
        (SELECT COUNT(*)::int FROM ui_activity a WHERE a.session_token_hash=s.token_hash AND a.event_type='page_view') AS "pageViewCount"
        FROM sessions s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT $1`,[limit]);
        res.json({success:true,sessions:rows.rows.map(r=>({...r,sessionKey:undefined}))});
    }catch(e){console.error("sessions:",e.message);res.status(500).json({success:false,error:"Could not load sessions."});}
});
app.get("/api/admin/user-activity", async (req,res)=>{
    const admin=await requireAdmin(req,res); if(!admin) return;
    try{
        const userId=String(req.query.userId||"").trim();
        const limit=Math.min(Math.max(parseInt(req.query.limit)||100,1),500);
        const params=[]; let where="";
        if(userId){params.push(userId);where=`WHERE a.user_id=$1`;}
        params.push(limit);
        const rows=await query(`SELECT a.id,a.event_type AS "eventType",a.page_path AS "pagePath",a.target,a.duration_ms AS "durationMs",a.cursor_x AS "cursorX",a.cursor_y AS "cursorY",a.metadata,a.created_at AS "createdAt",u.username,u.email FROM ui_activity a JOIN users u ON u.id=a.user_id ${where} ORDER BY a.created_at DESC LIMIT $${params.length}` ,params);
        const summary=await query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE event_type='click')::int AS clicks,COUNT(*) FILTER(WHERE event_type='page_view')::int AS pageviews,COUNT(*) FILTER(WHERE event_type LIKE 'feature_%')::int AS features,COUNT(*) FILTER(WHERE event_type='visibility')::int AS visibility FROM ui_activity a ${where}`, userId?[userId]:[]);
        res.json({success:true,events:rows.rows,summary:summary.rows[0]||{total:0,clicks:0,pageviews:0,features:0,visibility:0}});
    }catch(e){console.error("user activity:",e.message);res.status(500).json({success:false,error:"Could not load user activity."});}
});
app.get("/api/admin/activity-stream", async (req,res)=>{
    const admin=await requireAdmin(req,res); if(!admin) return;
    try{
        const limit=Math.min(Math.max(parseInt(req.query.limit)||100,1),300);
        const rows=await query(`SELECT a.id,a.event_type AS "eventType",a.page_path AS "pagePath",a.target,a.duration_ms AS "durationMs",a.cursor_x AS "cursorX",a.cursor_y AS "cursorY",a.metadata,a.created_at AS "createdAt",u.id AS "userId",u.username,u.email FROM ui_activity a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT $1`,[limit]);
        res.json({success:true,events:rows.rows});
    }catch(e){console.error("activity stream:",e.message);res.status(500).json({success:false,error:"Could not load activity stream."});}
});

/* ---- API usage + authentication history ---- */
app.get("/api/admin/api-usage", async (req,res)=>{
    const admin=await requireAdmin(req,res); if(!admin)return;
    try{
        const limit=Math.min(Math.max(parseInt(req.query.limit)||100,1),500);
        const provider=String(req.query.provider||"").trim();
        const where=provider?"WHERE a.provider=$2":"";
        const params=provider?[limit,provider]:[limit];
        const rows=await query(`SELECT a.id,a.provider,a.operation,a.success,a.duration_ms AS "durationMs",a.tokens_estimate AS "tokensEstimate",a.cost_estimate_usd AS "costEstimateUsd",a.error_message AS "errorMessage",a.metadata,a.created_at AS "createdAt",u.username,u.email FROM api_usage a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.created_at DESC LIMIT $1`,params);
        const totals=await query(`SELECT provider,COUNT(*)::int AS requests,COUNT(*) FILTER(WHERE success)::int AS successful,COUNT(*) FILTER(WHERE NOT success)::int AS failed,COALESCE(SUM(tokens_estimate),0)::bigint AS tokens,COALESCE(SUM(cost_estimate_usd),0)::numeric AS cost,ROUND(AVG(duration_ms))::int AS "avgDurationMs" FROM api_usage ${provider?"WHERE provider=$1":""} GROUP BY provider ORDER BY requests DESC`,provider?[provider]:[]);
        res.json({success:true,rows:rows.rows,totals:totals.rows});
    }catch(e){console.error("admin api usage:",e.message);res.status(500).json({success:false,error:"Could not load API usage."});}
});
app.get("/api/admin/login-history", async (req,res)=>{
    const admin=await requireAdmin(req,res); if(!admin)return;
    try{
        const limit=Math.min(Math.max(parseInt(req.query.limit)||100,1),500);
        const rows=await query(`SELECT l.id,l.event,l.identifier,l.ip_address AS "ipAddress",l.user_agent AS "userAgent",l.created_at AS "createdAt",u.username,u.email FROM login_history l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT $1`,[limit]);
        const summary=await query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE event='login')::int AS logins,COUNT(*) FILTER(WHERE event='signup')::int AS signups,COUNT(*) FILTER(WHERE event='failed_login')::int AS failed,COUNT(*) FILTER(WHERE event='logout')::int AS logouts FROM login_history WHERE created_at>=CURRENT_DATE`);
        res.json({success:true,rows:rows.rows,summary:summary.rows[0]||{}});
    }catch(e){console.error("admin login history:",e.message);res.status(500).json({success:false,error:"Could not load login history."});}
});

/* =========================================================
   SEO GROWTH OS
========================================================= */
app.post("/api/agent/growth-os", async (req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{res.json(await pythonPost("agent-growth-os",req.body||{}))}catch(e){res.status(502).json({success:false,error:e.message})}});
app.post("/api/seo-intelligence", async (req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{res.json(await pythonPost("seo-intelligence",req.body||{}))}catch(e){res.status(502).json({success:false,error:e.message})}});
app.post("/api/agent/content-optimizer", async (req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{res.json(await pythonPost("agent-content-optimizer",req.body||{}))}catch(e){res.status(502).json({success:false,error:e.message})}});
app.post("/api/agent/keyword-map", async (req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{res.json(await pythonPost("agent-keyword-map",req.body||{}))}catch(e){res.status(502).json({success:false,error:e.message})}});
app.post("/api/agent/change-detect", async (req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{res.json(await pythonPost("agent-change-detect",req.body||{}))}catch(e){res.status(502).json({success:false,error:e.message})}});
/* ---- SEO Memory + Decision Engine: evidence over time, not one-off audits ---- */
app.post("/api/agent/memory-scan", async (req,res)=>{
    const u=await requireAgentUser(req,res); if(!u)return;
    const url=String(req.body?.url||"").trim(); const keyword=String(req.body?.keyword||"").trim();
    if(!url) return res.status(400).json({success:false,error:"URL is required."});
    try{
        const result=await pythonPost("agent-growth-os",{url,keyword,max_pages:Math.min(Math.max(Number(req.body?.maxPages)||8,3),20)});
        const snapshot={url:result.url||url,technical:result.technical||[],content_optimizer:result.content_optimizer||{},keyword_map:result.keyword_map||[],site_footprint:result.site_footprint||{},opportunities:result.opportunities||[],roadmap:result.roadmap||[]};
        const prev=await query(`SELECT id,captured_at AS "capturedAt",payload FROM seo_snapshots WHERE user_id=$1 AND url=$2 ORDER BY captured_at DESC LIMIT 1`,[u.userId,url]);
        let changes=[];
        if(prev.rows[0]){
            try{
                const cd=await pythonPost("agent-change-detect",{previous:prev.rows[0].payload,current:snapshot});
                changes=cd.changes||[];
            }catch(e){ changes=[{field:"snapshot",type:"comparison_unavailable",detail:e.message}]; }
        }
        const snapshotId=crypto.randomUUID();
        await query(`INSERT INTO seo_snapshots(id,user_id,url,payload) VALUES($1,$2,$3,$4::jsonb)`,[snapshotId,u.userId,url,JSON.stringify(snapshot)]);
        const high=(result.opportunities||[]).filter(x=>["critical","high"].includes(x.priority));
        const next=high[0] || (result.opportunities||[])[0] || {title:"Run the next verification cycle",description:"No higher-priority issue was detected in this evidence snapshot.",priority:"low"};
        const decisionId=crypto.randomUUID();
        await query(`INSERT INTO seo_decisions(id,user_id,url,decision_type,title,rationale,evidence,confidence) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[decisionId,u.userId,url,"next_best_action",String(next.title||"Next best action"),String(next.description||next.detail||"Evidence-driven next action."),JSON.stringify({priority:next.priority||"medium",changes,source:"growth-os"}),changes.length?0.9:0.75]);
        res.json({success:true,snapshotId,previousSnapshot:prev.rows[0]||null,changes,nextBestAction:next,siteFootprint:result.site_footprint||{},opportunities:result.opportunities||[],roadmap:result.roadmap||[]});
    }catch(e){console.error("memory scan:",e.message);res.status(502).json({success:false,error:e.message});}
});
app.get("/api/agent/memory", async (req,res)=>{
    const u=await requireAgentUser(req,res); if(!u)return;
    try{
        const limit=Math.min(Math.max(Number(req.query.limit)||20,1),100);
        const snaps=await query(`SELECT id,url,captured_at AS "capturedAt",payload FROM seo_snapshots WHERE user_id=$1 ORDER BY captured_at DESC LIMIT $2`,[u.userId,limit]);
        const decisions=await query(`SELECT id,url,decision_type AS "decisionType",title,rationale,evidence,confidence,created_at AS "createdAt" FROM seo_decisions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,[u.userId,limit]);
        res.json({success:true,snapshots:snaps.rows,decisions:decisions.rows});
    }catch(e){res.status(500).json({success:false,error:"Could not load SEO memory."});}
});
app.get("/api/agent/decisions", async (req,res)=>{
    const u=await requireAgentUser(req,res); if(!u)return;
    try{const limit=Math.min(Math.max(Number(req.query.limit)||30,1),100);const r=await query(`SELECT id,url,decision_type AS "decisionType",title,rationale,evidence,confidence,created_at AS "createdAt" FROM seo_decisions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,[u.userId,limit]);res.json({success:true,decisions:r.rows});}catch(e){res.status(500).json({success:false,error:"Could not load decisions."});}
});

app.get("/api/agent/tasks",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const r=await query(`SELECT id,title,description,priority,status,source,url,created_at AS "createdAt",completed_at AS "completedAt" FROM seo_tasks WHERE user_id=$1 ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,created_at DESC LIMIT 200`,[u.userId]);res.json({success:true,tasks:r.rows})}catch(e){res.status(500).json({success:false,error:"Could not load tasks."})}});
app.post("/api/agent/tasks",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;const x=req.body||{};if(!String(x.title||'').trim())return res.status(400).json({success:false,error:"Task title is required."});try{const id=crypto.randomUUID();const priority=['critical','high','medium','low'].includes(x.priority)?x.priority:'medium';await query(`INSERT INTO seo_tasks (id,user_id,project_id,url,title,description,priority,status,source,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9::jsonb)`,[id,u.userId,x.projectId||null,x.url||null,String(x.title).trim(),x.description||'',priority,x.source||'manual',JSON.stringify(x.evidence||{})]);res.json({success:true,id})}catch(e){res.status(500).json({success:false,error:"Could not create task."})}});
app.patch("/api/agent/tasks/:id",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;const status=String(req.body?.status||'').trim();if(!['open','in_progress','done'].includes(status))return res.status(400).json({success:false,error:"Invalid task status."});try{const r=await query(`UPDATE seo_tasks SET status=$1,completed_at=CASE WHEN $1='done' THEN NOW() ELSE NULL END WHERE id=$2 AND user_id=$3 RETURNING id,status`,[status,req.params.id,u.userId]);if(!r.rows[0])return res.status(404).json({success:false,error:"Task not found."});res.json({success:true,task:r.rows[0]})}catch(e){res.status(500).json({success:false,error:"Could not update task."})}});
app.get("/api/agent/agency-settings",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const r=await query(`SELECT brand_name AS "brandName",logo_url AS "logoUrl",brand_color AS "brandColor",report_footer AS "reportFooter",custom_domain AS "customDomain" FROM agency_settings WHERE user_id=$1`,[u.userId]);res.json({success:true,settings:r.rows[0]||{}})}catch(e){res.status(500).json({success:false,error:"Could not load agency settings."})}});
app.put("/api/agent/agency-settings",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;const x=req.body||{};try{await query(`INSERT INTO agency_settings (user_id,brand_name,logo_url,brand_color,report_footer,custom_domain) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET brand_name=EXCLUDED.brand_name,logo_url=EXCLUDED.logo_url,brand_color=EXCLUDED.brand_color,report_footer=EXCLUDED.report_footer,custom_domain=EXCLUDED.custom_domain,updated_at=NOW()`,[u.userId,x.brandName||null,x.logoUrl||null,x.brandColor||null,x.reportFooter||null,x.customDomain||null]);res.json({success:true})}catch(e){res.status(500).json({success:false,error:"Could not save agency settings."})}});
app.get("/api/agent/integrations",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;try{const rows=await query(`SELECT provider,status,config,updated_at AS "updatedAt" FROM integration_connections WHERE user_id=$1 ORDER BY provider`,[u.userId]);const providers=['google_search_console','google_analytics_4','wordpress','shopify','slack'];res.json({success:true,providers:providers.map(provider=>{const row=rows.rows.find(x=>x.provider===provider);return {provider,status:row?.status||'not_connected',config:row?.config||{}}}),capabilities:{gsc:'GSC adapter requires OAuth/API credentials.',ga4:'GA4 adapter requires Google credentials and property access.',cms:'CMS adapters require explicit site credentials and write permissions.'}})}catch(e){res.status(500).json({success:false,error:"Could not load integrations."})}});
app.post("/api/agent/integrations/:provider",async(req,res)=>{const u=await requireAgentUser(req,res);if(!u)return;const allowed=['google_search_console','google_analytics_4','wordpress','shopify','slack'];if(!allowed.includes(req.params.provider))return res.status(400).json({success:false,error:"Unsupported integration."});try{await query(`INSERT INTO integration_connections (id,user_id,provider,status,config) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT(user_id,provider) DO UPDATE SET status=EXCLUDED.status,config=EXCLUDED.config,updated_at=NOW()`,[crypto.randomUUID(),u.userId,req.params.provider,String(req.body?.status||'configured'),JSON.stringify(req.body?.config||{})]);res.json({success:true,provider:req.params.provider,status:req.body?.status||'configured'})}catch(e){res.status(500).json({success:false,error:"Could not save integration configuration."})}});

/* =========================================================
   CENTRAL ERROR BOUNDARY
========================================================= */
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // Body-parser problems are the client's fault: return a precise 4xx instead of a scary 500.
    if (err?.type === "entity.parse.failed") return res.status(400).json({ success: false, error: "Request body is not valid JSON." });
    if (err?.type === "entity.too.large") return res.status(413).json({ success: false, error: "Request body is too large." });
    console.error("Unhandled request error:", req.method, req.originalUrl, err);
    const status = Number(err?.statusCode || err?.status || 500);
    res.status(status >= 400 && status < 600 ? status : 500).json({
        success: false,
        error: "The server could not complete this request. Please retry."
    });
});

/* =========================================================
   UNKNOWN API ROUTE
========================================================= */

app.use(
    "/api",
    (
        req,
        res
    ) => {

        res.status(
            404
        ).json({

            success:
                false,

            error:
                `API endpoint not found: ${req.method} ${req.path}`
        });
    }
);



async function runScheduledAgentChecks(){
    // Atomically claim due jobs before doing network work. This prevents duplicate
    // runs when Render is scaled to multiple Node processes/instances.
    const claimed=await query(`
        UPDATE monitor_jobs
        SET next_run_at=NOW() + (every_hours * INTERVAL '1 hour')
        WHERE id IN (
            SELECT id FROM monitor_jobs
            WHERE enabled=true AND next_run_at<=NOW()
            ORDER BY next_run_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 20
        )
        RETURNING id,user_id,url,every_hours,next_run_at,enabled
    `);
    for(const job of claimed.rows){
        try{
            const snap=await pythonPost("monitor-snapshot",{url:job.url});
            const s=snap.snapshot||snap;
            const previousResult=await query(`SELECT score,critical,warnings FROM monitor_snapshots WHERE user_id=$1 AND url=$2 ORDER BY snapshot_at DESC LIMIT 1`,[job.user_id,job.url]);
            const previous=previousResult.rows[0]||null;
            await query(`INSERT INTO monitor_snapshots (id,user_id,url,score,critical,warnings,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,[crypto.randomUUID(),job.user_id,job.url,s.score??null,Number(s.critical||0),Number(s.warnings||0),JSON.stringify(s)]);
            const scoreChange=previous&&s.score!=null&&previous.score!=null?Number(s.score)-Number(previous.score):null;
            const message=(s.critical||0)>0?`Scheduled check found ${s.critical} critical issue(s).`:scoreChange!==null&&scoreChange<0?`Scheduled check: SEO score dropped ${Math.abs(scoreChange).toFixed(1)} points.`:`Scheduled SEO check completed: ${s.warnings||0} warning(s).`;
            await addAlert(job.user_id,{id:crypto.randomUUID(),url:job.url,createdAt:new Date().toISOString(),score:s.score,critical:s.critical||0,warnings:s.warnings||0,message});
        }catch(e){
            await addAlert(job.user_id,{id:crypto.randomUUID(),url:job.url,createdAt:new Date().toISOString(),message:`Scheduled check could not complete: ${e.message}`});
            await query(`UPDATE monitor_jobs SET next_run_at=NOW() + INTERVAL '15 minutes' WHERE id=$1`,[job.id]);
        }
    }
}
setInterval(()=>runScheduledAgentChecks().catch(e=>console.error("Scheduled monitoring error:",e)),15*60*1000);

let httpServer = null;

async function gracefulShutdown(signal) {
    console.log(`\n${signal}: shutting down SEO Agent gracefully...`);
    // Never hang forever on open keep-alive connections.
    setTimeout(() => { console.error("Forced exit after shutdown timeout."); process.exit(1); }, 10000).unref();
    try {
        if (pythonEngineProcess) { pythonEngineProcess.kill(); pythonEngineProcess = null; }
        if (httpServer) await new Promise(resolve => httpServer.close(resolve));
        await closeDb();
    } catch (e) {
        console.error("Graceful shutdown error:", e.message);
    } finally {
        process.exit(signal === "uncaughtException" ? 1 : 0);
    }
}
process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => { console.error("Unhandled promise rejection:", reason); });
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception — shutting down:", error);
    gracefulShutdown("uncaughtException");
});

async function bootstrap() {
    await dbHealth();
    await ensureAuthTables();
    await ensureApplicationSchema();
    await purgeExpiredSessions();
    setInterval(purgeExpiredSessions, 24 * 60 * 60 * 1000).unref();
    await startPythonSeoEngine();
    httpServer = app.listen(PORT, () => {
        httpServer.keepAliveTimeout = 65000;   // above typical proxy idle timeouts (avoids sporadic 502s)
        httpServer.headersTimeout = 66000;
        httpServer.requestTimeout = 200000;    // long enough for 180s engine jobs, still bounded
        const serpKey = getSerpApiKey();
        const geminiKey = GEMINI_API_KEY;
        console.log("====================================");
        console.log(`SEO Agent running on port ${PORT}`);
        console.log(`Model: ${MODEL}`);
        console.log(`GEMINI_API_KEY : ${geminiKey ? "✓ loaded (" + geminiKey.length + " chars)" : "✗ MISSING"}`);
        console.log(`SERPAPI_KEY    : ${serpKey ? "✓ loaded (" + serpKey.length + " chars)" : "✗ MISSING — rank features disabled"}`);
        console.log(`PostgreSQL: ✓ connected`);
        console.log(`Python SEO Engine: ${PYTHON_SEO_ENGINE_URL} (${pythonEngineProcess ? "✓ connected" : "✗ unavailable"})`);
        console.log(`Env file path  : ${require("path").resolve(__dirname, ".env")}`);
        console.log("====================================");
    });
}
bootstrap().catch(error => {
    console.error("Startup error:", error);
    process.exit(1);
});
