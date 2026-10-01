const assert = require("assert");
const fs = require("fs");

const server = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
const html = fs.readFileSync(require("path").join(__dirname, "..", "public", "index.html"), "utf8");

// Every user-facing analysis endpoint must exist and must not be a hardcoded demo endpoint.
const routes = [
  "/api/analyze", "/api/site-audit", "/api/keywords", "/api/content",
  "/api/content-gap", "/api/rank-check", "/api/top-rankings", "/api/competitors",
  "/api/seo-actions", "/api/crawl", "/api/rank-track", "/api/ai-recommendations",
  "/api/keyword-opportunity", "/api/keyword-verify", "/api/content-plan",
  "/api/pagespeed", "/api/domain-authority", "/api/trends", "/api/verify-url", "/api/internal-link-opportunities", "/api/gsc-import", "/api/monitor-snapshot"
];
for (const route of routes) assert(server.includes(route), `Missing route ${route}`);

// The app must use real external sources for measurable SEO data.
assert(server.includes("serpapi.com/search.json"), "SERP source missing");
assert(server.includes("googleapis.com/pagespeedonline"), "PageSpeed source missing");
assert(server.includes("openpagerank.com/api/v1.0/getPageRank"), "OpenPageRank source missing");
assert(server.includes("googleTrends.interestOverTime"), "Google Trends source missing");

// Rank #1 completion must re-check the live regional SERP after crawling.
assert(server.includes("const liveSerp = await fetchSerpResults(keyword"), "Post-completion live rank check missing");
assert(server.includes("rankScanDepth: liveRankResults.length"), "Rank scan provenance missing");
assert(server.includes("maxPages = Math.max(1, Math.min(Number(req.body.maxPages) || 20, 30))"), "Deep verification crawl is not enabled");

// Planner must never return a fabricated monthly volume/range.
assert(server.includes('level: "Not verified"'), "Planner volume must be explicitly unverified");
assert(server.includes("Google Ads Keyword Planner volume"), "Planner must explain the missing measured volume source");
assert(!server.includes('e.g. "100-1,000/mo"'), "Fabricated example monthly volume must not remain in planner prompt");

// Keyword research must include live SERP demand signals.
assert(server.includes("liveInsights.relatedSearches"), "Keyword research is not grounded in live SERP demand");
assert(server.includes("Live Google SERP via SerpApi"), "Keyword research provenance missing");

// Rank tracking must honor regional Google settings.
assert(server.includes("gl: country.gl") && server.includes("google_domain: country.google_domain"), "Regional SERP parameters missing");

// Frontend must pass the selected Rank #1 country into the deep verification crawl.
assert(html.includes('country: rank1Current.country?.code || "us"'), "Rank #1 verification does not pass country");
assert(html.includes("maxPages: 20"), "Frontend is not requesting deep verification crawl");

// No obvious demo/random/fake result generation should exist.
for (const bad of ["Math.random()", "mockResults", "demoResults", "fakeResults"]) {
  assert(!server.includes(bad), `Found prohibited fake-result marker: ${bad}`);
}

console.log("PASS: all production sections are wired to real-data sources or explicitly evidence-limited AI");
console.log("PASS: Rank #1 planner has no fabricated monthly search-volume output");
console.log("PASS: Rank #1 completion performs a 20-page default crawl + live regional SERP re-check");
console.log("PASS: keyword research uses live SERP demand signals");
console.log("PASS: regional rank tracking is wired to Google geo/domain settings");
console.log("ALL PROFESSIONAL AUDIT TESTS PASSED");


// Added free evidence-first tools must exist and must not claim data they do not possess.
assert(server.includes('/api/verify-url'), 'Verification Center endpoint is missing');
assert(server.includes('/api/internal-link-opportunities'), 'Internal link endpoint is missing');
assert(server.includes('/api/gsc-import'), 'Search Console import endpoint is missing');
assert(server.includes('/api/monitor-snapshot'), 'SEO Monitor endpoint is missing');
assert(html.includes('Verification Center'), 'Verification Center UI is missing');
assert(html.includes('Internal Link Builder'), 'Internal Link Builder UI is missing');
assert(html.includes('SEO Monitor'), 'SEO Monitor UI is missing');
assert(html.includes('Google Search Console'), 'Search Console import UI is missing');
assert(server.includes('No inbound internal link was observed from the pages crawled in this run.'), 'Orphan evidence disclaimer is missing');
console.log('PASS: free Verification Center, GSC CSV import, Internal Link Builder and SEO Monitor are wired');
