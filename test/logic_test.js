// Standalone logic test — mirrors the exact logic now in server.js for the
// two fixed endpoints, exercised against a mocked global.fetch so it runs
// with zero real network calls and no npm dependencies.
const assert = require("assert");

/* ---------------------------------------------------------
   PAGESPEED logic (copied verbatim from server.js)
--------------------------------------------------------- */
const PAGESPEED_TIMEOUT_MS = 180000;
const PAGESPEED_CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

async function fetchPageSpeedCategory(url, strategy, category, key) {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${encodeURIComponent(strategy)}&category=${encodeURIComponent(category)}&key=${key}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGESPEED_TIMEOUT_MS);
    let r;
    try {
        r = await fetch(apiUrl, { signal: controller.signal });
    } catch (fetchErr) {
        if (fetchErr.name === "AbortError") throw new Error(`timed out after ${PAGESPEED_TIMEOUT_MS / 1000}s`);
        throw new Error("could not reach PageSpeed Insights");
    } finally {
        clearTimeout(timeout);
    }
    const rawText = await r.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch { throw new Error(`non-JSON response (HTTP ${r.status}): ${rawText.slice(0, 150)}`); }
    if (data.error) throw new Error((data.error.message || "PageSpeed API error") + (data.error.code ? ` (code ${data.error.code})` : ""));
    return data;
}

async function pagespeedHandler(url, strategy, key) {
    const settled = await Promise.allSettled(
        PAGESPEED_CATEGORIES.map(category => fetchPageSpeedCategory(url, strategy, category, key))
    );
    const cats = {}, audits = {};
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
    if (!Object.keys(cats).length) throw new Error(`PageSpeed audit failed for every category: ${failed.join("; ")}`);
    const score = s => (s === undefined || s === null) ? null : Math.round(s * 100);
    return {
        url, strategy,
        scores: {
            performance:   score(cats.performance?.score),
            accessibility: score(cats.accessibility?.score),
            bestPractices: score(cats["best-practices"]?.score),
            seo:           score(cats.seo?.score)
        },
        warnings: failed.length ? failed.map(f => `Could not complete: ${f}`) : []
    };
}

function fakeLighthouseResponse(category, score) {
    return {
        lighthouseResult: {
            categories: { [category]: { score } },
            audits: {
                "first-contentful-paint": { displayValue: "1.2 s" }
            }
        },
        loadingExperience: { metrics: { FIRST_CONTENTFUL_PAINT_MS: 1200 } }
    };
}

function mockFetchJson(status, jsonBody) {
    return async () => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(jsonBody)
    });
}

async function testPagespeedAllSucceed() {
    global.fetch = async (apiUrl) => {
        const cat = new URL(apiUrl).searchParams.get("category");
        const scoreMap = { performance: 0.95, accessibility: 0.88, "best-practices": 0.92, seo: 1.0 };
        return { ok: true, status: 200, text: async () => JSON.stringify(fakeLighthouseResponse(cat, scoreMap[cat])) };
    };
    const result = await pagespeedHandler("https://example.com", "mobile", "FAKEKEY");
    assert.strictEqual(result.scores.performance, 95);
    assert.strictEqual(result.scores.accessibility, 88);
    assert.strictEqual(result.scores.bestPractices, 92);
    assert.strictEqual(result.scores.seo, 100);
    assert.deepStrictEqual(result.warnings, []);
    console.log("PASS: pagespeed all-4-categories-succeed merges correctly");
}

async function testPagespeedPartialFailure() {
    global.fetch = async (apiUrl) => {
        const cat = new URL(apiUrl).searchParams.get("category");
        if (cat === "accessibility") {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
        }
        const scoreMap = { performance: 0.7, "best-practices": 0.6, seo: 0.5 };
        return { ok: true, status: 200, text: async () => JSON.stringify(fakeLighthouseResponse(cat, scoreMap[cat])) };
    };
    const result = await pagespeedHandler("https://example.com", "mobile", "FAKEKEY");
    assert.strictEqual(result.scores.performance, 70);
    assert.strictEqual(result.scores.accessibility, null); // failed category -> null, not 0
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("accessibility"));
    console.log("PASS: pagespeed partial-failure still returns the 3 that succeeded, with a warning");
}

