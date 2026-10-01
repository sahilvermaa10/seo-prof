/* Pro Studio: one dashboard per tool group, icon rail on the left, every sub-section rendered on one page. */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tok = () => { try { return JSON.parse(localStorage.getItem("seoAgentAuth") || "{}").token || ""; } catch (e) { return ""; } };
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem("ps_" + k) || ""; localStorage.setItem("ps_" + k, v); } catch (e) { return ""; } };
  const HUBS = [
    { id: "audit", ic: "✓", n: "Site Health", t: "Site Health Pro", g: "Intelligence", d: "Audit, evidence & fixes", f: ["url"] },
    { id: "keywords", ic: "⌕", n: "Keywords", t: "Keyword Pro", g: "Intelligence", d: "Demand, gaps & questions", f: ["url", "kw?"] },
    { id: "content", ic: "✎", n: "Content Studio", t: "Content Pro", g: "Intelligence", d: "Briefs, gaps & optimizer", f: ["url", "kw?"] },
    { id: "rankings", ic: "↗", n: "Rankings", t: "Rankings Pro", g: "Market", d: "Live SERP position", f: ["kw", "url?", "cc"] },
    { id: "competitors", ic: "◎", n: "Competitors & Links", t: "Competitor Pro", g: "Market", d: "Rivals, backlinks & links", f: ["url", "kw?", "cc"] },
    { id: "performance", ic: "ϟ", n: "Speed & Trends", t: "Speed & Trends Pro", g: "Market", d: "Web vitals & demand", f: ["url", "kw?"] },
    { id: "ai", ic: "✦", n: "AI Studio", t: "AI Studio Pro", g: "Concierge", d: "Advisor, growth & intel", f: ["url"] },
    { id: "monitoring", ic: "▤", n: "Monitor & Reports", t: "Monitoring Pro", g: "Concierge", d: "Alerts, actions & reports", f: ["url"] },
  ];
  const ZMAP = { health: "audit", keywords: "keywords", content: "content", rankings: "rankings", competitors: "competitors", speed: "performance", ai: "ai", ops: "monitoring" };
  const CC = [["us", "United States"], ["gb", "United Kingdom"], ["in", "India"], ["ca", "Canada"], ["au", "Australia"], ["ae", "UAE"]];
  const st = { hub: "audit", status: null, res: {}, busy: false };

  /* ---------- tiny helpers ---------- */
  const num = v => typeof v === "number" && isFinite(v);
  const fmt = v => v == null || v === "" ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : num(v) ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1)) : Array.isArray(v) ? v.length + " items" : typeof v === "object" ? "…" : String(v);
  const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const pretty = k => String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().replace(/^\w/, c => c.toUpperCase());
  const col = v => v >= 80 ? "#34c47c" : v >= 55 ? "#f2b84b" : "#ef5b5b";
  const chip = (t, k) => `<span class="ps-chip c-${k}">${esc(t)}</span>`;
  const SK = { pass: ["Pass", "ok"], warning: ["Warning", "wn"], fail: ["Critical", "bd"], info: ["Info", "in"] };
  const sChip = s => { const m = SK[String(s).toLowerCase()] || [String(s || "—"), "in"]; return chip(m[0], m[1]); };
  const PK = { critical: "bd", high: "bd", medium: "wn", low: "in" };
  const card = (title, body, span = "s6", sub = "", extra = "") => `<div class="ps-card ${span} ${extra}"><h4>${esc(title)}</h4>${sub ? `<small>${esc(sub)}</small>` : ""}${body}</div>`;
  const ring = (v, label = "") => { const R = 70, C = 2 * Math.PI * R, p = Math.max(0, Math.min(100, v)); return `<div class="ps-ring"><svg viewBox="0 0 170 170" width="100%" height="100%"><circle cx="85" cy="85" r="${R}" fill="none" stroke="#2a323b" stroke-width="14"/><circle cx="85" cy="85" r="${R}" fill="none" stroke="${col(v)}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${p / 100 * C} ${C}"/></svg><b>${Math.round(v)}</b>${label ? `<span>${esc(label)}</span>` : ""}</div>`; };
  function donut(parts, center, sub) {
    const tot = parts.reduce((a, p) => a + p.v, 0) || 1, R = 60, C = 2 * Math.PI * R; let off = 0;
    const segs = parts.filter(p => p.v > 0).map(p => { const l = p.v / tot * C, s = `<circle cx="85" cy="85" r="${R}" fill="none" stroke="${p.c}" stroke-width="22" stroke-dasharray="${l} ${C - l}" stroke-dashoffset="${-off}"/>`; off += l; return s; }).join("");
    return `<div class="ps-ring"><svg viewBox="0 0 170 170" width="100%" height="100%"><circle cx="85" cy="85" r="${R}" fill="none" stroke="#2a323b" stroke-width="22"/>${segs}</svg><b>${esc(center)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}</div><div class="ps-leg">${parts.map(p => `<span><i style="background:${p.c}"></i>${esc(p.l)} ${p.v}</span>`).join("")}</div>`;
  }
  const bars = (rows, max) => { const m = max || Math.max(...rows.map(r => r.v), 1); return `<div class="ps-bars">${rows.map(r => `<div><span title="${esc(r.l)}">${esc(r.l)}</span><div class="ps-pb"><i style="width:${Math.max(2, r.v / m * 100)}%;${r.c ? "background:" + r.c : ""}"></i></div><em>${esc(r.t != null ? r.t : fmt(r.v))}</em></div>`).join("")}</div>`; };
  const kpiT = rows => `<table class="ps-t"><thead><tr><th>Metric</th><th style="text-align:right">Value</th><th style="text-align:right">Status</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r[0])}</td><td class="n">${esc(fmt(r[1]))}</td><td class="n">${r[2] ? chip(r[2][0], r[2][1]) : ""}</td></tr>`).join("")}</tbody></table>`;
  const G = (v, a) => v ? ["Good", "ok"] : a ? ["Review", "wn"] : ["Fix", "bd"];
  const link = v => /^https?:\/\//.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer" style="color:#8dc3ff;text-decoration:none">${esc(trunc(String(v).replace(/^https?:\/\/(www\.)?/, ""), 56))}</a>` : esc(trunc(fmt(v), 160));
  function table(rows, cols, mine) {
    if (!rows.length) return `<p class="ps-note">Nothing to show.</p>`;
    return `<div class="ps-sc"><table class="ps-t"><thead><tr>${cols.map(c => `<th>${esc(c.l)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr class="${mine && mine(r) ? "me" : ""}">${cols.map(c => `<td class="${c.w ? "w" : ""}">${c.h ? c.h(r) : link(r[c.k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const autoCols = rows => { const pref = ["position", "rank", "keyword", "query", "title", "name", "heading", "suggested_heading", "url", "link", "type", "intent", "priority", "confidence", "score", "difficulty", "reason", "why_it_matters", "description"]; const keys = [...new Set(rows.slice(0, 6).flatMap(r => Object.keys(r)))].filter(k => rows.some(r => r[k] != null && typeof r[k] !== "object" && r[k] !== ""));
    keys.sort((a, b) => (pref.indexOf(a) < 0 ? 99 : pref.indexOf(a)) - (pref.indexOf(b) < 0 ? 99 : pref.indexOf(b))); return keys.slice(0, 5).map(k => ({ k, l: pretty(k), w: /reason|why|desc|snippet|detail|fix|summary/i.test(k) })); };
  const findArr = (o, pred, d = 0) => { if (!o || typeof o !== "object" || d > 3) return null; for (const v of Object.values(o)) { if (Array.isArray(v) && v.length && typeof v[0] === "object" && pred(v[0])) return v; } for (const v of Object.values(o)) { const r = Array.isArray(v) ? null : findArr(v, pred, d + 1); if (r) return r; } return null; };
  const list = items => `<ul class="ps-list">${items.map(a => `<li>${a.chip || ""}<b>${esc(a.t)}</b>${a.d ? `<p>${esc(a.d)}</p>` : ""}${a.f ? `<p class="fx">Fix: ${esc(a.f)}</p>` : ""}</li>`).join("")}</ul>`;
  const chips = arr => `<div class="ps-chips">${arr.map(x => `<span>${esc(typeof x === "object" ? x.query || x.question || x.title || x.keyword || JSON.stringify(x) : x)}</span>`).join("")}</div>`;
  const errCard = (name, e) => `<div class="ps-card s12 ps-err"><h4>${esc(name)} couldn't load</h4><p>${esc(e)}</p></div>`;

  /* generic renderer for any endpoint result: scores, key numbers, tables, lists, text */
  function auto(d, name) {
    const o = { sc: [], kp: [], tb: [], ls: [], tx: [] }, seen = new Set();
    (function walk(x, path, dep) { if (!x || typeof x !== "object" || dep > 3 || seen.has(x)) return; seen.add(x);
      for (const [k, v] of Object.entries(x)) { if (["success", "source", "evidence", "checkedAt", "generatedAt", "searchMetadata"].includes(k)) continue;
        if (num(v)) { if (/score|health|rating/i.test(k) && v >= 0 && v <= 100) o.sc.push([pretty(k), v]); else o.kp.push([pretty(path && dep > 0 ? path + " " + k : k), v]); }
        else if (typeof v === "string" && v.length > 30) o.tx.push([pretty(k), v]);
        else if (typeof v === "string" && v && dep <= 1 && !/url|link|country/i.test(k)) o.kp.push([pretty(k), v]);
        else if (Array.isArray(v) && v.length) { if (typeof v[0] === "object" && v[0]) o.tb.push([pretty(k), v]); else o.ls.push([pretty(k), v.slice(0, 20)]); }
        else if (v && typeof v === "object") walk(v, k, dep + 1); } })(d, "", 0);
    let h = "";
    if (o.sc.length) h += card("Scores", `<div class="ps-rings">${o.sc.slice(0, 4).map(([l, v]) => `<div>${ring(v)}<div class="ps-cap">${esc(l)}</div></div>`).join("")}</div>`, "s12");
    if (o.kp.length) h += card(name || "Key numbers", kpiT(o.kp.slice(0, 10).map(([l, v]) => [l, v])), o.tx.length ? "s5" : "s6");
    o.tx.slice(0, 3).forEach(([l, t], i) => h += card(l, `<p class="ps-txt">${esc(t)}</p>`, o.kp.length && i === 0 ? "s7" : "s12"));
    o.tb.slice(0, 4).forEach(([l, r]) => { const c = autoCols(r); if (c.length) h += card(l, table(r.slice(0, 25), c), "s12", r.length + " items"); });
    o.ls.slice(0, 3).forEach(([l, r]) => h += card(l, chips(r), "s12"));
    return h || `<div class="ps-card s12"><p class="ps-note">Completed — no displayable data returned.</p></div>`;
  }

  /* ---------- hub composers: return [{id,label,html}] ---------- */
  const D = (r, id) => r.sections[id]?.ok ? r.sections[id].data : null;
  const E = (r, id, name) => r.sections[id] && !r.sections[id].ok ? errCard(name, r.sections[id].error) : "";
  const sec = (id, label, html) => html ? { id, label, html: `<div class="ps-g">${html}</div>` } : null;
  const allSections = r => Object.entries(r.sections || {}).filter(([,v]) => v);
  const sectionState = r => { const a = allSections(r); return { total:a.length, ok:a.filter(([,v])=>v.ok).length, failed:a.filter(([,v])=>!v.ok).length }; };
  const sectionLabel = id => ({audit:"Site audit",actions:"Action plan",evidence:"Evidence",keywords:"Keyword discovery",opportunity:"Opportunities",gap:"Keyword gaps",brief:"Content brief",optimizer:"Optimizer",rank:"Rank check",top:"SERP results",competitors:"Competitors",backlinks:"Backlinks",internal:"Internal links",speed:"PageSpeed",trends:"Trends",advisor:"AI advisor",growth:"Growth OS",intel:"SEO intelligence",snapshot:"Snapshot",center:"Action center",dash:"Dashboard"}[id] || pretty(id));
  function executive(r, title, blurb, stats, quick=[]) {
    const stt = sectionState(r), ms = r.ms ? `${(r.ms/1000).toFixed(1)}s` : "—";
    const cells = (stats || []).slice(0,4).map(x => `<div class="ps-exec-stat"><span>${esc(x[0])}</span><b>${esc(fmt(x[1]))}</b></div>`).join("");
    const qs = quick.map((x,i)=>`<button type="button" data-exec-jump="${esc(x[0])}">${esc(x[1])}</button>`).join("");
    return `<div class="ps-exec"><div class="eyebrow">PRO INTELLIGENCE · COMBINED VIEW</div><h3>${esc(title)} <span class="ps-fast">parallel + cached</span></h3><p>${esc(blurb)}</p><div class="ps-exec-grid">${cells}<div class="ps-exec-stat"><span>Subsections ready</span><b>${stt.ok}/${stt.total}</b></div><div class="ps-exec-stat"><span>Run time</span><b>${esc(ms)}</b></div></div>${qs?`<div class="ps-quick">${qs}</div>`:""}</div>`;
  }

  function health(r) {
    const a = D(r, "audit"), out = [];
    if (!a) return [sec("ov", "Overview", E(r, "audit", "Site audit"))];
    const au = a.audit || {}, cs = au.checks || [], p = a.seo || {}, n = s => cs.filter(c => c.status === s).length;
    const pass = n("pass"), wn = n("warning"), bd = n("fail"), inf = n("info"), score = num(au.score) ? au.score : 0;
    out.push(sec("summary", "Executive summary", executive(r, "Site Health command view", "One consolidated view of verified crawl health, actions and evidence. Pro runs its sub-checks in parallel and reuses a short-lived result cache for repeat runs.", [["Health score",score], ["Critical",bd], ["Warnings",wn], ["Verified checks",cs.length]], [["act","Priority actions"],["ev","Crawl evidence"]])));
    const cats = {}; cs.forEach(c => (cats[c.category || "General"] = cats[c.category || "General"] || []).push(c));
    const catRows = Object.entries(cats).map(([k, v]) => { const sc = v.filter(c => c.status !== "info"), pr = sc.length ? sc.filter(c => c.status === "pass").length / sc.length * 100 : 100; return { l: k, v: pr, t: Math.round(pr) + "%", c: col(pr) }; });
    const facts = [["HTTP status", p.status_code, G(p.status_code >= 200 && p.status_code < 300, p.status_code < 400)], ["Title length", p.title_length, G(p.title_length >= 30 && p.title_length <= 60, p.title_length > 0)], ["Meta description length", p.meta_description_length, G(p.meta_description_length >= 70 && p.meta_description_length <= 170, p.meta_description_length > 0)],
      ["H1 headings", p.h1_count, G(p.h1_count === 1, p.h1_count > 1)], ["H2 headings", p.h2_count, G(p.h2_count > 0, true)], ["Visible words", p.word_count, G(p.word_count >= 300, p.word_count >= 150)], ["Internal links", p.internal_links, G(p.internal_links > 0, false)],
      ["Images missing alt", (p.images_without_alt ?? 0) + " of " + (p.image_count ?? 0), G((p.images_without_alt || 0) === 0, (p.images_without_alt || 0) < 4)], ["Redirects", p.redirect_count, G(p.redirect_count <= 1, p.redirect_count <= 3)], ["Schema blocks", p.schema_blocks, G(p.schema_blocks > 0, true)]].filter(f => f[1] != null);
    out.push(sec("ov", "Overview", card("Health score", ring(score, au.overall_status || ""), "s3", `${cs.length} verified checks`) +
      card("Audit overview", kpiT([["Checks run", cs.length], ["Passed", pass, pass ? ["Good", "ok"] : null], ["Warnings", wn, wn ? ["Review", "wn"] : ["Clear", "ok"]], ["Critical", bd, bd ? ["Fix", "bd"] : ["Clear", "ok"]], ["Info notes", inf]]), "s5", "Last live crawl") +
      card("Check results", donut([{ l: "Passed", v: pass, c: "#34c47c" }, { l: "Warnings", v: wn, c: "#f2b84b" }, { l: "Critical", v: bd, c: "#ef5b5b" }, { l: "Info", v: inf, c: "#5aa9ff" }], cs.length, "Total"), "s4") +
      card("Health by category", bars(catRows, 100), "s6", "Share of checks passing") + card("Page facts", kpiT(facts), "s6", "Measured on the page") + E(r, "audit", "Site audit")));
    const ORDER = ["Technical", "On-page", "Content", "Indexability", "Schema", "Accessibility"];
    Object.keys(cats).sort((x, y) => (ORDER.indexOf(x) < 0 ? 9 : ORDER.indexOf(x)) - (ORDER.indexOf(y) < 0 ? 9 : ORDER.indexOf(y))).forEach(k => {
      const v = cats[k], b = v.filter(c => c.status === "fail").length, w = v.filter(c => c.status === "warning").length;
      out.push(sec("c-" + k, k, card(k + " checks", table(v.slice().sort((x, y) => ["fail", "warning", "info", "pass"].indexOf(x.status) - ["fail", "warning", "info", "pass"].indexOf(y.status)), [{ l: "Status", h: c => sChip(c.status) }, { l: "Check", h: c => `<b>${esc(c.name || c.label)}</b>` }, { l: "Evidence", w: 1, h: c => esc(trunc(c.details || c.evidence || "", 200)) }, { l: "How to fix", w: 1, h: c => c.status === "pass" ? "—" : esc(c.recommended_fix || "") }]), "s12", `${v.length} checks · ${b} critical · ${w} warnings`)));
    });
    const acts = findArr(D(r, "actions"), x => "priority" in x || "recommended_fix" in x);
    if (acts) out.push(sec("act", "Priority actions", card("Prioritised action plan", list(acts.slice(0, 12).map(x => ({ chip: chip(x.priority || "task", PK[String(x.priority).toLowerCase()] || "in"), t: x.title || x.name, d: x.description || x.why, f: x.recommended_fix }))), "s12", `${acts.length} recommended actions`)));
    else if (r.sections.actions) out.push(sec("act", "Priority actions", E(r, "actions", "Priority actions")));
    const ev = D(r, "evidence"), ec = ev?.checks;
    if (ec?.length) out.push(sec("ev", "Crawl evidence", card("Robots, sitemap & transport", table(ec, [{ l: "Status", h: c => sChip(c.status) }, { l: "Check", h: c => `<b>${esc(c.name || c.label || c.check)}</b>` }, { l: "Details", w: 1, h: c => esc(trunc(c.details || c.evidence || c.value || "", 220)) }]), "s12", "Verified " + (ev.fetchedAt ? new Date(ev.fetchedAt).toLocaleString() : ""))));
    else if (r.sections.evidence && !r.sections.evidence.ok) out.push(sec("ev", "Crawl evidence", E(r, "evidence", "Crawl evidence")));
    return out;
  }
  function keywords(r) {
    const k = D(r, "keywords"), o = [];
    const seedSummary = k ? (k.keywords || []).length : 0;
    o.push(sec("summary", "Executive summary", executive(r, "Keyword intelligence command view", "Combines discovery, opportunities and keyword-gap evidence so users can move from demand signals to page-level actions without opening separate tools.", [["Candidates",seedSummary], ["Opportunity data",D(r,"opportunity")?"Ready":"—"], ["Gap analysis",D(r,"gap")?"Ready":"—"], ["Country",r.input?.country || "us"]], [["o","Opportunities"],["g","Keyword gaps"]])));
    if (k) { const rows = k.keywords || []; o.push(sec("k", "Keywords", card("Keyword ideas", table(rows, autoCols(rows)), "s12", `Seed: ${k.seed || "auto"} · ${rows.length} candidates`) + (k.volume?.note ? `<p class="ps-note s12" style="grid-column:span 12">${esc(k.volume.note)}</p>` : "")));
      const rel = k.relatedSearches || [], paa = k.peopleAlsoAsk || [];
      if (rel.length || paa.length) o.push(sec("q", "Related & questions", (rel.length ? card("Related searches", chips(rel), "s6") : "") + (paa.length ? card("People also ask", list(paa.slice(0, 8).map(x => ({ t: x.question || x.title || String(x) }))), "s6") : ""))); }
    else o.push(sec("k", "Keywords", E(r, "keywords", "Keywords")));
    if (r.sections.opportunity) o.push(sec("o", "Opportunities", D(r, "opportunity") ? auto(D(r, "opportunity"), "Opportunity numbers") : E(r, "opportunity", "Keyword opportunities")));
    if (r.sections.gap) o.push(sec("g", "Keyword gaps", D(r, "gap") ? auto(D(r, "gap"), "Gap numbers") : E(r, "gap", "Keyword gaps")));
    return o;
  }
  function content(r) {
    const o = [], g = D(r, "gap")?.gapAnalysis;
    o.push(sec("summary", "Executive summary", executive(r, "Content strategy command view", "Combines topical gaps, content briefing and optimizer evidence into one implementation-oriented content workspace.", [["Gap items",g?.gaps?.length || 0], ["Brief",D(r,"brief")?"Ready":"—"], ["Optimizer",D(r,"optimizer")?"Ready":"—"], ["Input",r.input?.url || "—"]], [["g","Content gaps"],["b","Content brief"],["o","Optimizer"]])));
    if (g) { const gaps = g.gaps || []; o.push(sec("g", "Content gaps", card("Coverage", `<p class="ps-txt">${esc(g.coverage_summary || "")}</p>`, "s5", g.page_topic || "") + card("Depth", kpiT([["Visible words", g.evidence?.wordCount, G(g.evidence?.wordCount >= 300, true)], ["H1 headings", (g.evidence?.h1 || []).length], ["H2 sections", (g.evidence?.h2 || []).length], ["H3 sections", (g.evidence?.h3 || []).length], ["Gaps found", gaps.length, gaps.length ? ["Review", "wn"] : ["Clear", "ok"]]]), "s7") + card("Missing topics & sections", table(gaps, autoCols(gaps)), "s12", gaps.length + " opportunities"))); }
    else o.push(sec("g", "Content gaps", E(r, "gap", "Content gap analysis")));
    const b = D(r, "brief")?.contentBrief; if (b) o.push(sec("b", "Content brief", auto(b, "Brief details"))); else if (r.sections.brief) o.push(sec("b", "Content brief", E(r, "brief", "Content brief")));
    if (r.sections.optimizer) o.push(sec("o", "Optimizer", D(r, "optimizer") ? auto(D(r, "optimizer"), "Optimizer numbers") : E(r, "optimizer", "Content optimizer")));
    return o;
  }
  function rankings(r) {
    const d = D(r, "rank"), t = D(r, "top"), o = [];
    o.push(sec("summary", "Executive summary", executive(r, "SERP intelligence command view", "Combines exact-page ranking evidence, live SERP results and search-question signals in one view. Ranking position is reported only from the returned SERP evidence.", [["Keyword",r.input?.keyword || "—"], ["Exact position",d?.position ?? "—"], ["Results scanned",d?.scannedResults ?? t?.results?.length ?? "—"], ["Country",r.input?.country || "us"]], [["p","Your position"],["t","Top results"],["q","Questions"]])));
    const host = (r.input.url || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0].toLowerCase(), mine = x => host && String(x.link || x.url || "").toLowerCase().includes(host);
    const rowsOf = x => (x.topResults || x.results || []);
    const cols = [{ l: "#", h: x => `<b>${esc(x.position)}</b>` }, { l: "Page", h: x => `<b>${esc(trunc(x.title || "", 70))}</b><br>${link(x.link || x.url)}` }, { l: "Snippet", w: 1, h: x => esc(trunc(x.snippet || "", 150)) }];
    if (d) { const pos = d.position || d.domainPosition, ev = d.rankEvidence || {};
      o.push(sec("p", "Your position", card("Google position", `<div class="ps-big">${pos ? "#" + pos : "—"}<br><small>${pos ? (d.ranked ? "exact page ranks" : "domain ranks (different page)") : "not in the top " + (d.scannedResults || 100)}</small></div>` + (pos ? bars([{ l: "Position of 100", v: 101 - pos, t: "#" + pos }], 100) : ""), "s4", d.keyword) +
        card("Ranking evidence", kpiT([["Keyword", d.keyword], ["Country", d.country?.name || d.country], ["Results scanned", d.scannedResults], ["Exact page position", d.position ?? "—", d.ranked ? ["Ranked", "ok"] : ["No", "bd"]], ["Domain position", d.domainPosition ?? "—"], ["Match type", ev.matchType]]), "s8", "Live Google SERP")));
      o.push(sec("t", "Top 10", card("Top ranking pages", table(rowsOf(d), cols, mine), "s12", "Your domain is highlighted"))); }
    else if (t) o.push(sec("t", "Top 10", card("Top ranking pages", table(rowsOf(t), cols), "s12", `Live Google · ${t.keyword}`)));
    else o.push(sec("p", "Your position", E(r, "rank", "Rank check") + E(r, "top", "Top rankings")));
    const src = d || t; if (src) { const rel = src.relatedSearches || [], paa = src.peopleAlsoAsk || [];
      if (rel.length || paa.length) o.push(sec("q", "Related & questions", (rel.length ? card("Related searches", chips(rel), "s6") : "") + (paa.length ? card("People also ask", list(paa.slice(0, 8).map(x => ({ t: x.question || String(x) }))), "s6") : ""))); }
    return o;
  }
  function competitors(r) {
    const o = [], ca = D(r, "competitors")?.competitorAnalysis;
    o.push(sec("summary", "Executive summary", executive(r, "Competitive intelligence command view", "Combines SERP competitor evidence, backlink opportunities and internal-link opportunities so the user can see the competitive context and the site-side actions together.", [["Competitors",ca?.competitors?.length || 0], ["Backlink data",D(r,"backlinks")?"Ready":"—"], ["Internal links",D(r,"internal")?"Ready":"—"], ["Keyword",ca?.primary_keyword || r.input?.keyword || "—"]], [["c","Competitors"],["b","Backlinks"],["i","Internal links"]])));
    if (ca) { const cp = (ca.competitors || []).filter(c => c.pageMetrics), tg = ca.target_overview || {};
      const rows = [{ l: "You", v: tg.wordCount || 0, c: "#5aa9ff" }, ...cp.slice(0, 8).map(c => ({ l: "#" + c.position + " " + String(c.url).replace(/^https?:\/\/(www\.)?/, "").split("/")[0], v: c.pageMetrics.wordCount || 0 }))];
      o.push(sec("c", "Competitors", card("Your page", kpiT([["Keyword", ca.primary_keyword], ["Words", tg.wordCount], ["H2 sections", tg.h2Count], ["Schema blocks", tg.schemaBlocks]]), "s4") + card("Content depth vs competitors", bars(rows), "s8", "Visible words per page") +
        card("Who ranks above you", table(cp.length ? cp : ca.competitors || [], [{ l: "#", h: c => `<b>${esc(c.position)}</b>` }, { l: "Competitor", h: c => `<b>${esc(trunc(c.title || c.name || "", 60))}</b><br>${link(c.url)}` }, { l: "Words", h: c => fmt(c.pageMetrics?.wordCount) }, { l: "H2", h: c => fmt(c.pageMetrics?.h2Count) }, { l: "Schema", h: c => fmt(c.pageMetrics?.schemaBlocks) }, { l: "Links", h: c => fmt(c.pageMetrics?.internalLinks) }, { l: "Gap vs you", w: 1, h: c => esc(trunc(c.gaps || "", 170)) }]), "s12", `${(ca.competitors || []).length} SERP competitors`) +
        (ca.recommendations?.length ? card("Recommendations", list(ca.recommendations.map(t => ({ t }))), "s12") : ""))); }
    else o.push(sec("c", "Competitors", E(r, "competitors", "Competitor analysis")));
    const b = D(r, "backlinks"); o.push(sec("b", "Backlinks", b ? card("Link-building opportunities", table(b.opportunities || [], autoCols(b.opportunities || [])), "s12") : E(r, "backlinks", "Backlink opportunities")));
    const i = D(r, "internal"); o.push(sec("i", "Internal links", i ? auto(i, "Internal link numbers") : E(r, "internal", "Internal link opportunities")));
    return o;
  }
  function speed(r) {
    const o = [], s = D(r, "speed");
    const sc0 = s?.scores || {};
    o.push(sec("summary", "Executive summary", executive(r, "Performance command view", "Combines PageSpeed evidence with search-demand trend data when a keyword is supplied. Slow provider calls are isolated so the interface can still render the rest of the workspace.", [["Performance",num(sc0.performance)?Math.round(sc0.performance*100):"—"], ["SEO",num(sc0.seo)?Math.round(sc0.seo*100):"—"], ["Accessibility",num(sc0.accessibility)?Math.round(sc0.accessibility*100):"—"], ["Trends",D(r,"trends")?"Ready":"—"]], [["s","Core scores"],["a","Fix list"],["t","Trends"]])));
    if (s) { const sc = s.scores || {}, L = { performance: "Performance", accessibility: "Accessibility", bestPractices: "Best practices", seo: "SEO" };
      o.push(sec("s", "Core scores", card("Lighthouse scores", `<div class="ps-rings">${Object.entries(L).filter(([k]) => num(sc[k])).map(([k, l]) => `<div>${ring(sc[k])}<div class="ps-cap">${l}</div></div>`).join("")}</div>`, "s12", "Mobile · Google PageSpeed Insights")));
      const aud = []; Object.entries(s.details || {}).forEach(([cat, d]) => Object.values(d.audits || {}).forEach(a => { if (num(a.score) && a.score < 0.9) aud.push({ cat, t: a.title, s: Math.round(a.score * 100) }); }));
      aud.sort((a, b) => a.s - b.s); o.push(sec("a", "Fix list", card("Audits to improve", table(aud.slice(0, 20), [{ l: "Area", h: a => pretty(a.cat) }, { l: "Audit", h: a => `<b>${esc(a.t)}</b>` }, { l: "Score", h: a => chip(a.s, a.s >= 50 ? "wn" : "bd") }]), "s12", aud.length + " audits below 90"))); }
    else o.push(sec("s", "Core scores", E(r, "speed", "PageSpeed")));
    const t = D(r, "trends");
    if (t) { const tl = (t.timeline || t.trend || []).filter(x => num(x.value)), vals = tl.map(x => x.value), rel = t.related || {};
      let h = ""; if (tl.length) { const W = 600, H = 170, mx = Math.max(...vals, 1), pts = vals.map((v, i) => [10 + i / Math.max(1, vals.length - 1) * (W - 20), H - 12 - v / mx * (H - 30)]), d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
        h += card("Search interest, 12 months", `<svg viewBox="0 0 ${W} ${H}" width="100%"><defs><linearGradient id="psg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ee5a8a" stop-opacity=".45"/><stop offset="1" stop-color="#ee5a8a" stop-opacity="0"/></linearGradient></defs><path d="${d} L${W - 10} ${H - 12} L10 ${H - 12}Z" fill="url(#psg)"/><path d="${d}" fill="none" stroke="#ee5a8a" stroke-width="2.5"/></svg><div class="ps-cap" style="display:flex;justify-content:space-between"><span>${esc(tl[0].date)}</span><span>${esc(tl[tl.length - 1].date)}</span></div>`, "s8", r.input.keyword) +
          card("Demand", kpiT([["Latest", vals[vals.length - 1]], ["Peak", Math.max(...vals)], ["Average", Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)], ["Low", Math.min(...vals)]]), "s4"); }
      if ((rel.rising || []).length) h += card("Rising queries", table(rel.rising, [{ l: "Query", k: "query" }, { l: "Growth", k: "value" }]), "s6");
      if ((rel.top || []).length) h += card("Top queries", table(rel.top, [{ l: "Query", k: "query" }, { l: "Interest", k: "value" }]), "s6");
      o.push(sec("t", "Trends", h || auto(t, "Trend numbers"))); }
    else if (r.sections.trends) o.push(sec("t", "Trends", E(r, "trends", "Trends")));
    return o;
  }
  function ai(r) {
    const o=[sec("summary", "Executive summary", executive(r, "AI strategy command view", "Three grounded AI layers are combined here: diagnosis, growth execution and SEO intelligence. AI output is presented as decision support based on the supplied evidence, not as a ranking guarantee.", [["Advisor",D(r,"advisor")?"Ready":"—"],["Growth OS",D(r,"growth")?"Ready":"—"],["SEO intelligence",D(r,"intel")?"Ready":"—"],["Source", "Verified page evidence"]], [["advisor","Advisor"],["growth","Growth plan"],["intel","Intelligence"]]))];
    return o.concat([["advisor", "Advisor", "AI advisor"], ["growth", "Growth plan", "Growth OS"], ["intel", "Intelligence", "SEO intelligence"]].map(([id, l, n]) => sec(id, l, D(r, id) ? auto(D(r, id), n) : E(r, id, n))));
  }
  function monitoring(r) {
    const o = [], s = D(r, "snapshot")?.snapshot;
    o.push(sec("summary", "Executive summary", executive(r, "Monitoring command view", "Combines the latest snapshot, action center and dashboard signals so monitoring is more than a single score: it becomes a persistent change-and-action workspace.", [["Current score",s?.score ?? "—"], ["Critical",s?.critical ?? "—"], ["Warnings",s?.warnings ?? "—"], ["Action center",D(r,"center")?"Ready":"—"]], [["s","Snapshot"],["c","All checks"],["a","Action center"]])));
    if (s) { const chk = s.technicalChecks || [];
      o.push(sec("s", "Snapshot", card("Snapshot score", ring(s.score || 0), "s3", s.url) + card("This crawl", kpiT([["Critical issues", s.critical, s.critical ? ["Fix", "bd"] : ["Clear", "ok"]], ["Warnings", s.warnings, s.warnings ? ["Review", "wn"] : ["Clear", "ok"]], ["Words", s.wordCount], ["Title", trunc(s.title || "—", 50)]]), "s5", s.checkedAt ? new Date(s.checkedAt).toLocaleString() : "") +
        card("Checks", donut([{ l: "Pass", v: chk.filter(c => c.status === "pass").length, c: "#34c47c" }, { l: "Warn", v: chk.filter(c => c.status === "warning").length, c: "#f2b84b" }, { l: "Fail", v: chk.filter(c => c.status === "fail").length, c: "#ef5b5b" }, { l: "Info", v: chk.filter(c => c.status === "info").length, c: "#5aa9ff" }], chk.length, "Total"), "s4")));
      o.push(sec("c", "All checks", card("Technical checks", table(chk, [{ l: "Status", h: c => sChip(c.status) }, { l: "Check", h: c => `<b>${esc(c.name || c.label)}</b>` }, { l: "Evidence", w: 1, h: c => esc(trunc(c.details || c.evidence || "", 200)) }]), "s12"))); }
    else o.push(sec("s", "Snapshot", E(r, "snapshot", "Monitoring snapshot")));
    o.push(sec("a", "Action center", D(r, "center") ? auto(D(r, "center"), "Action numbers") : E(r, "center", "Action center")));
    o.push(sec("d", "Pro dashboard", D(r, "dash") ? auto(D(r, "dash"), "Dashboard numbers") : E(r, "dash", "Pro dashboard")));
    return o;
  }
  const COMP = { audit: health, keywords, content, rankings, competitors, performance: speed, ai, monitoring };

  /* ---------- shell ---------- */
  let root;
  function syncTheme(){ if(!root) return; const light = document.documentElement.dataset.theme === "light"; root.classList.toggle("ps-light", light); const mo = root.querySelector(".ps-theme .mo"); if (mo) mo.textContent = light ? "☀" : "☾"; }
  function shell() {
    if (root) return; root = document.createElement("div"); root.className = "ps"; root.hidden = true; syncTheme();
    const navHtml = (() => { let last = "", out = ""; HUBS.forEach(h => { if (h.g !== last) { out += `<div class="ps-grp">${esc(h.g)}</div>`; last = h.g; } out += `<button class="ps-ic" data-h="${h.id}" data-l="${esc(h.n)}" type="button"><span class="ic">${h.ic}</span><span class="tx"><b>${esc(h.n)}</b><small>${esc(h.d)}</small></span><i></i></button>`; }); return out; })();
    root.innerHTML = `<aside class="ps-rail"><div class="ps-brand"><div class="ps-logo">♛</div><div class="ps-brand-tx"><b>ZYPP</b><small>Private Suite</small></div><button class="ps-fold" type="button" title="Collapse / expand sidebar" aria-label="Collapse sidebar">‹</button></div><nav class="ps-navlist">${navHtml}</nav><div class="ps-sp"></div><div class="ps-member"><span class="ps-crest">♛</span><div><b>Pro Member</b><small id="psMemSub">Private access</small></div></div><button class="ps-x" type="button" title="Close (Esc)"><span class="ic">←</span><span class="tx">Back to workspace</span></button></aside>
      <div class="ps-col"><header class="ps-top"><div class="ps-ttl"><small>PRIVATE SUITE</small><h2></h2></div><div class="ps-form"></div><div class="ps-q"></div><button class="ps-theme" type="button" title="Switch light / dark" aria-label="Switch light or dark mode"><span class="mo">☾</span></button></header><nav class="ps-nav"></nav><main class="ps-main"></main></div>`;
    if (ls("mini") === "1") root.classList.add("ps-mini");
    document.body.appendChild(root);
    root.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
      if (b.classList.contains("ps-fold")) { root.classList.toggle("ps-mini"); ls("mini", root.classList.contains("ps-mini") ? "1" : "0"); } else if (b.classList.contains("ps-theme")) { document.getElementById("themeToggle")?.click(); setTimeout(syncTheme, 60); } else if (b.classList.contains("ps-x")) close(); else if (b.dataset.h) pick(b.dataset.h); else if (b.classList.contains("ps-run")) run(); else if (b.dataset.jump) { $$(".ps-nav button").forEach(x=>x.classList.toggle("active", x===b)); $("#psx-" + b.dataset.jump, root)?.scrollIntoView({ block: "start" }); } else if (b.dataset.execJump) { $("#psx-" + b.dataset.execJump, root)?.scrollIntoView({ block: "start" }); $$(".ps-nav button").forEach(x=>x.classList.toggle("active", x.dataset.jump===b.dataset.execJump)); } else if (b.classList.contains("ps-up")) { close(); document.getElementById("zUp")?.click(); } });
    root.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("input")) run(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !root.hidden) close(); });
  }
  const hubOf = () => HUBS.find(h => h.id === st.hub);
  function form() {
    const h = hubOf(), f = h.f, one = k => f.find(x => x.replace("?", "") === k), opt = k => f.includes(k + "?");
    $(".ps-ttl h2", root).textContent = h.t;
    $(".ps-form", root).innerHTML = (one("url") ? `<input aria-label="Website URL" class="ps-in-url" data-k="url" placeholder="https://your-website.com${opt("url") ? " (optional)" : ""}" value="${esc(ls("url") || localStorage.getItem("zaUrl") || "")}">` : "") +
      (one("kw") ? `<input aria-label="Keyword" class="ps-in-kw" data-k="kw" placeholder="Keyword${opt("kw") ? " (optional)" : ""}" value="${esc(ls("kw"))}">` : "") +
      (one("cc") ? `<select data-k="cc">${CC.map(([c, n]) => `<option value="${c}" ${ls("cc") === c ? "selected" : ""}>${n}</option>`).join("")}</select>` : "") + `<button class="ps-run" type="button">Run ${esc(h.n)} →</button>`;
    $$(".ps-form [data-k]").forEach(i => i.addEventListener("input", () => ls(i.dataset.k, i.value.trim())));
  }
  const $$ = (s) => [...root.querySelectorAll(s)];
  function quota() {
    const s = st.status, q = $(".ps-q", root); if (!s) { q.textContent = ""; return; }
    const left = s.hubs?.[st.hub]?.left; q.innerHTML = s.unlimited ? `<b>♛ Unlimited</b> Pro runs` : `<b>${left}</b> of ${s.limit} Pro runs left here`;
    const ms = $("#psMemSub", root); if (ms) ms.textContent = s.unlimited ? "Unlimited Pro runs" : `${left} runs left in this suite`;
    $$(".ps-ic").forEach(b => { const l = s.hubs?.[b.dataset.h]?.left, i = $("i", b); i.textContent = s.unlimited ? "∞" : l; i.className = !s.unlimited && l === 0 ? "z" : ""; });
  }
  async function loadStatus() { try { const r = await fetch("/api/pro/status", { headers: { Authorization: "Bearer " + tok() } }); if (r.ok) { st.status = await r.json(); quota(); } } catch (e) {} }
  function empty() { const h = hubOf(); $(".ps-nav", root).innerHTML = ""; $(".ps-main", root).innerHTML = `<div class="ps-empty"><div><div class="cr">♛</div><h3>${esc(h.t)}</h3><p>Run it once to see every part of ${esc(h.n)} in depth on this page.</p></div></div>`; }
  function show() { const r = st.res[st.hub]; if (!r) return empty(); const secs = (COMP[st.hub](r) || []).filter(Boolean);
    $(".ps-nav", root).innerHTML = secs.length > 1 ? secs.map((s,i) => `<button class="${i===0?"active":""}" data-jump="${s.id}" type="button">${esc(s.label)}</button>`).join("") : "";
    $(".ps-main", root).innerHTML = secs.map(s => `<section class="ps-sec" id="psx-${s.id}"><h3>${esc(s.label)}</h3>${s.html}</section>`).join("") + `<p class="ps-note">Live data · ${r.ms ? (r.ms / 1000).toFixed(1) + "s" : ""}</p>`; $(".ps-main", root).scrollTop = 0; }
  function pick(id) { st.hub = id; $$(".ps-ic").forEach(b => b.classList.toggle("on", b.dataset.h === id)); form(); quota(); st.busy ? 0 : show(); }
  const RUN_CACHE = new Map();
  const RUN_CACHE_TTL = 45000;
  function cacheKey(body){ return JSON.stringify([body.hub, body.url, body.keyword, body.country]); }
  function cachedRun(body){ const x=RUN_CACHE.get(cacheKey(body)); return x && Date.now()-x.at<RUN_CACHE_TTL ? x.data : null; }
  function saveRun(body,data){ RUN_CACHE.set(cacheKey(body),{at:Date.now(),data}); }
  async function run() {
    if (st.busy) return; const h = hubOf(), v = k => ($(`.ps-form [data-k="${k}"]`, root)?.value || "").trim(), main = $(".ps-main", root);
    if (!tok()) { main.innerHTML = `<div class="ps-empty"><div><h3>Please sign in</h3><p>Your Pro workspace needs an active session.</p></div></div>`; return; }
    const body = { hub: h.id, url: v("url"), keyword: v("kw"), country: v("cc") || "us" }; if (v("url")) localStorage.setItem("zaUrl", v("url"));
    const hit = cachedRun(body);
    if (hit) { st.res[h.id] = hit; show(); return; }
    st.busy = true; const btn = $(".ps-run", root); btn.disabled = true; btn.textContent = "Analysing…";
    main.innerHTML = `<div class="ps-load"><div><i></i></div><div><b>Building your Pro command view…</b><br><small>Parallel checks are running. The shell stays interactive and the result is cached briefly for instant repeat views.</small></div></div>`; $(".ps-nav", root).innerHTML = "";
    try {
      const r = await fetch("/api/pro/run", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok() }, body: JSON.stringify(body) }), d = await r.json().catch(() => ({}));
      if (r.status === 402) main.innerHTML = `<div class="ps-empty"><div><div class="cr">🔒</div><h3>Pro runs used up</h3><p>${esc(d.error || "")}</p><button class="ps-up" type="button">See plans</button></div></div>`;
      else if (!r.ok || !d.success) main.innerHTML = `<div class="ps-empty"><div><h3>Couldn't run</h3><p>${esc(d.error || "Request failed (" + r.status + ")")}</p></div></div>`;
      else { saveRun(body,d); st.res[h.id] = d; if (st.hub === h.id) show(); }
    } catch (e) { main.innerHTML = `<div class="ps-empty"><div><h3>Network error</h3><p>${esc(e.message || "Check that the server is running, then try again.")}</p></div></div>`; }
    finally { st.busy = false; if(btn){btn.disabled = false; btn.textContent = `Run ${h.n} →`;} loadStatus(); }
  }
  function open(hubId) { shell(); syncTheme(); root.hidden = false; document.body.style.overflow = "hidden"; pick(HUBS.some(h => h.id === hubId) ? hubId : st.hub); loadStatus(); }
  function close() { root.hidden = true; document.body.style.overflow = ""; }
  window.ProStudio = { open, close, _compose: (h, r) => COMP[h](r) };

  /* entry points: a sidebar button and a "♛ Pro" chip on every section's tab bar */
  function hook() {
    const z = $(".zs"); if (z && !$(".ps-side")) { const b = document.createElement("button"); b.type = "button"; b.className = "ps-side"; b.innerHTML = "<span>♛</span><span>Pro Private Suite</span>"; b.onclick = () => open(ZMAP[$(".zs-item.on")?.dataset.hub] || st.hub); z.prepend(b); }
    const t = $("#zTabs"); if (t && t.children.length && !t.querySelector(".ps-open")) { const b = document.createElement("button"); b.type = "button"; b.className = "ps-open"; b.textContent = "♛ Pro"; b.onclick = () => open(ZMAP[$(".zs-item.on")?.dataset.hub]); t.appendChild(b); }
  }
  new MutationObserver(syncTheme).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
  setInterval(hook, 900);
})();
