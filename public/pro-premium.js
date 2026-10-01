(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>typeof window.escapeHtml==='function'?window.escapeHtml(String(v??'')):String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const auth=()=>{try{const a=JSON.parse(localStorage.getItem('seoAgentAuth')||'{}');return a.token?{Authorization:'Bearer '+a.token}:{};}catch{return{}}};
  // Correctness first: live POST audit requests are never cached. GET requests
  // may be deduplicated/cached, while identical live POSTs are only deduplicated
  // while the exact request is in flight.
  const apiCache=new Map(), apiInflight=new Map();
  const API_CACHE_MS=10000;
  function apiKey(path,body,method){return method+' '+path+' '+JSON.stringify(body||{});}
  async function api(path,body,method='POST'){
    const key=apiKey(path,body,method), now=Date.now(), cacheable=method==='GET';
    if(cacheable){ const cached=apiCache.get(key); if(cached && now-cached.time<API_CACHE_MS) return cached.data; }
    if(apiInflight.has(key)) return apiInflight.get(key);
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),180000);
    const request=(async()=>{
      try {
        const r=await fetch(path,{method,headers:{'Content-Type':'application/json','Accept':'application/json','Cache-Control':'no-store',...auth()},body:method==='GET'?undefined:JSON.stringify(body||{}),signal:controller.signal});
        const ct=r.headers.get('content-type')||''; if(ct.includes('application/pdf')) return r;
        const d=await r.json().catch(()=>({})); if(!r.ok||d.success===false) throw new Error(d.error||`Request failed (${r.status})`);
        if(cacheable) apiCache.set(key,{time:Date.now(),data:d});
        return d;
      } catch(e){ if(e.name==='AbortError') throw new Error('The request timed out. Please retry the analysis.'); throw e; }
      finally { clearTimeout(timeout); }
    })();
    apiInflight.set(key,request);
    try{return await request;}finally{apiInflight.delete(key);}
  }
  function safeNum(v){const n=Number(v);return Number.isFinite(n)?n:null}
  function pct(n,d){return d?Math.round(n/d*100):0}
  function statusClass(s){s=String(s||'').toLowerCase();return s==='pass'||s==='passed'||s==='good'||s==='verified'?'good':s==='fail'||s==='critical'||s==='error'?'bad':s==='info'||s==='informational'?'info':'warn'}
  function pill(text,kind='info'){return `<span class="pp-pill pp-${kind}">${esc(text)}</span>`}
  function card(title,body,opts=''){return `<article class="pp-card ${opts}"><div class="pp-card-head"><div><h3>${esc(title)}</h3></div></div>${body}</article>`}
  function kpi(label,value,sub,kind='blue'){return `<div class="pp-kpi pp-${kind}"><div class="pp-kpi-label">${esc(label)}</div><div class="pp-kpi-value">${esc(value)}</div><div class="pp-kpi-sub">${esc(sub||'')}</div></div>`}
  function bar(label,value,max,kind='blue',suffix=''){const p=max?Math.max(0,Math.min(100,(Number(value)||0)/max*100)):0;return `<div class="pp-bar-row"><div class="pp-bar-label"><span>${esc(label)}</span><b>${esc(String(value??'—'))}${esc(suffix)}</b></div><div class="pp-bar-track"><i class="pp-bar-fill pp-${kind}" style="width:${p}%"></i></div></div>`}
  function scoreRing(score,label){const s=safeNum(score);const p=s===null?0:Math.max(0,Math.min(100,s));return `<div class="pp-ring" style="--pp:${p*3.6}deg"><div><strong>${s===null?'—':Math.round(s)}</strong><span>/100</span></div><small>${esc(label)}</small></div>`}
  function donut(counts){const p=Number(counts.passed||0),w=Number(counts.warnings||0),c=Number(counts.critical||0),t=Math.max(1,p+w+c);const a=p/t*360,b=w/t*360;return `<div class="pp-donut" style="background:conic-gradient(#22c55e 0 ${a}deg,#f59e0b ${a}deg ${a+b}deg,#ef4444 ${a+b}deg 360deg)"><div><b>${t}</b><span>checks</span></div></div>`}
  function miniLine(points,color='blue',width=640,height=180){
    const vals=points.map(p=>safeNum(p)).filter(v=>v!==null); if(!vals.length)return '<div class="pp-empty">Not enough numeric history to draw a chart yet.</div>';
    const min=Math.min(...vals),max=Math.max(...vals),range=Math.max(1,max-min),pad=18;
    const pts=vals.map((v,i)=>`${pad+i/Math.max(1,vals.length-1)*(width-pad*2)},${height-pad-(v-min)/range*(height-pad*2)}`).join(' ');
    return `<svg class="pp-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend chart"><line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}" class="pp-axis"/><polyline points="${pts}" class="pp-line pp-${color}"/><g>${vals.map((v,i)=>{const x=pad+i/Math.max(1,vals.length-1)*(width-pad*2),y=height-pad-(v-min)/range*(height-pad*2);return `<circle cx="${x}" cy="${y}" r="3" class="pp-dot pp-${color}"/>`}).join('')}</g></svg>`;
  }
  function fieldIcon(key){
    const k=String(key||'').toLowerCase();
    if(k==='success')return '✓';
    if(k==='source')return '◆';
    if(k==='url')return '⛓';
    if(k==='score')return '◎';
    if(k.includes('pass'))return '✓';
    if(k.includes('warn'))return '!';
    if(k.includes('crit')||k.includes('fail')||k.includes('error'))return '×';
    if(k.includes('word'))return '¶';
    if(k.includes('link'))return '⛓';
    if(k.includes('image'))return '▣';
    if(k.includes('schema'))return '◈';
    if(k.includes('time')||k.includes('date'))return '◷';
    return '•';
  }
  function isCategoryBucket(o){
    if(!o||typeof o!=='object'||Array.isArray(o))return false;
    const keys=Object.keys(o).map(k=>k.toLowerCase());
    return ['checks','passed','warnings','critical','total','pass','fail','failed'].filter(k=>keys.includes(k)).length>=2;
  }
  function statRow(o){
    const order=['checks','total','passed','pass','warnings','critical','fail','failed'];
    const seen=new Set();
    const items=[];
    order.forEach(k=>{const key=Object.keys(o).find(x=>x.toLowerCase()===k);if(key&&!seen.has(key)){seen.add(key);items.push([key,o[key]]);}});
    Object.keys(o).forEach(k=>{if(!seen.has(k)){seen.add(k);items.push([k,o[k]]);}});
    return `<div class="pp-stat-row">${items.map(([k,v])=>{const lk=k.toLowerCase();const kind=lk.includes('pass')?'good':lk.includes('warn')?'warn':(lk.includes('crit')||lk.includes('fail'))?'bad':'info';return `<div class="pp-stat-chip pp-${kind}"><b>${esc(v)}</b><small>${esc(k.replace(/_/g,' '))}</small></div>`}).join('')}</div>`;
  }
  function fieldList(obj,depth){
    const seenVals=new Set();
    const rows=Object.entries(obj).slice(0,40).filter(([k,v])=>{
      if(typeof v==='string'&&v.trim()){
        const norm=v.trim().toLowerCase();
        if(seenVals.has(norm))return false; // dedupe fields that just repeat an earlier field's text (e.g. value===details)
        seenVals.add(norm);
      }
      return true;
    });
    return `<div class="pp-field-list">${rows.map(([k,v])=>`<div class="pp-field-row"><span class="pp-field-key"><span class="pp-json-ico">${fieldIcon(k)}</span>${esc(prettyKey(k))}</span><span class="pp-field-val">${jsonReadable(v,depth+1)}</span></div>`).join('')}</div>`;
  }
  function prettyKey(key){
    return String(key||'value').replace(/([A-Z])/g,' $1').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g,c=>c.toUpperCase());
  }
  function jsonReadable(value,depth=0){
    if(depth>10){ try { return `<pre class="pp-json-pre">${esc(JSON.stringify(value,null,2))}</pre>`; } catch { return `<span class="pp-muted">Unable to expand nested value</span>`; } }
    if(value===null||value===undefined)return '<span class="pp-muted">Not available</span>';
    if(typeof value==='boolean')return `<span class="pp-pill ${value?'pp-good':'pp-bad'}">${value?'✓ TRUE':'✕ FALSE'}</span>`;
    if(typeof value==='number')return `<span class="pp-value pp-value-num">${esc(value)}</span>`;
    if(typeof value==='string'){
      if(!value.trim())return '<span class="pp-muted">Empty</span>';
      if(/^https?:\/\//i.test(value))return `<a class="pp-evidence-link" href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a>`;
      return `<span class="pp-value">${esc(value)}</span>`;
    }
    if(Array.isArray(value)){
      if(!value.length)return '<span class="pp-muted">No items returned</span>';
      return `<div class="pp-json-list"><div class="pp-muted pp-json-count">${value.length} item${value.length===1?'':'s'}</div>${value.slice(0,30).map((x,i)=>`<div class="pp-json-item"><span class="pp-index">${i+1}</span><div>${jsonReadable(x,depth+1)}</div></div>`).join('')}${value.length>30?`<div class="pp-muted">${value.length-30} additional items omitted from the visual view.</div>`:''}</div>`;
    }
    if(depth>0&&isCategoryBucket(value))return statRow(value);
    if(depth>0)return fieldList(value,depth);
    const entries=Object.entries(value);
    if(!entries.length)return '<span class="pp-muted">No data returned</span>';
    return `<div class="pp-json-grid">${entries.slice(0,40).map(([k,v])=>`<div class="pp-json-field"><div class="pp-json-key"><span class="pp-json-ico">${fieldIcon(k)}</span>${esc(prettyKey(k))}</div><div>${jsonReadable(v,depth+1)}</div></div>`).join('')}${entries.length>40?`<div class="pp-muted">${entries.length-40} additional fields omitted from the visual view.</div>`:''}</div>`;
  }
  function categoryIcon(cat){
    const c=String(cat||'').toLowerCase();
    if(c.includes('access'))return '♿';
    if(c.includes('schema'))return '◈';
    if(c.includes('index'))return '◎';
    if(c.includes('content'))return '¶';
    if(c.includes('technical'))return '⚙';
    if(c.includes('perform')||c.includes('speed'))return '⚡';
    if(c.includes('link'))return '⛓';
    return '•';
  }
  function categorySummaryPanel(cats){
    const entries=Object.entries(cats||{}).filter(([,v])=>v&&typeof v==='object');
    if(!entries.length)return '';
    return `<div class="pp-cat-grid">${entries.map(([name,v])=>{
      const checks=Number(v.checks??v.total??0),passed=Number(v.passed??0),warnings=Number(v.warnings??0),critical=Number(v.critical??0);
      const pct=checks?Math.round(passed/checks*100):0;
      const state=critical>0?'bad':warnings>0?'warn':'good';
      return `<div class="pp-cat-card"><div class="pp-cat-head"><span class="pp-cat-ico">${categoryIcon(name)}</span><b>${esc(name)}</b><span class="pp-pill pp-${state}">${pct}%</span></div><div class="pp-cat-stats"><div class="pp-cat-stat"><span>${checks}</span><small>Checks</small></div><div class="pp-cat-stat pp-cat-good"><span>${passed}</span><small>Passed</small></div><div class="pp-cat-stat pp-cat-warn"><span>${warnings}</span><small>Warnings</small></div><div class="pp-cat-stat pp-cat-bad"><span>${critical}</span><small>Critical</small></div></div><div class="pp-bar-track" style="margin-top:11px"><i class="pp-bar-fill pp-${state==='good'?'green':state==='warn'?'amber':'red'}" style="width:${pct}%"></i></div></div>`;
    }).join('')}</div>`;
  }
  function evidenceStrip(v,opts={}){
    const rows=[];
    if(!opts.hideSuccess && Object.prototype.hasOwnProperty.call(v,'success'))rows.push(['Verified',v.success?'<span class="pp-pill pp-good">✓ SUCCESS</span>':'<span class="pp-pill pp-bad">✕ FAILED</span>']);
    if(!opts.hideSource && v.source)rows.push(['Source',`<span class="pp-pill pp-info">${esc(v.source)}</span>`]);
    if(!opts.hideScore && v.score!=null)rows.push(['Score',`<span class="pp-evidence-score">${esc(v.score)}<small>/100</small></span>`]);
    if(!opts.hideUrl && v.url)rows.push(['Audited URL',`<a class="pp-evidence-link" href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.url)}</a>`]);
    if(!rows.length)return '';
    return `<div class="pp-evidence-strip">${rows.map(([k,v])=>`<div class="pp-evidence-item"><span class="pp-evidence-key">${esc(k)}</span>${v}</div>`).join('')}</div>`;
  }
  function extractCounts(o){
    if(!o||typeof o!=='object')return null;
    if(o.counts&&typeof o.counts==='object')return o.counts;
    if(['passed','warnings','critical'].some(k=>o[k]!=null))return {passed:o.passed,warnings:o.warnings,critical:o.critical};
    if(o.snapshot&&typeof o.snapshot==='object'&&['critical','warnings'].some(k=>o.snapshot[k]!=null))return {passed:o.snapshot.passed,warnings:o.snapshot.warnings,critical:o.snapshot.critical};
    return null;
  }
  function extractMetrics(o){return o&&o.metrics&&typeof o.metrics==='object'?o.metrics:null}
  function richEvidence(value,opts={}){
    if(!value||typeof value!=='object')return jsonReadable(value);
    const counts=extractCounts(value), metrics=extractMetrics(value);
    let visual='';
    if(counts&&(counts.passed!=null||counts.warnings!=null||counts.critical!=null)){
      visual+=`<div class="pp-evidence-chart-block">${donut(counts)}<div class="pp-legend"><div>✓ Passed <b>${counts.passed??0}</b></div><div>⚠ Warnings <b>${counts.warnings??0}</b></div><div>× Critical <b>${counts.critical??0}</b></div></div></div>`;
    }
    let metricsHtml='';
    if(metrics){
      const numeric=Object.entries(metrics).filter(([,v])=>v!=null&&v!==''&&!isNaN(parseFloat(v)));
      if(numeric.length){
        const max=Math.max(...numeric.map(([,v])=>Number(v)||0),1);
        metricsHtml=`<div class="pp-evidence-metrics">${numeric.slice(0,8).map(([k,v])=>bar(k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),v,max,'blue')).join('')}</div>`;
      }
    }
    const catSummary=(value.categorySummary&&typeof value.categorySummary==='object')?value.categorySummary:null;
    const catHtml=catSummary?categorySummaryPanel(catSummary):'';
    // Do not print the same object through multiple aliases. The old ledger rendered
    // top-level score AND audit.score, top-level checks AND audit.checks, plus actions
    // that were already visible immediately above. Keep only genuinely additional data.
    const consumed=new Set(['success','source','url','score','counts','metrics','categorySummary','audit','checks','actions','technical','seo','evidence','snapshot','advisor','refresh','strategy','verified','refresh_plan','priorities']);
    const rest=Object.fromEntries(Object.entries(value).filter(([k])=>!consumed.has(k)));
    const restHtml=Object.keys(rest).length?jsonReadable(rest):'';
    return `<div class="pp-evidence">
      <div class="pp-evidence-head"><span class="pp-evidence-badge">TRUST &amp; EVIDENCE LEDGER</span><p>Only additional verified fields are shown here. Scores, URLs and result blocks already visible above are intentionally not repeated.</p></div>
      ${visual?`<div class="pp-evidence-chart-row">${visual}</div>`:''}
      ${metricsHtml?`<div class="pp-evidence-card"><div class="pp-section-title">Verified page metrics</div>${metricsHtml}</div>`:''}
      ${catHtml?`<div class="pp-evidence-card"><div class="pp-section-title">Results by category</div>${catHtml}</div>`:''}
      ${restHtml?`<div class="pp-evidence-card"><div class="pp-section-title">Additional evidence fields</div>${restHtml}</div>`:''}
      ${!metricsHtml&&!catHtml&&!restHtml&&!visual?'<div class="pp-empty">No additional evidence fields were returned beyond the results already shown above.</div>':''}
    </div>`;
  }
  function actionCards(actions){return (actions||[]).map((a,i)=>`<details class="pp-action" ${i<2?'open':''}><summary style="display:flex;align-items:center;gap:10px;padding:13px 14px;"><span class="pp-action-no" style="flex:0 0 auto;">${i+1}</span><span class="pp-action-main" style="display:flex;flex:1;min-width:0;justify-content:space-between;align-items:center;gap:8px;overflow:hidden;"><b style="flex:1;min-width:0;overflow-wrap:anywhere;word-break:break-word;white-space:normal;font-size:13px;color:#2d4059;">${esc(a.title||a.name||'SEO action')}</b><span style="flex:0 0 auto;min-width:54px;text-align:right;">${pill(String(a.priority||'medium').toUpperCase(),statusClass(a.priority))}</span></span></summary><div class="pp-action-body"><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;"><div style="min-width:0;overflow-wrap:anywhere;word-break:break-word;"><b>What to do</b><p style="margin:5px 0 0;overflow-wrap:anywhere;word-break:break-word;white-space:normal;">${esc(a.what_to_do||a.implementation||a.recommended_fix||'Review and improve this area.')}</p></div><div style="min-width:0;overflow-wrap:anywhere;word-break:break-word;"><b>Why it matters</b><p style="margin:5px 0 0;overflow-wrap:anywhere;word-break:break-word;white-space:normal;">${esc(a.why_it_matters||a.why||a.description||'This can improve crawlability, relevance, usability or search visibility when the underlying issue is present.')}</p></div></div><label class="pp-check"><input type="checkbox" data-pp-task="${i}"> Mark as reviewed</label></div></details>`).join('')||'<div class="pp-empty">No immediate actions were returned. The verified checks did not identify an actionable issue in this run.</div>'}
  function shell(url,source,inner){return `<div class="pp-hero"><div><span class="pp-eyebrow">PROFESSIONAL SEO INTELLIGENCE</span><h2>${esc(url||'Website analysis')}</h2><p>Evidence-first analysis converted from machine JSON into an executive summary, visual signals, detailed explanations and practical next actions.</p></div><div class="pp-source">${pill('LIVE / VERIFIED','good')}<small>${esc(source||'SEO Agent Engine')}</small></div></div>${inner}`}
  function renderDash(d){
    const c=d.counts||{},m=d.metrics||{}; const total=(c.passed||0)+(c.warnings||0)+(c.critical||0);
    const max=Math.max(Number(m.words)||0,Number(m.internal_links)||0,Number(m.images)||0,Number(m.schema)||0,1);
    return shell(d.url,d.source,`<div class="pp-kpis">${kpi('SEO score',`${d.score??'—'}/100`,'Composite verified check score','blue')}${kpi('Critical issues',c.critical||0,'Highest-priority problems','red')}${kpi('Warnings',c.warnings||0,'Needs attention','amber')}${kpi('Passed checks',c.passed||0,`of ${total} checks`,'green')}</div><div class="pp-grid-2"><div class="pp-card"><div class="pp-section-title">Health distribution</div><div class="pp-chart-flex">${scoreRing(d.score,'Overall health')}${donut(c)}<div class="pp-legend"><div>✓ Passed <b>${c.passed||0}</b></div><div>⚠ Warnings <b>${c.warnings||0}</b></div><div>× Critical <b>${c.critical||0}</b></div></div></div><p class="pp-explain">The score summarizes the checks the crawler could verify on the page. A critical issue should normally be resolved before lower-impact polish work.</p></div><div class="pp-card"><div class="pp-section-title">Verified page footprint</div>${bar('Visible words',m.words,max,'blue')}${bar('Internal links',m.internal_links,max,'purple')}${bar('Images',m.images,max,'cyan')}${bar('Schema blocks',m.schema,max,'green')}<div class="pp-metric-notes"><span>Missing image alt: <b>${m.missing_alt??'—'}</b></span><span>Redirects observed: <b>${m.redirects??'—'}</b></span></div></div></div><div class="pp-grid-2"><div class="pp-card"><div class="pp-section-title">Executive interpretation</div><div class="pp-callout" style="display:block;white-space:normal;overflow-wrap:anywhere;word-break:break-word;width:100%;box-sizing:border-box;">${esc(d.message||'The audit has completed. Review critical issues first, then warnings, then growth opportunities.')}</div><p class="pp-explain">This section answers <b>“What does the result mean?”</b> rather than exposing raw JSON. The agent only describes metrics that were actually returned by the crawler.</p></div><div class="pp-card"><div class="pp-section-title">Recommended execution order</div><ol class="pp-steps" style="white-space:normal;word-break:break-word;overflow-wrap:anywhere;"><li style="white-space:normal;word-break:break-word;"><b>Stabilize:</b> resolve critical crawl, indexing or page-quality issues.</li><li style="white-space:normal;word-break:break-word;"><b>Improve:</b> work through warnings that affect relevance and usability.</li><li style="white-space:normal;word-break:break-word;"><b>Expand:</b> use keyword/content opportunities after the foundation is clean.</li><li style="white-space:normal;word-break:break-word;"><b>Measure:</b> rerun the audit and compare the score and issue mix.</li></ol></div></div><div class="pp-card"><div class="pp-section-title">Detailed action center</div>${actionCards(d.actions)}</div><details class="pp-raw"><summary>Click to see detailed result</summary>${richEvidence(d)}</details>`)
  }
  function renderActions(d){
    const a=d.actions||[], groups={critical:0,high:0,medium:0,low:0}; a.forEach(x=>{const p=String(x.priority||'medium').toLowerCase();groups[p]=(groups[p]||0)+1});
    return shell(d.url,'Python evidence-first action engine',`<div class="pp-kpis">${kpi('Total actions',d.total??a.length,'Prioritized recommendations','blue')}${kpi('Critical',groups.critical,'Fix first','red')}${kpi('High',groups.high,'High impact','amber')}${kpi('Medium + low',(groups.medium||0)+(groups.low||0),'Optimization backlog','purple')}</div><div class="pp-grid-2"><div class="pp-card"><div class="pp-section-title">Priority mix</div>${bar('Critical',groups.critical,Math.max(...Object.values(groups),1),'red')}${bar('High',groups.high,Math.max(...Object.values(groups),1),'amber')}${bar('Medium',groups.medium,Math.max(...Object.values(groups),1),'blue')}${bar('Low',groups.low,Math.max(...Object.values(groups),1),'green')}<p class="pp-explain">Priority is derived from the verified issue severity. It is not a prediction of guaranteed ranking improvement.</p></div><div class="pp-card"><div class="pp-section-title">How to use this plan</div><div class="pp-callout" style="display:block;white-space:normal;overflow-wrap:anywhere;word-break:break-word;width:100%;box-sizing:border-box;">${esc(d.summary||'Work from the top of the list downward. Record completed fixes, then rerun the audit to verify the result.')}</div><ul class="pp-bullets"><li>Open each action for implementation detail.</li><li>Mark completed items locally as reviewed.</li><li>Re-crawl after meaningful changes.</li></ul></div></div><div class="pp-card"><div class="pp-section-title">Detailed prioritized actions</div>${actionCards(a)}</div><details class="pp-raw"><summary>Click to see detailed result</summary>${richEvidence(d)}</details>`)
  }
  function renderRank(d){
    const series=d.series||[]; const rows=series.map(x=>{const pts=x.points||[], vals=pts.map(p=>safeNum(p.position)).filter(v=>v!==null), first=vals[0],last=vals[vals.length-1],delta=(first!=null&&last!=null)?first-last:null;return {x,vals,first,last,delta}});
    return shell(d.url,'Live regional Google checks via SerpApi',`<div class="pp-kpis">${kpi('Keywords checked',d.snapshot?.keywords?.length||rows.length,'This run','blue')}${kpi('History points',rows.reduce((n,r)=>n+r.vals.length,0),'Stored observations','purple')}${kpi('Improving',rows.filter(r=>(r.delta||0)>0).length,'Lower rank number is better','green')}${kpi('Declining',rows.filter(r=>(r.delta||0)<0).length,'Needs review','red')}</div><div class="pp-grid-2">${rows.slice(0,6).map(r=>card(r.x.keyword,`<div class="pp-rank-head">${r.last==null?pill('Not found','bad'):`<strong>#${r.last}</strong>`}<span>${r.x.message||'No change classification'}</span></div>${miniLine(r.vals,'blue')}<div class="pp-explain">${r.first!=null&&r.last!=null?`From #${r.first} to #${r.last}: ${r.delta>0?'improved':'declined or stayed behind'} by ${Math.abs(r.delta)} position(s) in the stored observations.`:'A trend requires at least two numeric ranking observations.'}</div>`,'pp-rank-card')).join('')||'<div class="pp-empty">Run a ranking check to start building historical data.</div>'}</div><div class="pp-card"><div class="pp-section-title">Methodology & interpretation</div><p class="pp-explain">The rank history uses actual regional SERP checks returned by the configured provider. Position numbers are snapshots and can change with location, device, personalization and time. The chart is descriptive, not a forecast.</p><div class="pp-callout" style="display:block;white-space:normal;overflow-wrap:anywhere;word-break:break-word;width:100%;box-sizing:border-box;">Best practice: check the same keywords in the same country on a consistent cadence, then investigate large movements with the Rank Checker and page-level audit.</div></div><details class="pp-raw"><summary>Click to see detailed result</summary>${richEvidence(d)}</details>`)
  }
  function renderGap(d){
    const ops=d.opportunities||[]; const max= Math.max(...ops.map(x=>Number(x.competitor_best_position)||100),1);
    return shell(d.url,'Live SERP gap analysis',`<div class="pp-kpis">${kpi('Opportunities',ops.length,'Detected from supplied keyword set','blue')}${kpi('Not ranking',ops.filter(x=>x.your_position==null).length,'Your page absent from checked results','red')}${kpi('Competitive wins',ops.filter(x=>x.your_position!=null).length,'You already appear in SERP','green')}${kpi('Inputs',d.keywords_checked??'—','Keywords evaluated','purple')}</div><div class="pp-card"><div class="pp-section-title">Opportunity map</div><div class="pp-table-wrap"><table class="pp-table"><thead><tr><th>Keyword</th><th>Your position</th><th>Best competitor</th><th>Gap</th><th>Interpretation</th></tr></thead><tbody>${ops.map(x=>{const yp=safeNum(x.your_position),cp=safeNum(x.competitor_best_position),gap=yp==null?null:yp-cp;return `<tr><td><b>${esc(x.keyword)}</b></td><td>${yp==null?pill('Not found','bad'):`#${yp}`}</td><td>${cp==null?'—':`#${cp}`}</td><td>${gap==null?'—':`${gap>0?'+':''}${gap}`}</td><td>${esc(x.explanation||'Review intent match, content depth and SERP competitors.')}</td></tr>`}).join('')||'<tr><td colspan="5">No keyword gaps found in the supplied set.</td></tr>'}</tbody></table></div></div><div class="pp-grid-2"><div class="pp-card"><div class="pp-section-title">What the gap means</div><p class="pp-explain">A keyword gap means the checked competitor set is appearing more strongly than your supplied page for a keyword. “Not found” means the page was not present in the checked SERP depth; it does not prove that Google has never indexed the page.</p></div><div class="pp-card"><div class="pp-section-title">Recommended response</div><ol class="pp-steps" style="white-space:normal;word-break:break-word;overflow-wrap:anywhere;"><li>Validate search intent before changing the page.</li><li>Compare the top results' topic coverage and page format.</li><li>Close meaningful content gaps without copying competitors.</li><li>Add relevant internal links and recheck the keyword.</li></ol></div></div><details class="pp-raw"><summary>Click to see detailed result</summary>${richEvidence(d)}</details>`)
  }
  function renderGsc(stats){
    const {clicks,imp,ctr,avg,rows}=stats; const scale=Math.max(clicks,imp/10,1);
    return `<div class="pp-hero"><div><span class="pp-eyebrow">SEARCH CONSOLE IMPORT</span><h2>Real performance data</h2><p>The CSV was parsed locally. These numbers come from the selected export and are not estimated by the agent.</p></div><div class="pp-source">${pill('SOURCE: YOUR CSV','good')}<small>${rows} data rows</small></div></div><div class="pp-kpis">${kpi('Clicks',clicks.toLocaleString(),'From exported rows','blue')}${kpi('Impressions',imp.toLocaleString(),'Search visibility events','purple')}${kpi('CTR',ctr.toFixed(2)+'%','Clicks ÷ impressions','green')}${kpi('Avg position',avg==null?'—':avg.toFixed(2),'Average exported position','amber')}</div><div class="pp-grid-2"><div class="pp-card"><div class="pp-section-title">Performance scale</div>${bar('Clicks',clicks,scale,'blue')}${bar('Impressions / 10',imp/10,scale,'purple')}<p class="pp-explain">Clicks and impressions are on different scales, so the visual normalizes impressions by 10 for readability. The KPI values above remain exact from the parsed file.</p></div><div class="pp-card"><div class="pp-section-title">What to investigate</div><ul class="pp-bullets"><li>High impressions + low CTR → review title and meta description.</li><li>Good CTR + low position → improve relevance and content depth.</li><li>Declining clicks → compare page intent and recent SERP changes.</li></ul></div></div>`;
  }
  function renderDecay(d){const arr=d.decaying_pages||[];const vals=arr.map(x=>Math.abs(Number(x.click_change_pct)||0));const max=Math.max(...vals,1);return shell('Content decay analysis','Local CSV + verified decay rules',`<div class="pp-kpis">${kpi('Pages checked',d.pages_checked??'—','Rows supplied','blue')}${kpi('Pages decaying',arr.length,'Meaningful decline detected','red')}${kpi('High severity',arr.filter(x=>x.severity==='High').length,'Priority refresh candidates','amber')}${kpi('Rule based','Yes','No invented traffic data','green')}</div><div class="pp-card"><div class="pp-section-title">Decline magnitude</div>${arr.slice(0,12).map(x=>bar(x.title||x.url,Math.abs(Number(x.click_change_pct)||0),max,'red','%')).join('')||'<div class="pp-empty">No meaningful decay was detected in the supplied data.</div>'}</div><div class="pp-grid-2">${arr.slice(0,12).map(x=>card(x.title||'Decaying page',`<div class="pp-page-url">${esc(x.url)}</div><div class="pp-two"><div><b>Click change</b><p>${x.click_change_pct==null?'—':esc(x.click_change_pct+'%')}</p></div><div><b>Position change</b><p>${x.position_change==null?'—':esc(String(x.position_change))}</p></div></div><p class="pp-explain">${esc(x.recommendation||'Refresh the page after validating intent and current SERP expectations.')}</p>`,'pp-decay-card')).join('')||'<div class="pp-empty">No pages need immediate decay remediation.</div>'}</div>`)}
  function renderMonitoring(d){const s=d.snapshot||{},p=d.previous||{};return shell(s.url||'Monitoring snapshot','Persistent monitoring service',`<div class="pp-kpis">${kpi('SEO score',s.score==null?'—':s.score+'/100','Current snapshot','blue')}${kpi('Critical',s.critical??0,'Immediate attention','red')}${kpi('Warnings',s.warnings??0,'Review recommended','amber')}${kpi('Score change',d.scoreChange==null?'—':(d.scoreChange>0?'+':'')+d.scoreChange,'Compared with previous snapshot','green')}</div><div class="pp-grid-2"><div class="pp-card"><div class="pp-section-title">Monitoring interpretation</div><div class="pp-callout" style="display:block;white-space:normal;overflow-wrap:anywhere;word-break:break-word;width:100%;box-sizing:border-box;">${esc(d.alert?.message||'Snapshot completed. Review the issue counts and compare the next run.')}</div><p class="pp-explain">Monitoring is designed to detect change over time. A single snapshot is a baseline; repeated snapshots become useful for trend analysis.</p></div><div class="pp-card"><div class="pp-section-title">Before vs current</div>${bar('Current score',s.score||0,100,'blue')}${bar('Previous score',p.score||0,100,'purple')}<div class="pp-metric-notes"><span>Previous critical: <b>${p.critical??'—'}</b></span><span>Previous warnings: <b>${p.warnings??'—'}</b></span></div></div></div><details class="pp-raw"><summary>Click to see detailed result</summary>${richEvidence(d)}</details>`)}
  function renderAi(d,kind){const x=d.advisor||d.refresh||d.strategy||{};const arr=x.priorities||x.refresh_plan||x.weeks||[];return shell(d.url||'AI SEO workspace','Gemini grounded in verified page evidence',`<div class="pp-card pp-ai"><div class="pp-ai-badge">AI EXPLANATION</div><h3>${esc(x.summary||x.executive_summary||x.diagnosis||'AI analysis completed')}</h3><p class="pp-explain">${esc(x.executive_explanation||'This answer is generated from verified evidence supplied by the SEO engine. It is an interpretation and implementation aid, not proof of rankings or traffic.')}</p>${x.plain_language_takeaway?`<div class="pp-callout" style="margin-top:12px"><b>In plain English:</b> ${esc(x.plain_language_takeaway)}</div>`:''}</div><div class="pp-grid-2">${arr.slice(0,12).map((a,i)=>card(`${i+1}. ${a.title||a.goal||a.week||'Recommended step'}`,`<div class="pp-ai-detail"><b>What to do</b><p>${esc(a.what_to_do||a.what_to_change||a.actions||a.description||a.action||a.recommendation||'See the detailed recommendation below.')}</p><b>Why it matters</b><p>${esc(a.why_it_matters||a.why||a.rationale||'It addresses a verified signal or strategic opportunity in the supplied evidence.')}</p>${a.evidence?`<b>Evidence</b><p>${esc(a.evidence)}</p>`:''}${Array.isArray(a.implementation_steps)?`<b>Implementation steps</b><ol class="pp-steps" style="white-space:normal;word-break:break-word;overflow-wrap:anywhere;">${a.implementation_steps.slice(0,8).map(z=>`<li>${esc(z)}</li>`).join('')}</ol>`:''}${a.measurement?`<b>How to measure</b><p>${esc(a.measurement)}</p>`:''}</div>`,'pp-ai-card')).join('')||'<div class="pp-empty">The AI response did not contain a list structure; use the readable response below.</div>'}</div>${x.quick_wins?.length?`<div class="pp-card"><div class="pp-section-title">Quick wins</div>${x.quick_wins.map(q=>`<div class="pp-callout" style="margin:7px 0">${esc(typeof q==='string'?q:(q.title||q.action||JSON.stringify(q)))}</div>`).join('')}</div>`:''}${x.measurement_plan?`<div class="pp-card"><div class="pp-section-title">Measurement plan</div><div class="pp-explain">${esc(typeof x.measurement_plan==='string'?x.measurement_plan:JSON.stringify(x.measurement_plan))}</div></div>`:''}<details class="pp-raw"><summary>Click to see detailed result</summary>${richEvidence(x)}</details>`)}

  function renderAudit(data,kind){
    const a=data.audit||data||{}; const checks=Array.isArray(a.checks)?a.checks:[];
    const pass=checks.filter(x=>statusClass(x.status)==='good').length, bad=checks.filter(x=>statusClass(x.status)==='bad').length, warn=checks.length-pass-bad;
    const score=safeNum(a.score); const failed=checks.filter(x=>statusClass(x.status)!=='good');
    return shell(a.url||data.url||'URL audit',`Verified ${kind||'SEO'} checks`, `<div class="pp-kpis">${kpi('SEO score',score==null?'—':score+'/100','Audit health','blue')}${kpi('Checks',checks.length,'Signals evaluated','purple')}${kpi('Passed',pass,'Healthy signals','green')}${kpi('Needs attention',warn+bad,`${bad} critical · ${warn} warnings`,'red')}</div><div class="pp-grid-2"><div class="pp-card"><div class="pp-section-title">Audit distribution</div>${bar('Passed',pass,Math.max(checks.length,1),'green')}${bar('Warnings',warn,Math.max(checks.length,1),'amber')}${bar('Critical',bad,Math.max(checks.length,1),'red')}<p class="pp-explain">The distribution shows how many individual checks returned each status. It is more useful than a score alone because it shows where the risk is concentrated.</p></div><div class="pp-card"><div class="pp-section-title">Executive explanation</div><div class="pp-callout" style="display:block;white-space:normal;overflow-wrap:anywhere;word-break:break-word;width:100%;box-sizing:border-box;">${esc(a.overall_status||data.summary||'Audit complete. Review critical checks first, then warnings.')}</div><p class="pp-explain">A passed check means the crawler observed the expected signal. A warning means the signal needs review. A critical result indicates a more important issue that should be addressed before lower-priority optimization.</p></div></div><div class="pp-card"><div class="pp-section-title">Detailed check-by-check findings</div>${checks.map((x,i)=>`<details class="pp-action" ${i<2?'open':''}><summary><span class="pp-action-no">${i+1}</span><span class="pp-action-main"><b>${esc(x.name||x.title||'SEO check')}</b>${pill(String(x.status||'warning').toUpperCase(),statusClass(x.status))}</span></summary><div class="pp-action-body"><div class="pp-callout" style="display:block;white-space:normal;overflow-wrap:anywhere;word-break:break-word;width:100%;box-sizing:border-box;">${esc(x.details||x.description||'No detailed explanation was returned for this check.')}</div>${x.recommended_fix?`<div style="margin-top:10px"><b>Recommended fix</b><p>${esc(x.recommended_fix)}</p></div>`:''}</div></details>`).join('')||'<div class="pp-empty">No structured checks were returned.</div>'}</div><div class="pp-card"><div class="pp-section-title">Priority interpretation</div>${failed.slice(0,8).map((x,i)=>`<div class="pp-two" style="padding:10px 0;border-bottom:1px solid #e8eef4"><div><b>${i+1}. ${esc(x.name||'Issue')}</b></div><div>${esc(x.recommended_fix||x.details||'Review this signal and implement the recommended improvement.')}</div></div>`).join('')||'<div class="pp-callout" style="display:block;white-space:normal;overflow-wrap:anywhere;word-break:break-word;width:100%;box-sizing:border-box;">No failing or warning checks were returned in this audit.</div>'}</div><details class="pp-raw"><summary>Click to see detailed result</summary>${richEvidence(data)}</details>`)
  }
  function renderDashboardText(text,url){
    const get=(label)=>{const m=String(text||'').match(new RegExp(label+'\\s*:\\s*(-?\\d+)','i'));return m?Number(m[1]):null};
    const score=get('SEO_SCORE'),critical=get('CRITICAL_ISSUES')??0,warnings=get('WARNINGS')??0,passed=get('PASSED')??0;
    const findingMatch=String(text||'').match(/FINDINGS:\s*([\s\S]*?)(?=TOP_ACTIONS:|$)/i); const lines=(findingMatch?findingMatch[1]:'').split(/\n/).map(x=>x.trim()).filter(x=>x.startsWith('-')).slice(0,20);
    return shell(url,'Verified page analysis',`<div class="pp-kpis">${kpi('SEO score',score==null?'—':score+'/100','Page-level score','blue')}${kpi('Critical',critical,'Immediate attention','red')}${kpi('Warnings',warnings,'Needs review','amber')}${kpi('Passed',passed,'Verified positive signals','green')}</div><div class="pp-grid-2"><div class="pp-card"><div class="pp-section-title">Score interpretation</div>${scoreRing(score,'SEO health')}<p class="pp-explain">${score==null?'No numeric score was returned.':score>=90?'The page is in a strong state based on the returned signals. Focus on preserving the foundation and pursuing growth opportunities.':score>=70?'The page has a workable foundation, but there are meaningful optimization opportunities.':'The page has material issues that should be prioritized before aggressive growth work.'}</p></div><div class="pp-card"><div class="pp-section-title">Finding severity</div>${bar('Passed',passed,Math.max(passed,warnings,critical,1),'green')}${bar('Warnings',warnings,Math.max(passed,warnings,critical,1),'amber')}${bar('Critical',critical,Math.max(passed,warnings,critical,1),'red')}<p class="pp-explain">Use the severity mix to decide execution order. Critical issues first, then warnings, then growth improvements.</p></div></div><div class="pp-card"><div class="pp-section-title">Detailed findings</div>${lines.map((line,i)=>{const parts=line.replace(/^[-•]\s*/,'').split('|');return `<details class="pp-action" ${i<2?'open':''}><summary><span class="pp-action-no">${i+1}</span><span class="pp-action-main"><b>${esc(parts[1]||parts[0]||'SEO finding')}</b>${pill(esc(parts[0]||'WARNING'),'warn')}</span></summary><div class="pp-action-body">${esc(parts.slice(2).join('|')||'Review this finding and implement the corresponding improvement.')}</div></details>`}).join('')||'<div class="pp-empty">The response did not contain structured FINDINGS. The raw verified response remains available in the standard report.</div>'}</div>`)
  }

  function install(){
    const premium={
      agentDashRun:async()=>{const out=$('agentDashOut');const url=$('agentDashUrl').value.trim();if(!url)throw new Error('Enter a website URL.');const d=await api('/api/agent/dashboard',{url});out.innerHTML=renderDash(d)},
      actionRun:async()=>{const out=$('actionOut');const url=$('actionUrl').value.trim();if(!url)throw new Error('Enter a website URL.');const d=await api('/api/agent/action-center',{url});out.innerHTML=renderActions(d)},
      rankHistRun:async()=>{const out=$('rankHistOut');const url=$('rankHistUrl').value.trim();const keywords=$('rankHistKeywords').value.split(',').map(x=>x.trim()).filter(Boolean);if(!url||!keywords.length)throw new Error('Enter a website URL and at least one keyword.');const d=await api('/api/agent/rank-history',{url,keywords,country:$('rankHistCountry').value});out.innerHTML=renderRank(d)},
      gapRun:async()=>{const out=$('gapOut');const url=$('gapUrl').value.trim();const keywords=$('gapKeywords').value.split(',').map(x=>x.trim()).filter(Boolean),competitors=$('gapCompetitors').value.split(',').map(x=>x.trim()).filter(Boolean);if(!url)throw new Error('Enter a website URL.');const d=await api('/api/agent/keyword-gap',{url,keywords,competitors,country:$('gapCountry').value});out.innerHTML=renderGap(d)},
      monitorNow:async()=>{const out=$('monitorAgentOut');const url=$('monitorAgentUrl').value.trim();if(!url)throw new Error('Enter a website URL.');const d=await api('/api/agent/monitor/run',{url});out.innerHTML=renderMonitoring(d); if(typeof refreshAlerts==='function')refreshAlerts()},
      aiAdvisorRun:async()=>{const out=$('aiAgentOut');const url=$('aiAgentUrl').value.trim();if(!url)throw new Error('Enter a website URL.');out.innerHTML='<div class="pp-loading">Generating evidence-grounded explanation…</div>';const d=await api('/api/agent/ai-advisor',{url});out.innerHTML=renderAi(d,'advisor')},
      aiRefreshRun:async()=>{const out=$('aiAgentOut');const url=$('aiAgentUrl').value.trim();if(!url)throw new Error('Enter a website URL.');out.innerHTML='<div class="pp-loading">Building a detailed content refresh plan…</div>';const d=await api('/api/agent/content-refresh',{url});out.innerHTML=renderAi(d,'refresh')},
      dashboardAnalyzeButton:async()=>{
        const out=$('report');
        const url=$('dashboardUrl').value.trim();
        if(!url)throw new Error('Enter a website URL.');
        const d=await api('/api/agent/dashboard',{url});
        out.innerHTML=renderDash(d);
        const c=d.counts||{};
        const set=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
        set('score',d.score==null?'—':`${d.score}/100`);
        set('critical',c.critical??'—'); set('warnings',c.warnings??'—'); set('passed',c.passed??'—');
        if(d.score!=null&&typeof window.updateScoreCircle==='function')window.updateScoreCircle(d.score);
        const f=$('findings');
        if(f)f.innerHTML=`<div class="pp-card"><div class="pp-section-title">Priority findings</div>${actionCards(d.actions||[])}<p class="pp-explain">Each item above is derived from the verified crawl. Open a finding to see what to change, why it matters, and mark it reviewed after implementation.</p></div>`;
      },
      auditAnalyzeButton:async()=>{
        const out=$('auditResults');
        const url=$('auditUrl').value.trim();
        if(!url)throw new Error('Enter a website URL.');
        const d=await api('/api/site-audit',{url});
        out.innerHTML=renderAudit(d,'Site Audit');
        const a=d.audit||{}; const c=a.summary||{};
        const set=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
        set('auditStatus',a.overall_status||'Complete');
        set('auditChecks',c.checked??(a.checks||[]).length);
        set('auditIssues',(c.critical||0)+(c.warnings||0));
        const scoreEl=$('auditScoreValue'); if(scoreEl)scoreEl.textContent=a.score==null?'—':`${a.score}/100`;
      },
      technicalSectionRun:async()=>{if(typeof window.runExtendedUrlCheck==='function')return window.runExtendedUrlCheck('technical');const out=$('technicalContent');const url=$('technicalSectionUrl').value.trim();if(!url)throw new Error('Enter a website URL.');const d=await api('/api/technical-check',{url});out.innerHTML=renderAudit(d,'Technical SEO')},
      onpageSectionRun:async()=>{if(typeof window.runExtendedUrlCheck==='function')return window.runExtendedUrlCheck('onpage');const out=$('onpageContent');const url=$('onpageSectionUrl').value.trim();if(!url)throw new Error('Enter a website URL.');const d=await api('/api/site-audit',{url,section:'onpage'});out.innerHTML=renderAudit(d,'On-Page SEO')},
      indexingSectionRun:async()=>{if(typeof window.runExtendedUrlCheck==='function')return window.runExtendedUrlCheck('indexing');const out=$('indexingContent');const url=$('indexingSectionUrl').value.trim();if(!url)throw new Error('Enter a website URL.');const d=await api('/api/site-audit',{url,section:'indexing'});out.innerHTML=renderAudit(d,'Indexing & Schema')},
      aiStrategyRun:async()=>{const out=$('aiAgentOut');const url=$('aiAgentUrl').value.trim();if(!url)throw new Error('Enter a website URL.');out.innerHTML='<div class="pp-loading">Building the 30-day strategy from verified evidence…</div>';const d=await api('/api/agent/ai-strategy',{url});out.innerHTML=renderAi(d,'strategy')}
    };
    // The canonical section runner lives in index.html and includes request
    // generation protection. Premium buttons delegate to it for the shared
    // URL-based intelligence sections.
    Object.entries(premium).forEach(([id,fn])=>{const b=$(id);if(!b)return;b.addEventListener('click',async e=>{e.preventDefault();e.stopImmediatePropagation();b.disabled=true;const old=b.textContent;b.textContent='Analyzing…';try{await fn()}catch(err){const out=$(id.replace(/Run$|Button$/,'Out'))||b.parentElement?.querySelector('[id$="Out"]');if(out)out.innerHTML=`<div class="pp-error"><b>Analysis could not complete</b><p>${esc(err.message)}</p></div>`}finally{b.disabled=false;b.textContent=old}},true)});
    // GSC importer: preserve local parsing but upgrade the presentation.
    const g=$('agentGscImport');if(g)g.addEventListener('click',e=>{e.preventDefault();e.stopImmediatePropagation();const f=$('agentGscFile').files[0],out=$('agentGscOut');if(!f){out.innerHTML='<div class="pp-error"><b>Select a CSV export first.</b><p>Export the Performance report from Google Search Console and choose the CSV file.</p></div>';return}const r=new FileReader();r.onload=()=>{try{const lines=String(r.result).split(/\r?\n/).filter(Boolean);if(lines.length<2)throw new Error('The CSV contains no data rows.');const parse=l=>{const a=[];let cur='',q=false;for(let i=0;i<l.length;i++){const c=l[i];if(c==='"'&&l[i+1]==='"'){cur+='"';i++;continue}if(c==='"'){q=!q;continue}if(c===','&&!q){a.push(cur);cur='';}else cur+=c}a.push(cur);return a};const h=parse(lines[0]).map(x=>x.trim().toLowerCase()),rows=lines.slice(1).map(parse),ix=(...names)=>names.map(n=>h.indexOf(n)).find(i=>i>=0),ci=ix('clicks'),ii=ix('impressions'),pos=ix('position');let clicks=0,imp=0,positions=[];rows.forEach(a=>{clicks+=Number(String(a[ci]??0).replace(/,/g,''))||0;imp+=Number(String(a[ii]??0).replace(/,/g,''))||0;const p=Number(String(a[pos]??'').replace(',','.'));if(Number.isFinite(p))positions.push(p)});const avg=positions.length?positions.reduce((a,b)=>a+b,0)/positions.length: null;out.innerHTML=renderGsc({clicks,imp,ctr:imp?clicks/imp*100:0,avg,rows:rows.length})}catch(err){out.innerHTML=`<div class="pp-error"><b>GSC file could not be parsed</b><p>${esc(err.message)}</p></div>`}};r.readAsText(f)},true);
    // Add a premium shell to all Pro section scanners even before the first run.
    document.querySelectorAll('#view-agent-dashboard .scanner,#view-rank-history .scanner,#view-action-center .scanner,#view-gsc-gap .scanner,#view-monitoring .scanner,#view-ai-advisor .scanner,#view-projects-reports .scanner').forEach(el=>el.classList.add('pp-input-shell'));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
