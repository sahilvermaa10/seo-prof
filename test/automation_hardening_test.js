const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const premium = read('public/pro-premium.js');
const ask = read('public/askseo-inspired.js');
const index = read('public/index.html');
const py = read('seo-engine/main.py');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

assert(server.includes('const u=await requireAgentUser(req,res)'), 'Agent routes must await authentication.');
assert(server.includes('FOR UPDATE SKIP LOCKED'), 'Scheduled monitoring must atomically claim jobs.');
assert(server.includes('const score = Number.isFinite(Number(data.score))'), 'Technical score must use the Python source-of-truth score.');
assert(server.includes('pythonPost("site-audit"'), 'Site audit must use deterministic Python evidence instead of Gemini JSON parsing.');
assert(server.includes('X-SEO-Agent-Request'), 'Node to Python requests need a unique request id.');
assert(server.includes('Cache-Control'), 'Node to Python requests must set cache-control headers.');

assert(premium.includes("method==='GET'"), 'Premium API cache must be GET-only.');
assert(!premium.includes("localStorage.setItem('seoAgentLastDashboard'"), 'Premium layer must not persist dashboard results across sites.');
assert(!premium.includes("technicalSectionUrl','onpageSectionUrl','indexingSectionUrl','healthSectionUrl','opportunitiesSectionUrl','reportSectionUrl"), 'Premium layer must not copy URLs between sections.');
assert(premium.includes("window.runExtendedUrlCheck('technical')"), 'Premium technical runner must delegate to guarded canonical runner.');
assert(!ask.includes('"#dashboardUrl","#auditUrl","#agentDashUrl"'), 'AI assistant must not infer its URL from other sections.');
assert(index.includes('const sectionRequestGeneration = Object.create(null);'), 'Extended sections need request generations.');
assert(index.includes('generation !== sectionRequestGeneration[kind]'), 'Stale section responses must be ignored.');
assert(index.includes('postJson("/api/technical-check",{url})'), 'Technical section must use its own URL.');
assert(index.includes('postJson("/api/site-audit",{url,section:kind})'), 'On-page/indexing sections must use their own URL and section.');
assert(index.includes('postJson("/api/technical-check",{url}),\n                postJson("/api/site-audit",{url,section:"onpage"})'), 'Full report must fetch independent section evidence.');

assert(py.includes('def normalize_page_url(value):'), 'Python must have stable URL identity.');
assert(py.includes('_TRACKING_PARAMS'), 'Python URL identity must remove known tracking parameters only.');
assert(py.includes('def verified_score(checks):'), 'Python must have one scoring function.');
assert(py.includes('force_refresh=False'), 'Python crawler/page extraction must distinguish fresh audits from crawl cache.');
assert(py.includes('extract_page(b.url, force_refresh=True)'), 'Live single-page checks must bypass stale page cache.');
assert(py.includes('extract_page(u, force_refresh=False)'), 'Crawls may reuse safe per-page cache.');

console.log('AUTOMATION HARDENING TESTS PASSED');
