const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const py = fs.readFileSync(path.join(root, 'seo-engine', 'main.py'), 'utf8');
const requiredRoutes = [
  '/api/agent/dashboard','/api/agent/rank-history','/api/agent/action-center',
  '/api/agent/keyword-gap','/api/agent/content-decay','/api/agent/ai-advisor',
  '/api/agent/content-refresh','/api/agent/ai-strategy','/api/agent/monitor/jobs',
  '/api/agent/monitor/run','/api/agent/alerts','/api/agent/projects','/api/agent/report-pdf'
];
for (const route of requiredRoutes) assert(server.includes(route), `Missing ${route}`);
for (const id of ['agent-dashboard','rank-history','action-center','gsc-gap','monitoring','ai-advisor','projects-reports']) assert(html.includes(`view-${id}`), `Missing view ${id}`);
for (const route of ['/agent-dashboard','/agent-action-center','/agent-keyword-gap','/agent-content-decay','/agent-rank-history','/agent-report-pdf']) assert(py.includes(`"${route}"`), `Missing Python ${route}`);
assert(server.includes('async function pythonPost('), 'Missing centralized pythonPost helper');
assert(server.includes('app.post("/api/agent/ask"'), 'Missing conversational AI endpoint');
assert(server.includes('180000'), 'Python engine proxy timeout is not configured for long-running audits');
assert(html.includes('/askseo-inspired.css'), 'Missing AskSEO-inspired stylesheet');
assert(html.includes('/askseo-inspired.js'), 'Missing AskSEO-inspired UX layer');
assert(html.includes('id="pullHandle"'), 'Missing lamp login interaction');
assert(!html.includes('harry@420'), 'Hard-coded admin password must never be shipped in frontend');
assert(!html.includes('nileshoffice260@gmail.com'), 'Hard-coded admin email must never be shipped in frontend');
assert(fs.readFileSync(path.join(root,'seo-engine','requirements.txt'),'utf8').includes('reportlab'));
console.log('PHASE AGENT STATIC INTEGRATION TESTS PASSED');
