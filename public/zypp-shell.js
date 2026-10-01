/* SEO Zypp shell: grouped sidebar, hub tabs, free-trial meters, paywall + AI assistant */
(function () {
  const AUTH = "seoAgentAuth";
  const tok = () => { try { return JSON.parse(localStorage.getItem(AUTH) || "{}").token || ""; } catch (e) { return ""; } };
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const HUBS = [
    { lbl: "Overview" },
    { id: "overview", ic: "◈", name: "Dashboard", tabs: ["dashboard", "agent-dashboard"] },
    { lbl: "Optimize" },
    { id: "health", ic: "✓", name: "Site Health", g: "audit", tabs: ["audit", "technical", "onpage", "indexing", "site-health", "opportunities"] },
    { id: "keywords", ic: "⌕", name: "Keywords", g: "keywords", tabs: ["keywords", "rank1", "gsc-gap"] },
    { id: "content", ic: "✎", name: "Content Studio", g: "content", tabs: ["content", "content-gap", "optimizer"] },
    { lbl: "Track" },
    { id: "rankings", ic: "↗", name: "Rankings", g: "rankings", tabs: ["rank-checker", "top-rankings", "rank-history"] },
    { id: "competitors", ic: "◎", name: "Competitors & Links", g: "competitors", tabs: ["competitors", "backlinks", "links"] },
    { id: "speed", ic: "ϟ", name: "Speed & Trends", g: "performance", tabs: ["pagespeed", "trends"] },
    { lbl: "Automate" },
    { id: "ai", ic: "✦", name: "AI Studio", g: "ai", tabs: ["ai-advisor", "growth-os", "seo-intelligence"] },
    { id: "ops", ic: "▤", name: "Monitor & Reports", g: "monitoring", tabs: ["monitoring", "action-center", "reports", "projects-reports", "evidence"] },
    { lbl: "Toolkit" },
    { id: "toolkit", ic: "✧", name: "Pro Toolkit", badge: "NEW", tabs: ["snippet-lab", "schema-lab", "text-lab", "tech-files"] },
    { id: "advanced", ic: "⚡", name: "Advanced Suite", badge: "SOON", tabs: ["advanced"] },
    { lbl: "Account" },
    { id: "settings", ic: "⚙", name: "Settings", tabs: ["settings"] },
  ];
  const TAB_NAMES = { "snippet-lab": "Snippet Lab", "schema-lab": "Schema Lab", "text-lab": "Content Lab", "tech-files": "Tech Files", advanced: "Advanced Suite", dashboard: "Overview", "agent-dashboard": "Pro Dashboard", audit: "Site Audit", technical: "Technical", onpage: "On-Page", indexing: "Indexing", "site-health": "Health", opportunities: "Opportunities", rank1: "Rank #1 Planner", "gsc-gap": "GSC & Gap", "content-gap": "Content Gap", optimizer: "Optimizer", "rank-checker": "Rank Checker", "top-rankings": "Top Rankings", "rank-history": "History", links: "Internal Links", "seo-intelligence": "Intelligence Lab", "growth-os": "Growth OS", "ai-advisor": "AI Advisor", "action-center": "Action Center", reports: "Reports", "projects-reports": "Projects & PDF", evidence: "Evidence", monitoring: "Alerts" };
  const orig = id => $(`.nav-item[data-section="${id}"]`);
  const tabName = id => TAB_NAMES[id] || (orig(id)?.textContent || id).replace(/^[^A-Za-z]+/, "").trim();
  const go = id => orig(id)?.click();
  let bill = null, lastTab = {};

  function build() {
    const sb = $(".sidebar"), nav = $(".sidebar nav.nav");
    if (!sb || !nav || $(".zs")) return;
    const z = document.createElement("div"); z.className = "zs";
    z.innerHTML = HUBS.map(h => h.lbl ? `<div class="zs-lbl">${h.lbl}</div>` :
      `<button class="zs-item" data-hub="${h.id}" type="button"><span class="ic">${h.ic}</span><span>${h.name}</span><span class="lk" hidden></span></button>`).join("");
    nav.after(z);
    z.addEventListener("click", e => { const b = e.target.closest(".zs-item"); if (!b) return; const h = HUBS.find(x => x.id === b.dataset.hub); go(lastTab[h.id] || h.tabs[0]); });
    const plan = document.createElement("div"); plan.className = "zp"; plan.id = "zPlan"; z.after(plan);
    const tabs = document.createElement("div"); tabs.className = "zt"; tabs.id = "zTabs"; $(".main .header")?.after(tabs);
    tabs.addEventListener("click", e => { const b = e.target.closest("button"); if (b) go(b.dataset.s); });
    new MutationObserver(sync).observe(nav, { subtree: true, attributes: true, attributeFilter: ["class"] });
    sync(); HUBS.filter(h => h.badge).forEach(h => badge(h, $(`.zs-item[data-hub="${h.id}"] .lk`))); refresh();
  }
  function badge(h, el) { if (!el) return; el.hidden = false; el.textContent = h.badge; el.className = "lk" + (h.badge === "SOON" ? " zero" : " pro"); }
  function sync() {
    const cur = $(".nav-item.active")?.dataset.section; const hub = HUBS.find(h => h.tabs && h.tabs.includes(cur));
    document.querySelectorAll(".zs-item").forEach(b => b.classList.toggle("on", hub && b.dataset.hub === hub.id));
    const t = $("#zTabs"); if (!t) return;
    if (!hub || hub.tabs.length < 2) { t.innerHTML = ""; return; }
    lastTab[hub.id] = cur;
    t.innerHTML = hub.tabs.map(s => `<button data-s="${s}" class="${s === cur ? "on" : ""}" type="button">${esc(tabName(s))}</button>`).join("");
  }
  async function refresh() {
    if (!tok()) return;
    try {
      const r = await (window.__zf || fetch)("/api/billing/status", { headers: { Authorization: "Bearer " + tok() } }); if (!r.ok) return;
      bill = await r.json(); paint();
    } catch (e) {}
  }
  function paint() {
    if (!bill) return;
    HUBS.forEach(h => {
      const el = $(`.zs-item[data-hub="${h.id}"] .lk`); if (el && h.badge) { badge(h, el); return; }
      if (!el || !h.g) return;
      const g = bill.groups[h.g]; el.hidden = false;
      if (bill.paid) { el.textContent = bill.trial ? "TRIAL" : "PRO"; el.className = "lk pro"; }
      else { el.textContent = g.left ? `${g.left} free` : "Locked"; el.className = "lk" + (g.left ? "" : " zero"); }
    });
    const tot = Object.values(bill.groups), used = tot.reduce((a, g) => a + g.used, 0), max = tot.length * bill.limit;
    const dl = bill.expiresAt ? Math.max(0, Math.ceil((new Date(bill.expiresAt) - Date.now()) / 864e5)) : 0;
    $("#zPlan").innerHTML = bill.trial
      ? `<b>🎁 Free trial · ${dl} day${dl === 1 ? "" : "s"} left</b><small>Unlimited on every tool. Upgrade now = +${bill.bonusDays / 30} months FREE</small><div class="bar"><i style="width:${Math.min(100, dl / 30 * 100)}%"></i></div><button type="button" id="zUp">Claim 2 free months</button>`
      : bill.paid
      ? `<b>✦ ${esc(bill.plan.replace("_", " "))} active</b><small>Unlimited runs${bill.expiresAt ? " · renews " + new Date(bill.expiresAt).toLocaleDateString() : ""}</small><div class="bar"><i style="width:100%"></i></div>`
      : `<b>Free plan</b><small>${used} of ${max} free runs used</small><div class="bar"><i style="width:${Math.min(100, used / max * 100)}%"></i></div><button type="button" id="zUp">Upgrade to Pro</button>`;
    $("#zUp")?.addEventListener("click", () => paywall());
  }

  /* ---- paywall ---- */
  function modal() { let m = $("#zModal"); if (!m) { m = document.createElement("div"); m.id = "zModal"; m.className = "zm"; m.addEventListener("click", e => { if (e.target === m || e.target.closest(".x")) m.classList.remove("open"); }); document.body.appendChild(m); } return m; }
  async function paywall(info, pick) {
    if (!bill) await refresh(); const m = modal(); const p = bill?.plans || {}; const mo = p.pro_monthly, yr = p.pro_yearly; if (!mo || !yr) return;
    const yrMonthly = Math.round(yr.amountInr / 12), save = mo.amountInr * 12 - yr.amountInr, pct = Math.round(save / (mo.amountInr * 12) * 100);
    const usage = bill ? Object.values(bill.groups).map(g => `<div class="mini"><b>${g.left === null ? "∞" : g.left}</b>${esc(g.label)}</div>`).join("") : "";
    const Y = '<span class="y">✓</span>', N = '<span class="n">—</span>';
    const rows = [["Price", "₹0", `₹${mo.amountInr}/month`, `₹${yr.amountInr}/year`], ["Effective monthly cost", "₹0", `₹${mo.amountInr}`, `<b>₹${yrMonthly}</b>`], ["You save", N, N, `<span class="y">₹${save.toLocaleString()} (${pct}%)</span>`], ["Billing", "—", "Every month", "Once a year"],
      ["Runs per tool group", "5 total*", "Unlimited", "Unlimited"], ["New-user bonus", "30-day unlimited trial", "+2 months free", "+2 months free"], ["AI Assistant & Pro Deep-Dives", "5 runs", Y, Y], ["Graphical Pro insights", Y, Y, Y], ["Monitoring & PDF reports", N, Y, Y], ["Priority processing", N, Y, Y], ["Early access to new tools", N, N, Y], ["Cancel anytime", Y, Y, "Renew when you want"]];
    m.innerHTML = `<div class="box"><button class="x" type="button">×</button>${bill && bill.bonusEligible ? `<div class="bonus" style="margin:0 0 12px;padding:10px 14px;border-radius:12px;background:linear-gradient(90deg,#d4af37,#f5d67a);color:#241a00;font-weight:700">🎁 New-user offer: buy now and get 2 extra months FREE — added on top of your plan.</div>` : ""}<h2>${info ? "🔒 " + esc(info.label) + " is locked" : "Upgrade to Pro"}</h2>
      <p>${info ? esc(info.error) : "Compare plans and pick what suits you."} <b style="color:var(--z-ok)">Yearly saves ₹${save.toLocaleString()} (${pct}%) — about ${Math.round(yr.amountInr / mo.amountInr * 10) / 10} months' price for 12 months.</b></p>
      <div class="plans"><div class="pl" data-p="pro_monthly"><b style="color:var(--z-h)">Monthly</b><div class="pr">₹${mo.amountInr}<small>/month</small></div><p>Flexible — pay month to month.</p><button class="go" data-p="pro_monthly" type="button">Choose Monthly</button></div>
      <div class="pl best" data-p="pro_yearly"><b style="color:var(--z-h)">Yearly</b> <span style="font-size:10px;padding:2px 8px;border-radius:9px;background:var(--z-grad);color:#fff">BEST VALUE</span><div class="pr">₹${yr.amountInr}<small>/year</small></div><span class="sv">₹${yrMonthly}/mo · save ₹${save.toLocaleString()}</span><p>Lowest cost per month.</p><button class="go" data-p="pro_yearly" type="button">Choose Yearly</button></div></div>
      <table class="cmp"><thead><tr><th></th><th>Free</th><th>Monthly</th><th class="hl">Yearly ★</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td class="hl">${r[3]}</td></tr>`).join("")}</tbody></table>
      <div class="zg-h" style="margin-top:8px">Your remaining free runs</div><div class="ring">${usage}</div><p id="zPayMsg" style="margin-top:14px"></p></div>`;
    m.classList.add("open"); m.querySelectorAll(".go").forEach(b => b.onclick = () => checkout(b.dataset.p));
  }
  async function checkout(plan) {
    const msg = $("#zPayMsg"); msg.textContent = "Starting secure checkout…";
    const r = await (window.__zf || fetch)("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok() }, body: JSON.stringify({ plan }) });
    const d = await r.json().catch(() => ({})); if (!d.success) { msg.textContent = d.error || "Checkout failed."; return; }
    await new Promise((ok, no) => { if (window.Razorpay) return ok(); const s = document.createElement("script"); s.src = "https://checkout.razorpay.com/v1/checkout.js"; s.onload = ok; s.onerror = () => no(new Error("Could not load payment window")); document.head.appendChild(s); }).catch(e => { msg.textContent = e.message; });
    if (!window.Razorpay) return;
    new Razorpay({ key: d.keyId, order_id: d.orderId, amount: d.amount, currency: d.currency, name: "SEO Zypp", description: d.plan, theme: { color: "#8b5cf6" },
      handler: async resp => { const v = await (window.__zf || fetch)("/api/billing/verify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok() }, body: JSON.stringify(resp) }); const j = await v.json().catch(() => ({})); msg.textContent = j.success ? "🎉 Pro activated!" : (j.error || "Verification failed."); if (j.success) { await refresh(); setTimeout(() => modal().classList.remove("open"), 1200); } } }).open();
  }

  /*
   * Central authenticated fetch bridge.
   *
   * A number of older SEO modules call fetch() directly instead of going
   * through one shared API helper. After login that used to produce a very
   * confusing state: the workspace was visible, but a tool received a 401
   * because its request had no Bearer token. Read the token at request time
   * (not at page-load time) so the same SPA can be logged in without a
   * refresh. Never overwrite an explicit Authorization header and never add
   * credentials to the public auth endpoints.
   */
  window.__zf = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    let requestInit = init ? { ...init } : {};
    try {
      const u = typeof input === "string" ? input : (input && input.url) || "";
      const isApi = /^\/api\//.test(u) || /\/api\//.test(u);
      const isPublicAuth = /^\/api\/(auth\/(login|signup|reset-password|health)|auth\/me$)/.test(u);
      if (isApi && !isPublicAuth) {
        const token = tok();
        const headers = new Headers(
          requestInit.headers || (input && input.headers) || {}
        );
        if (token && !headers.has("Authorization")) {
          headers.set("Authorization", "Bearer " + token);
        }
        requestInit.headers = headers;
        if (!requestInit.credentials) requestInit.credentials = "same-origin";
      }
    } catch (e) {
      /* Keep the original request alive if header normalization fails. */
    }

    const res = await window.__zf(input, requestInit);
    try {
      const u = typeof input === "string" ? input : input.url;
      if (/\/api\//.test(u) && !/billing\/status/.test(u)) {
        if (res.status === 402) {
          res.clone().json().then(d => {
            if (d.code === "TRIAL_EXHAUSTED") { refresh(); paywall(d); }
          }).catch(() => {});
        } else if (res.headers.get("X-Trial-Group")) {
          refresh();
        }
      }
    } catch (e) {}
    return res;
  };

  /* Keep billing/feature state synchronized immediately after login or reset
     in the same tab. The browser storage event does not fire in the tab that
     performed localStorage.setItem(), so the auth page dispatches this event. */
  window.addEventListener("seo-agent-auth-changed", () => {
    refresh();
    paintEyebrow();
  });
  window.addEventListener("storage", e => {
    if (e.key === AUTH) refresh();
  });

  /* ---- AI assistant ---- */
  function assistant() {
    if ($(".za-fab")) return;
    const fab = document.createElement("button"); fab.className = "za-fab"; fab.type = "button"; fab.title = "AI SEO Assistant"; fab.textContent = "✦";
    const box = document.createElement("div"); box.className = "za";
    box.innerHTML = `<header><span>✦ AI SEO Assistant</span><button type="button">×</button></header><div class="url"><input id="zaUrl" placeholder="https://your-site.com"/></div>
      <div class="log" id="zaLog"><div class="m b">Hi! Tell me your site URL above, then ask anything — I answer from real crawl evidence, never made-up numbers.</div></div>
      <div class="chips">${["What should I fix first?", "Why is my traffic low?", "Give me a 30-day plan", "Which pages need content?"].map(q => `<button type="button">${q}</button>`).join("")}</div>
      <form><input id="zaQ" placeholder="Ask about your SEO…" maxlength="1200" autocomplete="off"/><button>Send</button></form>`;
    document.body.append(fab, box);
    const url = $("#zaUrl", box), log = $("#zaLog", box), q = $("#zaQ", box);
    url.value = localStorage.getItem("zaUrl") || "";
    fab.onclick = () => { box.classList.toggle("open"); if (!url.value) { const f = [...document.querySelectorAll("input.url-input")].map(i => i.value.trim()).find(v => /^https?:\/\/|\./.test(v)); if (f) url.value = f; } };
    $("header button", box).onclick = () => box.classList.remove("open");
    const add = (cls, html) => { const d = document.createElement("div"); d.className = "m " + cls; d.innerHTML = html; log.appendChild(d); log.scrollTop = 1e9; return d; };
    async function ask(text) {
      if (!text) return; if (!tok()) return add("b", "Please sign in first.");
      const u = url.value.trim(); if (!u) return add("b", "Add your website URL at the top first.");
      localStorage.setItem("zaUrl", u); add("u", esc(text)); q.value = ""; const w = add("b", "Analyzing your site…");
      try {
        const r = await fetch("/api/agent/ask", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok() }, body: JSON.stringify({ url: u, question: text }) });
        if (r.status === 402) return w.remove(); const d = await r.json();
        if (!d.success) return (w.textContent = d.error || "Something went wrong.");
        const a = d.answer || {}; w.innerHTML = esc(a.answer || "No answer returned.") + (a.actions || []).map(x => `<div class="act"><b>${esc(x.title)}</b>${esc(x.what_to_do)}</div>`).join("");
      } catch (e) { w.textContent = "Network error — try again."; }
    }
    $("form", box).onsubmit = e => { e.preventDefault(); ask(q.value.trim()); };
    box.querySelectorAll(".chips button").forEach(b => b.onclick = () => ask(b.textContent));
  }

  /* responsive drawer: sidebar is hidden <=900px, so give it a menu button */
  function drawer() {
    if ($(".zburger")) return; const sb = $(".sidebar"); if (!sb) return;
    const b = document.createElement("button"); b.className = "zburger"; b.type = "button"; b.setAttribute("aria-label", "Open menu"); b.textContent = "☰";
    const bk = document.createElement("div"); bk.className = "zback"; document.body.append(b, bk);
    const set = on => { sb.classList.toggle("zopen", on); bk.classList.toggle("on", on); };
    b.onclick = () => set(!sb.classList.contains("zopen")); bk.onclick = () => set(false);
    sb.addEventListener("click", e => { if (e.target.closest(".zs-item")) set(false); });
  }
  function eyebrow() {
    const t = $("#pageTitle"); if (!t || $(".zeyebrow")) return;
    const e = document.createElement("div"); e.className = "zeyebrow"; t.before(e);
  }
  function paintEyebrow() {
    const e = $(".zeyebrow"); if (!e) return; const cur = $(".nav-item.active")?.dataset.section; const h = HUBS.find(x => x.tabs && x.tabs.includes(cur));
    e.innerHTML = `<b>SEO Zypp</b><span>›</span><span>${esc(h ? h.name : "Workspace")}</span>` + (h && h.g ? "<i>PRO</i>" : "");
  }
  const killOldAI = () => document.querySelectorAll("#askAiFab,#askAiPanel").forEach(n => n.remove());
  const init = () => { build(); assistant(); drawer(); eyebrow(); paintEyebrow(); killOldAI(); setTimeout(killOldAI, 800); setTimeout(killOldAI, 2500);
    new MutationObserver(paintEyebrow).observe($(".sidebar nav.nav") || document.body, { subtree: true, attributes: true, attributeFilter: ["class"] }); };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
  window.addEventListener("storage", refresh); window.zyppRefreshBilling = refresh;
})();