async function testPagespeedTotalFailure() {
    global.fetch = async () => { const err = new Error("aborted"); err.name = "AbortError"; throw err; };
    let threw = false;
    try {
        await pagespeedHandler("https://example.com", "mobile", "FAKEKEY");
    } catch (e) {
        threw = true;
        assert.ok(e.message.includes("failed for every category"));
    }
    assert.ok(threw, "expected total failure to throw");
    console.log("PASS: pagespeed total-failure (all 4 timeout) throws a clear combined error");
}

/* ---------------------------------------------------------
   DOMAIN AUTHORITY logic (copied verbatim from server.js)
--------------------------------------------------------- */
async function domainAuthorityHandler(domains, key) {
    const cleaned = domains.slice(0, 100).map(d =>
        String(d).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim()
    ).filter(Boolean);
    if (!cleaned.length) throw new Error("No valid domains after cleaning input.");

    const qs = cleaned.map(d => `domains[]=${encodeURIComponent(d)}`).join("&");
    const r = await fetch(`https://openpagerank.com/api/v1.0/getPageRank?${qs}`, { headers: { "API-OPR": key } });
    const rawText = await r.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch { throw new Error(`OpenPageRank returned a non-JSON response (HTTP ${r.status}): ${rawText.slice(0, 200)}`); }

    const topLevelError = data.error || data.message || (typeof data.response === "string" ? data.response : null);
    if (!r.ok || topLevelError) {
        if (r.status === 401 || r.status === 403) {
            throw new Error(
                `OpenPageRank rejected this API key (HTTP ${r.status}: ${topLevelError || "Invalid API key"}). ` +
                `This means the key value in your .env is wrong, expired, or not yet active — not a bug in the app.`
            );
        }
        throw new Error(`OpenPageRank error (HTTP ${r.status}): ${topLevelError || "Request rejected."}`);
    }

    return (Array.isArray(data.response) ? data.response : []).map(item => ({
        domain: item.domain, pr: item.page_rank_integer ?? 0, prDecimal: item.page_rank_decimal ?? 0,
        rank: item.rank || null, status: item.status_code, error: item.error || ""
    }));
}

async function testDomainAuthoritySuccess() {
    global.fetch = mockFetchJson(200, {
        status_code: 200,
        last_updated: "1st Jan 2026",
        response: [
            { domain: "studyhours.com", page_rank_integer: 4, page_rank_decimal: 3.68, rank: "129456", status_code: 200, error: "" }
        ]
    });
    const results = await domainAuthorityHandler(["https://studyhours.com/"], "REALKEY123");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].domain, "studyhours.com");
    assert.strictEqual(results[0].pr, 4);
    console.log("PASS: domain-authority happy-path parses cleaned domain + response correctly");
}

async function testDomainAuthority403() {
    global.fetch = mockFetchJson(403, { error: true, message: "Invalid API Key" });
    let threw = false;
    try {
        await domainAuthorityHandler(["studyhours.com"], "BADKEY");
    } catch (e) {
        threw = true;
        assert.ok(e.message.includes("HTTP 403"));
        assert.ok(e.message.includes("not a bug in the app"));
    }
    assert.ok(threw, "expected 403 to throw a clear, actionable error");
    console.log("PASS: domain-authority 403 produces a clear, actionable, correctly-attributed error");
}

async function testDomainAuthorityDomainCleaning() {
    let capturedUrl = null;
    global.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, text: async () => JSON.stringify({ response: [] }) }; };
    await domainAuthorityHandler(["https://www.Example.com/some/path?q=1", "  plain-domain.org  "], "KEY");
    assert.ok(capturedUrl.includes("domains[]=Example.com"), "should strip protocol/www/path: " + capturedUrl);
    assert.ok(capturedUrl.includes("domains[]=plain-domain.org"), "should trim whitespace: " + capturedUrl);
    console.log("PASS: domain-authority domain cleaning (protocol/www/path/whitespace stripped) works");
}

(async () => {
    await testPagespeedAllSucceed();
    await testPagespeedPartialFailure();
    await testPagespeedTotalFailure();
    await testDomainAuthoritySuccess();
    await testDomainAuthority403();
    await testDomainAuthorityDomainCleaning();
    console.log("\nALL TESTS PASSED");
})().catch(e => { console.error("TEST FAILURE:", e); process.exit(1); });
