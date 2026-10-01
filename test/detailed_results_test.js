const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const js=fs.readFileSync(path.join(root,'public','pro-premium.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'public','pro-premium.css'),'utf8');
function assert(c,m){if(!c)throw new Error(m)}
assert(js.includes('function jsonReadable(value,depth=0)'), 'jsonReadable renderer missing');
assert(js.includes('prettyKey'), 'human-readable nested field formatter missing');
assert(js.includes('additional items omitted from the visual view'), 'array overflow handling missing');
assert(!js.includes('Nested data available'), 'generic nested-data placeholder must not exist');
assert(!html.includes('Nested data available'), 'generic nested-data placeholder must not exist in HTML');
assert(html.includes('/pro-premium.js?v=11.1.0'), 'premium JS cache-busting version missing');
assert(html.includes('/pro-premium.css?v=11.1.0'), 'premium CSS cache-busting version missing');
assert(css.includes('.pp-raw .pp-json-field'), 'detailed result layout rules missing');
console.log('Detailed-results regression tests passed.');

assert(js.includes('Scores, URLs and result blocks already visible above are intentionally not repeated.'), 'detailed ledger must suppress duplicate scores/results');
assert(js.includes('const consumed=new Set(['), 'detailed ledger must filter duplicate result aliases');
