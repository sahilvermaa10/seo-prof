const fs = require('fs');
const assert = require('assert');
const index = fs.readFileSync('public/index.html','utf8');
const shell = fs.readFileSync('public/zypp-shell.js','utf8');

assert(shell.includes('window.__zf = window.fetch.bind(window)'));
assert(shell.includes('headers.set("Authorization", "Bearer " + token)'));
assert(shell.includes('seo-agent-auth-changed'));
assert(shell.includes('window.addEventListener("storage", e =>'));
assert(index.includes('...authHeaders()'));
assert(index.includes('credentials:"same-origin"'));
assert(index.includes('window.dispatchEvent(new CustomEvent("seo-agent-auth-changed"'));

for (const endpoint of [
  '/api/export-pdf', '/api/pagespeed', '/api/trends',
  '/api/backlink-opportunities', '/api/monitor-snapshot'
]) {
  assert(index.includes(endpoint), `Missing endpoint ${endpoint}`);
}
console.log('AUTH SESSION BRIDGE TEST PASSED');
