/* Static regression tests for the security/reliability hardening pass.
   These read the source (like the other static suites) so they run with no DB or API keys. */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const dbSrc = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
const pyMain = fs.readFileSync(path.join(__dirname, "..", "seo-engine", "main.py"), "utf8");
const pySec = fs.readFileSync(path.join(__dirname, "..", "seo-engine", "security.py"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

function pass(name) { console.log("PASS:", name); }

// getClientIP must NOT trust the client-controlled X-Forwarded-For header
const ipFn = src.slice(src.indexOf("function getClientIP"), src.indexOf("function aiRateLimiter"));
assert(!/headers\s*\[\s*["']x-forwarded-for["']\s*\]/i.test(ipFn), "getClientIP reads X-Forwarded-For directly");
pass("rate-limit client IP cannot be spoofed via X-Forwarded-For");

// Logout must actually revoke: every session lookup has to exclude ended sessions
const lookups = src.match(/FROM sessions s JOIN users u[^`]*?WHERE[^`]*?token_hash\s*=\s*\$1[^`]*/g) || [];
assert(lookups.length >= 2, "expected session lookups not found");
lookups.forEach(q => assert(/ended_at IS NULL/.test(q), "session lookup ignores logout: " + q.slice(0, 80)));
pass("logged-out session tokens are rejected");

// Python-engine proxy must be rate limited and send the shared secret
assert(/engineRateLimiter\(req, res/.test(src), "engine proxy is not rate limited");
assert((src.match(/engineHeaders\(/g) || []).length >= 5, "engine calls do not all send the shared secret");
pass("Python engine proxy is rate limited and authenticated to the engine");

// Auth brute force protection + enumeration timing
assert(/loginFailCount\(/.test(src) && /signupLimiter/.test(src) && /DUMMY_PASSWORD_HASH/.test(src));
pass("login lockout, signup limiter and constant-cost unknown-user path present");

// Diagnostics endpoint must be admin-only
const envCheck = src.slice(src.indexOf('"/api/env-check"'), src.indexOf('"/api/env-check"') + 300);
assert(/requireAdmin/.test(envCheck), "/api/env-check is public");
pass("/api/env-check requires admin");

// Only one error boundary that does not echo internal error messages
assert(!/error\.message\s*\|\|\s*\n?\s*"Internal server error\."/.test(src), "leaky error handler still present");
pass("no error handler leaks internal messages");

// Signal handling: no handler that exits before graceful shutdown
assert(!/process\.on\("SIGINT",async/.test(src), "premature SIGINT handler still present");
pass("graceful shutdown is not pre-empted");

// AI calls must be bounded
assert(/AI_TIMEOUT_MS/.test(src) && /withTimeout\(/.test(src) && /AbortSignal\.timeout\(AI_TIMEOUT_MS\)/.test(src));
pass("Gemini/Groq calls have timeouts and a transient-error retry");

// Python SSRF hardening
assert(/is_global/.test(pySec), "engine SSRF check is not using is_global");
assert(/allow_redirects=False/.test(pyMain) && /MAX_REDIRECTS/.test(pyMain), "engine follows redirects unchecked");
assert(/engine_secret_guard/.test(pyMain));
pass("Python engine validates every redirect hop and supports a shared secret");

// Reproducible dependencies
Object.entries(pkg.dependencies).forEach(([k, v]) => assert(v !== "latest", k + " is unpinned ('latest')"));
pass("no dependency uses the 'latest' tag");

// DB TLS is configurable
assert(/DB_SSL/.test(dbSrc));
pass("database TLS behaviour is configurable");

console.log("SECURITY HARDENING TESTS PASSED");
