const fs = require('fs');
const assert = require('assert');
const html = fs.readFileSync('public/index.html', 'utf8');
assert(html.includes('id="seo-agent-global-auth-bridge"'), 'global auth bridge missing');
assert(html.includes('window.authHeaders = window.authHeaders || function authHeaders()'), 'global authHeaders function missing');
assert(html.includes('window.seoAgentFetch = window.seoAgentFetch || function'), 'shared authenticated fetch helper missing');
assert((html.match(/\.\.\.authHeaders\(\)/g) || []).length >= 5, 'feature modules should use auth headers');
console.log('global_auth_bridge_test: PASS');
