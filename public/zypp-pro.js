/* SEO Zypp Pro layer: auto-graphics for every API answer, per-section Pro Deep-Dives, Pro Command Center */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tok = () => { try { return JSON.parse(localStorage.getItem("seoAgentAuth") || "{}").token || ""; } catch (e) { return ""; } };
  const col = v => v >= 80 ? "#34d399" : v >= 55 ? "#fbbf24" : "#f43f5e";
  const nice = k => String(k).replace(/_/g, " ").replace(/\bscore\b/i, "").trim() || "Overall";
  const len = v => Array.isArray(v) ? v.length : (typeof v === "number" ? v : null);

  /* ---------- extract graphic-worthy facts from any response ---------- */
  function extract(d) {
    const out = { scores: [], dist: null, bars: [], kpis: [], fixes: [] }, seen = new Set();
    (function walk(o, path, depth) {
      if (!o || typeof o !== "object" || depth > 3 || seen.has(o)) return; seen.add(o);
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "number" && /score|health|rating/i.test(k) && v >= 0 && v <= 100) out.scores.push({ label: nice(path ? path + " " + k : k), v: Math.round(v) });
        else if (typeof v === "number" && depth === 0 && isFinite(v) && !/^(status|code)$/i.test(k)) out.kpis.push({ label: k.replace(/_/g, " "), v });
        else if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0]) {
          const lab = ["keyword", "title", "name", "url", "page", "domain", "query", "check", "category"].find(x => typeof v[0][x] === "string");
          const num = ["volume", "position", "rank", "clicks", "impressions", "words", "count", "score", "difficulty", "weight", "authority"].find(x => typeof v[0][x] === "number");
          if (lab && num && out.bars.length < 2) out.bars.push({ title: k.replace(/_/g, " ") + " · " + num, rows: v.slice(0, 8).map(r => ({ l: String(r[lab]).replace(/^https?:\/\//, ""), n: Number(r[num]) || 0 })) });
          const sev = ["severity", "priority", "status", "impact", "level"].find(x => typeof v[0][x] === "string");
          if (sev && !out.dist) { const c = {}; v.forEach(r => { const s = String(r[sev]).toLowerCase(); c[s] = (c[s] || 0) + 1; }); out.dist = { title: k.replace(/_/g, " "), c }; }
          if (/action|fix|recommend|issue|opportunit|task/i.test(k)) v.slice(0, 5).forEach(r => { const t = r.title || r.name || r.issue || r.action || r.check; if (t) out.fixes.push({ t: String(t), p: String(r.priority || r.severity || r.impact || "").toLowerCase(), d: String(r.what_to_do || r.description || r.detail || r.recommendation || r.fix || "") }); });
        } else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, k, depth + 1);
      }
    })(d, "", 0);
    const c = {}; ["critical", "high", "warnings", "medium", "passed", "low"].forEach(k => { const n = len(d[k]); if (n != null) c[k] = n; });
    if (d.counts && typeof d.counts === "object") Object.entries(d.counts).forEach(([k, v]) => { if (typeof v === "number") c[k] = v; });
    if (Object.keys(c).length > 1) out.dist = { title: "issue breakdown", c };
    const u = new Set(); out.scores = out.scores.filter(s => !u.has(s.label) && u.add(s.label)).slice(0, 4);
    out.kpis = out.kpis.filter(k => !/^(score)$/.test(k.label)).slice(0, 4);
    return out;
  }
  const DCOL = { critical: "#f43f5e", high: "#fb7185", error: "#f43f5e", fail: "#f43f5e", failed: "#f43f5e", warnings: "#fbbf24", warning: "#fbbf24", warn: "#fbbf24", medium: "#fbbf24", passed: "#34d399", pass: "#34d399", ok: "#34d399", good: "#34d399", low: "#22d3ee", info: "#22d3ee" };
  const ring = (v, c) => `<span class="rw"><svg class="ring" viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="50"/><circle class="fg" data-v="${v}" cx="60" cy="60" r="50" stroke="${c}"/></svg><b>${v}</b></span>`;
  function donut(c) {
    const ent = Object.entries(c).filter(([, n]) => n > 0), tot = ent.reduce((a, [, n]) => a + n, 0) || 1; let off = 0; const R = 50, C = 2 * Math.PI * R;
    const segs = ent.map(([k, n], i) => { const len = n / tot * C, s = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${DCOL[k] || ["#8b5cf6", "#ec4899", "#22d3ee", "#f59e0b"][i % 4]}" stroke-width="16" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}"/>`; off += len; return s; }).join("");
    return `<svg viewBox="0 0 120 120" width="130" height="130" style="transform:rotate(-90deg)"><circle cx="60" cy="60" r="${R}" fill="none" stroke="rgba(139,92,246,.14)" stroke-width="16"/>${segs}</svg><div class="zg-leg">${ent.map(([k, n], i) => `<span><i style="background:${DCOL[k] || ["#8b5cf6", "#ec4899", "#22d3ee", "#f59e0b"][i % 4]}"></i>${esc(k)} ${n}</span>`).join("")}</div>`;
  }
  function panel(d, hub, big) {
    const x = extract(d); if (!x.scores.length && !x.dist && !x.bars.length && !x.kpis.length) return "";
    const tiles = [];
    x.scores.forEach((s, i) => tiles.push(`<div class="zg-tile"><div class="t">${esc(s.label)} score</div>${ring(s.v, col(s.v))}<div class="zg-leg">${s.v >= 80 ? "Strong" : s.v >= 55 ? "Needs work" : "Critical"}</div></div>`));
    if (x.dist) tiles.push(`<div class="zg-tile"><div class="t">${esc(x.dist.title)}</div>${donut(x.dist.c)}</div>`);
    x.kpis.forEach(k => tiles.push(`<div class="zg-tile"><div class="t">${esc(k.label)}</div><div class="v">${Number.isInteger(k.v) ? k.v.toLocaleString() : k.v.toFixed(1)}</div></div>`));
    x.bars.forEach(b => { const m = Math.max(...b.rows.map(r => r.n), 1); tiles.push(`<div class="zg-tile wide"><div class="t">${esc(b.title)}</div>${b.rows.map(r => `<div class="hb"><span title="${esc(r.l)}">${esc(r.l)}</span><div class="tr"><i data-w="${Math.max(3, r.n / m * 100)}"></i></div><b>${r.n.toLocaleString()}</b></div>`).join("")}</div>`); });
    if (x.fixes.length) tiles.push(`<div class="zg-tile wide"><div class="t">Priority fixes</div>${x.fixes.map((f, i) => `<div class="zd-c" style="--zc:${DCOL[f.p] || "#8b5cf6"};margin:6px 0"><b><span class="tag">${i + 1}</span>${esc(f.t)}</b>${esc(f.d).slice(0, 220)}</div>`).join("")}</div>`);
    return `<div class="zg"><div class="zg-h"><span class="pro">PRO</span>${esc(hub)} insights<button type="button" data-ask>Ask AI about this ✦</button></div><div class="zg-grid">${tiles.join("")}</div></div>`;
  }
  function animate(el) { requestAnimationFrame(() => setTimeout(() => {
    el.querySelectorAll(".ring .fg").forEach(c => { const l = 2 * Math.PI * 50; c.style.strokeDasharray = `${c.dataset.v / 100 * l} 999`; });
    el.querySelectorAll(".hb i").forEach(i => i.style.width = i.dataset.w + "%"); }, 60)); }

  const skip = /\/api\/(billing|auth|telemetry|admin)|\/agent\/(ask|projects|tasks|integrations|agency|memory|decisions|alerts|monitor\/jobs)/;
  function render(url, d) {
    return; // auto-graphics removed: Pro Studio now owns all Pro visuals
    const view = $(".app-view.active-view"); if (!view || !d || typeof d !== "object") return;
    const sec = (view.id || "").replace("view-", "");
    const hub = $(".zs-item.on span:nth-child(2)")?.textContent || "SEO";
    const html = panel(d, sec === "agent-dashboard" ? "Command Center" : hub, sec === "agent-dashboard"); if (!html) return;
    view.querySelector(".zg")?.remove();
    const anchor = view.querySelector(".zd") || view.querySelector(".scanner,.section-url-bar") || view.firstElementChild;
    anchor.insertAdjacentHTML("afterend", html); const p = view.querySelector(".zg"); animate(p);
    p.querySelector("[data-ask]").onclick = () => { $(".za-fab")?.click(); const q = $("#zaQ"); if (q) { q.value = "Explain the results on this page and what I should do first"; q.focus(); } };
  }
  const prev = window.fetch;
  window.fetch = async function (input, init) {
    const res = await prev.apply(this, arguments);
    try { const u = typeof input === "string" ? input : input.url; if ((init && init.method === "POST") && /\/api\//.test(u) && !skip.test(u) && !(init.headers && init.headers["X-Lx"]) && res.ok) res.clone().json().then(d => render(u, d)).catch(() => {}); } catch (e) {}
    return res;
  };

  /* ---------- Pro Deep-Dive per section ---------- */
  const IMPACT = " For each action start the title with [HIGH], [MEDIUM] or [LOW] impact. Give at most 6 actions. Use only the evidence provided.";
  const DIVE = {
    audit: ["Pro Audit Deep-Dive", "Rank the fixes that will move rankings most, ordered by impact vs effort."],
    technical: ["Technical Pro Review", "List the technical SEO problems blocking crawling, indexing or speed, most severe first."],
    onpage: ["On-Page Pro Rewrite Plan", "Which on-page elements (title, meta, headings, content, images) should be rewritten first and how?"],
    indexing: ["Indexing Pro Diagnosis", "Explain any indexing risks (robots, canonical, noindex, redirects) and how to fix them."],
    "site-health": ["Health Pro Report", "Summarise site health and the 5 changes that improve it most."],
    opportunities: ["Opportunity Finder Pro", "Which quick wins offer the best return for the least effort?"],
    keywords: ["Keyword Pro Strategy", "Which keyword themes should this site target first and what content is missing for them?"],
    rank1: ["Rank #1 Pro Blueprint", "What are the top actions this page needs to reach position 1 for its main topic?"],
    content: ["Content Pro Editor", "What should be added, cut or restructured in this page's content to satisfy search intent?"],
    "content-gap": ["Content Gap Pro Map", "What topics or sections are missing that competitors likely cover? Base it on this page only."],
    "rank-checker": ["Rank Pro Coach", "Give the actions most likely to improve this site's rankings for its main keywords."],
    competitors: ["Competitor Pro Playbook", "How can this site differentiate and win against competitors, based on its own strengths and weaknesses?"],
    backlinks: ["Link-Building Pro Plan", "Suggest a realistic link-building plan for this site with priorities."],
    pagespeed: ["Speed Pro Tuning", "Which performance fixes would help Core Web Vitals most?"],
    trends: ["Trend Pro Planner", "What content calendar ideas fit this site's niche?"],
    "agent-dashboard": ["Command Center Briefing", "Give an executive briefing: biggest risks, biggest wins and the next 5 moves."],
    "ai-advisor": ["30-Day Pro Roadmap", "Create a week-by-week 30-day SEO roadmap for this site."],
    "top-rankings": ["Top Rankings Pro Scan", "Which pages of this site are closest to ranking well and what would push them higher?"],
    links: ["Internal Link Pro Map", "Which internal linking improvements would help important pages rank?"],
    evidence: ["Evidence Pro Verification", "Summarise what is verified on this site and what could not be verified."],
    reports: ["Report Pro Summary", "Write an executive summary of this site's SEO status for a client."],
    optimizer: ["Optimizer Pro Coach", "What are the highest-impact edits to make on this page right now?"],
    "rank-history": ["Ranking Pro Insights", "How should this site track and improve its rankings over the next 30 days?"],
    "action-center": ["Action Pro Planner", "Create a prioritised to-do list for this site with impact tags."],
    "gsc-gap": ["GSC Pro Analyst", "What should this site do to close keyword gaps and use Search Console data well?"],
    "growth-os": ["Growth OS Pro Plan", "Give a growth plan combining technical, content and link priorities."],
    "seo-intelligence": ["Intelligence Pro Brief", "Give a strategic SEO intelligence brief for this site."],
    "projects-reports": ["Project Pro Brief", "Summarise this site as a client project: status, risks and next steps."],
    monitoring: ["Monitoring Pro Setup", "What should be monitored on this site and what would trigger an alert?"],
  };
  function addDives() {
    Object.entries(DIVE).forEach(([id, [name, q]]) => {
      const v = document.getElementById("view-" + id); if (!v || v.querySelector(".zd")) return;
      const box = document.createElement("div");
      if (id === "agent-dashboard") { const h = document.createElement("div"); h.className = "zh"; h.innerHTML = "<b>Pro Command Center</b><span>Live score, issue radar and an AI briefing — built from real crawl evidence.</span>"; (v.firstElementChild || v).before(h); }
      box.className = "zd";
      box.innerHTML = `<div class="zd-top"><span class="zg-h" style="margin:0"><span class="pro">PRO</span></span><span><b>${esc(name)}</b> — enter a website to start the Pro test</span></div>
        <div class="zd-in"><input type="text" placeholder="https://your-website.com" autocomplete="off" value="${esc(localStorage.getItem("zaUrl") || "")}"/><button type="button">▶ Start Pro test</button></div><div class="zd-out"></div>`;
      const first = v.querySelector(".scanner,.section-url-bar"); first ? first.after(box) : v.prepend(box);
      const inp = box.querySelector("input"), btn = box.querySelector("button"), out = box.querySelector(".zd-out");
      const run = async () => {
        let u = inp.value.trim(); if (!u) { out.innerHTML = '<div class="zd-c">Enter your website URL above to start.</div>'; inp.focus(); return; }
        if (!/^https?:\/\//i.test(u)) u = "https://" + u; if (!/\.[a-z]{2,}/i.test(u)) { out.innerHTML = '<div class="zd-c">That does not look like a valid website address.</div>'; return; }
        if (!tok()) { out.innerHTML = '<div class="zd-c">Please sign in first.</div>'; return; }
        localStorage.setItem("zaUrl", u); btn.disabled = true; btn.textContent = "Analysing…";
        out.innerHTML = '<div class="zd-c">✦ Crawling the site and analysing real evidence… this can take up to a minute.</div>';
        try {
          const r = await fetch("/api/agent/ask", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok() }, body: JSON.stringify({ url: u, question: q + IMPACT }) });
          if (r.status === 402) { out.innerHTML = ""; return; } const d = await r.json();
          if (!d.success) { out.innerHTML = `<div class="zd-c">${esc(d.error || "Failed")}</div>`; return; }
          const a = d.answer || {}; const C = { HIGH: "#f43f5e", MEDIUM: "#fbbf24", LOW: "#22d3ee" };
          const g = d.verified ? panel(d.verified, name, false).replace('class="zg"', 'class="zg" style="margin:0 0 12px"') : "";
          out.innerHTML = g + (a.answer ? `<div class="zd-c">${esc(a.answer)}</div>` : "") + (a.actions || []).map((x, i) => { const m = /^\s*\[(HIGH|MEDIUM|LOW)\]\s*/i.exec(x.title || ""), lvl = m ? m[1].toUpperCase() : ""; return `<div class="zd-c" style="--zc:${C[lvl] || "#8b5cf6"}"><b><span class="tag">${lvl || "#" + (i + 1)}</span>${esc((x.title || "").replace(/^\s*\[[A-Z]+\]\s*/i, ""))}</b>${esc(x.what_to_do)}</div>`; }).join("");
          animate(out); out.querySelector("[data-ask]")?.remove();
        } catch (e) { out.innerHTML = '<div class="zd-c">Network error — try again.</div>'; }
        finally { btn.disabled = false; btn.textContent = "▶ Start Pro test"; }
      };
      btn.onclick = run; inp.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
      inp.addEventListener("input", () => localStorage.setItem("zaUrl", inp.value.trim()));
    });
  }
  const start = () => {}; // per-section Pro now lives in pro-sections.js
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start) : start();
})();
