/* SEO Zypp — Contrast Guard + signature features.
   1. Contrast Guard  : WCAG check on rendered text; fixes unreadable text in either theme, even for
                        content rendered later (self-healing UI).
   2. Theme Studio    : Light / Dark / Auto(system) + accent palettes + density + calm motion.
   3. Mission Control : "Next Best Action" + SEO Quest (XP, level, streak, badges) built from REAL
                        workspace data (sites, searches, completed tasks). Nothing is invented.
   4. Keyword Opportunity: transparent heuristic score, filters, CSV export on keyword results. */
(function () {
  "use strict";
  var root = document.documentElement;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var prefs = Object.assign({ mode: "manual", accent: "aurora", compact: false, calm: false }, LS.get("zx_prefs", {}));
  function savePrefs() { LS.set("zx_prefs", prefs); }

  /* ================= 1. CONTRAST GUARD ================= */
  var FIX_ATTR = "data-zx-fix";
  function parseColor(c) {
    var m = /rgba?\(([^)]+)\)/.exec(c || ""); if (!m) return null;
    var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) { var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
  function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function over(top, base) { var a = top.a; return { r: top.r * a + base.r * (1 - a), g: top.g * a + base.g * (1 - a), b: top.b * a + base.b * (1 - a), a: 1 }; }
  function pageBase() { return root.dataset.theme === "dark" ? { r: 10, g: 7, b: 20, a: 1 } : { r: 246, g: 243, b: 255, a: 1 }; }
  // Effective background; returns null when it sits on a gradient/image (can't be judged reliably).
  function bgOf(el) {
    var layers = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      var c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.98) break; }
    }
    var out = pageBase();
    for (var i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
    return out;
  }
  function hasOwnText(el) { for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true; return false; }
  var SKIP = /^(SCRIPT|STYLE|SVG|PATH|INPUT|TEXTAREA|SELECT|OPTION|NOSCRIPT|CANVAS|IMG|BR|HR|CODE|PRE)$/i;
  function checkEl(el) {
    if (SKIP.test(el.tagName) || !hasOwnText(el) || el.closest("[data-zx-ignore]")) return;
    if (!el.getClientRects().length) return;
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return;
    var fill = parseColor(cs.webkitTextFillColor);
    if (fill && fill.a === 0) return;                         // gradient/clip text, intentional
    var fg = parseColor(cs.color), bg = bgOf(el);
    if (!fg || !bg) return;
    if (fg.a < 1) fg = over(fg, bg);
    if (ratio(fg, bg) >= 3) return;
    var light = { r: 244, g: 241, b: 255, a: 1 }, dark = { r: 27, g: 18, b: 51, a: 1 };
    var pick = ratio(light, bg) >= ratio(dark, bg) ? "#f4f1ff" : "#1b1233";
    el.style.setProperty("color", pick, "important");
    el.style.setProperty("-webkit-text-fill-color", pick, "important");
    el.setAttribute(FIX_ATTR, "1");
  }
  function resetFixes() {
    $$("[" + FIX_ATTR + "]").forEach(function (el) {
      el.style.removeProperty("color"); el.style.removeProperty("-webkit-text-fill-color"); el.removeAttribute(FIX_ATTR);
    });
  }
  var queue = [], scheduled = false;
  function pump() {
    var t0 = performance.now();
    while (queue.length && performance.now() - t0 < 10) checkEl(queue.shift());
    if (queue.length) schedule(); else scheduled = false;
  }
  function schedule() { scheduled = true; (window.requestIdleCallback || function (f) { return setTimeout(f, 30); })(pump, { timeout: 200 }); }
  function enqueueTree(node) {
    if (!node || node.nodeType !== 1) return;
    queue.push(node); $$("*", node).forEach(function (e) { queue.push(e); });
    if (!scheduled) schedule();
  }
  var rescanT;
  function rescanAll() { clearTimeout(rescanT); rescanT = setTimeout(function () { resetFixes(); queue = []; enqueueTree(document.body); }, 120); }

  /* ================= 2. THEME STUDIO ================= */
  var ACCENTS = {
    aurora:  ["#8b5cf6", "#ec4899", "linear-gradient(135deg,#8b5cf6,#ec4899 60%,#f59e0b)"],
    ocean:   ["#0ea5e9", "#6366f1", "linear-gradient(135deg,#0ea5e9,#6366f1)"],
    emerald: ["#10b981", "#06b6d4", "linear-gradient(135deg,#10b981,#06b6d4)"],
    sunset:  ["#f97316", "#e11d48", "linear-gradient(135deg,#f59e0b,#f97316 50%,#e11d48)"],
    rose:    ["#ec4899", "#a855f7", "linear-gradient(135deg,#f472b6,#ec4899 50%,#a855f7)"],
    graphite:["#64748b", "#334155", "linear-gradient(135deg,#94a3b8,#475569)"]
  };
  var internalChange = false;
  function setTheme(t, persist) {
    internalChange = true; root.dataset.theme = t;
    if (persist) { try { localStorage.setItem("seo_zypp_theme", t); } catch (e) {} }
    var tg = $("#themeToggle"); if (tg) { var ic = $(".theme-icon", tg), lb = $(".theme-toggle-label", tg); if (ic) ic.textContent = t === "light" ? "☀" : "☾"; if (lb) lb.textContent = t === "light" ? "Light mode" : "Dark mode"; tg.setAttribute("aria-pressed", String(t !== "light")); }
    setTimeout(function () { internalChange = false; }, 0);
  }
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function applyMode() {
    if (prefs.mode === "auto" && mq) setTheme(mq.matches ? "dark" : "light", false);
    else if (prefs.mode === "light" || prefs.mode === "dark") setTheme(prefs.mode, true);
  }
  function applyAccent() {
    var a = ACCENTS[prefs.accent] || ACCENTS.aurora;
    root.style.setProperty("--z-a", a[0], "important"); root.style.setProperty("--z-b", a[1], "important"); root.style.setProperty("--z-grad", a[2], "important");
  }
  function applyFlags() { root.classList.toggle("zx-compact", !!prefs.compact); root.classList.toggle("zx-calm", !!prefs.calm); }

  function buildStudio() {
    if ($("#zxStudioBtn")) return;
    var btn = document.createElement("button"); btn.id = "zxStudioBtn"; btn.type = "button"; btn.className = "zx-studio-btn";
    btn.innerHTML = "🎨 <span>Studio</span>"; btn.setAttribute("aria-haspopup", "dialog");
    var tg = $("#themeToggle");
    if (tg && tg.parentElement) tg.parentElement.insertBefore(btn, tg); else { btn.classList.add("float"); document.body.appendChild(btn); }
    var pop = document.createElement("div"); pop.className = "zx-pop"; pop.id = "zxPop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Theme Studio");
    pop.innerHTML =
      "<h5>Mode</h5><div class='zx-seg'>" +
      ["light:☀ Light", "dark:☾ Dark", "auto:◐ Auto"].map(function (s) { var p = s.split(":"); return "<button class='zx-chip' data-mode='" + p[0] + "'>" + p[1] + "</button>"; }).join("") +
      "</div><h5>Accent</h5><div class='zx-sw'>" +
      Object.keys(ACCENTS).map(function (k) { return "<button title='" + k + "' aria-label='" + k + "' data-accent='" + k + "' style='background:" + ACCENTS[k][2] + "'></button>"; }).join("") +
      "</div><h5>Layout</h5><div class='zx-seg'><button class='zx-chip' data-flag='compact'>Compact</button><button class='zx-chip' data-flag='calm'>Calm motion</button></div>";
    document.body.appendChild(pop);
    function paint() {
      $$("[data-mode]", pop).forEach(function (b) { b.classList.toggle("on", (prefs.mode === "manual" ? root.dataset.theme : prefs.mode) === b.dataset.mode); });
      $$("[data-accent]", pop).forEach(function (b) { b.classList.toggle("on", b.dataset.accent === prefs.accent); });
      $$("[data-flag]", pop).forEach(function (b) { b.classList.toggle("on", !!prefs[b.dataset.flag]); });
    }
    pop.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.dataset.mode) { prefs.mode = b.dataset.mode; applyMode(); }
      if (b.dataset.accent) { prefs.accent = b.dataset.accent; applyAccent(); }
      if (b.dataset.flag) { prefs[b.dataset.flag] = !prefs[b.dataset.flag]; applyFlags(); }
      savePrefs(); paint();
    });
    btn.addEventListener("click", function (e) { e.stopPropagation(); paint(); pop.classList.toggle("on"); });
    document.addEventListener("click", function (e) { if (!pop.contains(e.target) && e.target !== btn) pop.classList.remove("on"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") pop.classList.remove("on"); });
  }
  if (mq) (mq.addEventListener ? mq.addEventListener("change", function () { if (prefs.mode === "auto") applyMode(); }) : mq.addListener(function () { if (prefs.mode === "auto") applyMode(); }));
  new MutationObserver(function () {
    if (!internalChange && prefs.mode !== "manual") { prefs.mode = "manual"; savePrefs(); }   // user used the classic toggle
    rescanAll();
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  /* ================= 3. MISSION CONTROL ================= */
  var BADGES = [
    { id: "site",  label: "🌐 First site",     ok: function (s) { return s.sites >= 1; } },
    { id: "res",   label: "🔎 Researcher",     ok: function (s) { return s.searches >= 5; } },
    { id: "task",  label: "✅ Task slayer",    ok: function (s) { return s.done >= 5; } },
    { id: "streak",label: "🔥 3-day streak",   ok: function (s) { return s.streak >= 3; } },
    { id: "week",  label: "🏆 7-day streak",   ok: function (s) { return s.streak >= 7; } }
  ];
  function day(d) { return d.toISOString().slice(0, 10); }
  function updateStreak() {
    var st = LS.get("zx_streak", { last: null, count: 0 }), today = day(new Date());
    if (st.last !== today) {
      var y = new Date(); y.setDate(y.getDate() - 1);
      st.count = st.last === day(y) ? st.count + 1 : 1; st.last = today; LS.set("zx_streak", st);
    }
    return st.count;
  }
  var streak = updateStreak();
  function num(sel) { var e = $(sel); return e ? parseInt((e.textContent || "0").replace(/\D/g, ""), 10) || 0 : 0; }
  function stats() { return { sites: num("#websiteCount"), searches: num("#searchCount"), done: num("#completedTasks"), open: num("#pendingTasks"), streak: streak }; }
  function xpOf(s) { return s.sites * 30 + s.searches * 5 + s.done * 20 + s.streak * 10; }
  function level(xp) { var l = Math.floor(Math.sqrt(xp / 50)) + 1, lo = 50 * (l - 1) * (l - 1), hi = 50 * l * l; return { l: l, pct: Math.round((xp - lo) / (hi - lo) * 100), toNext: hi - xp }; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function nextAction(s) {
    if (!s.sites) return { t: "Add your first website", w: "Every report, task and keyword idea is tied to a site. It takes 10 seconds.", cta: "Add website", go: function () { var b = $("#addWebsiteBtn"); if (b) b.click(); } };
    var first = $("#taskList .task-item:not(.done)");
    if (first) { var title = ($("span", first) || first).textContent.trim(); return { t: title || "Finish your next task", w: s.open + " task" + (s.open === 1 ? "" : "s") + " still open — knocking this one out moves your progress ring and earns +20 XP.", cta: "Mark done", go: function () { var cb = $("input[type=checkbox]", first); if (cb) cb.click(); }, alt: "View tasks", altGo: function () { var t = $("#taskList"); if (t) t.scrollIntoView({ behavior: "smooth", block: "center" }); } }; }
    if (!s.searches) return { t: "Run your first SEO snapshot", w: "Paste a URL into SEO Monitor to get a live technical + on-page read-out.", cta: "Go to SEO Monitor", go: function () { var i = $("#monitorUrl"); if (i) { i.scrollIntoView({ behavior: "smooth", block: "center" }); i.focus(); } } };
    return { t: "Create tasks from your latest findings", w: "You're caught up. Turn the newest audit findings into tasks so nothing slips.", cta: "Add task", go: function () { var b = $("#addTaskBtn"); if (b) b.click(); } };
  }
  var lastSig = "";
  function renderMission() {
    var host = $(".workspace-stats"); if (!host) return;
    var box = $("#zxMission");
    if (!box) { box = document.createElement("div"); box.id = "zxMission"; box.className = "zx-mission"; host.parentNode.insertBefore(box, host); }
    var s = stats(), first = $("#taskList .task-item:not(.done)"), sig = JSON.stringify([s, first ? first.textContent : ""]);
    if (sig === lastSig) return; lastSig = sig;
    var a = nextAction(s), xp = xpOf(s), lv = level(xp);
    box.innerHTML =
      "<div class='zx-card zx-next'><h4>Next best action</h4><div class='zx-big'>" + esc(a.t) + "</div><p class='zx-why'>" + esc(a.w) + "</p><div class='zx-row'><button class='zx-btn' id='zxGo'>" + esc(a.cta) + "</button>" + (a.alt ? "<button class='zx-btn ghost' id='zxAlt'>" + esc(a.alt) + "</button>" : "") + "</div></div>" +
      "<div class='zx-card'><h4>SEO Quest</h4><div class='zx-quest'><div class='zx-ring' style='--p:" + lv.pct + "'><span>" + lv.l + "</span></div><div class='zx-qmeta'><b>Level " + lv.l + " · " + xp + " XP</b><small>" + lv.toNext + " XP to level " + (lv.l + 1) + " · 🔥 " + s.streak + "-day streak</small></div></div><div class='zx-badges'>" +
      BADGES.map(function (b) { return "<span class='zx-badge" + (b.ok(s) ? "" : " lock") + "'>" + b.label + "</span>"; }).join("") + "</div></div>";
    var g = $("#zxGo", box); if (g) g.onclick = a.go; var al = $("#zxAlt", box); if (al) al.onclick = a.altGo;
  }

  /* ================= 4. KEYWORD OPPORTUNITY ================= */
  function scoreRow(row) {
    var st = $$(".keyword-stat", row), val = function (i) { var s = st[i] && $("strong", st[i]); return s ? s.textContent.trim() : ""; };
    var pr = val(0).toLowerCase(), it = val(1).toLowerCase(), pos = parseInt(val(2).replace(/\D/g, ""), 10);
    var s = pr === "high" ? 40 : pr === "medium" ? 25 : 10;
    s += /commercial|transact/.test(it) ? 30 : /inform/.test(it) ? 15 : /navig/.test(it) ? 5 : 18;
    s += isNaN(pos) ? 20 : pos <= 3 ? 5 : pos <= 10 ? 15 : pos <= 30 ? 25 : 12;
    return { score: Math.min(100, s), intent: it, keyword: ($(".keyword-name", row) || {}).textContent || "", priority: val(0), pos: isNaN(pos) ? "" : pos, topic: ($(".keyword-topic", row) || {}).textContent || "" };
  }
  var kwFilter = "all", kwSorted = false;
  function annotateKeywords() {
    var res = $("#keywordResults"); if (!res) return;
    var rows = $$(".keyword-row", res); if (!rows.length) { var old = $("#zxKwBar"); if (old) old.remove(); return; }
    rows.forEach(function (r) {
      if (r.dataset.zx) return;
      var d = scoreRow(r); r.dataset.zx = "1"; r.dataset.score = d.score; r.dataset.intent = d.intent;
      var tier = d.score >= 75 ? ["hot", "Hot"] : d.score >= 55 ? ["warm", "Warm"] : ["cool", "Cool"];
      var cell = r.firstElementChild; if (!cell) return;
      var b = document.createElement("div"); b.className = "zx-opp " + tier[0]; b.dataset.zxIgnore = "1";
      b.title = "Heuristic: priority + search intent + current SERP position. A prioritisation aid, not a traffic forecast.";
      b.innerHTML = "<i></i>" + tier[1] + " opportunity · " + d.score; cell.appendChild(b);
    });
    if (!$("#zxKwBar")) {
      var bar = document.createElement("div"); bar.id = "zxKwBar"; bar.className = "zx-kwbar";
      bar.innerHTML = "<button class='zx-chip on' data-f='all'>All</button><button class='zx-chip' data-f='hot'>🔥 Hot only</button><button class='zx-chip' data-f='commercial'>💰 Commercial</button><button class='zx-chip' data-sort='1'>↕ Sort by score</button><button class='zx-chip' data-csv='1'>⬇ Export CSV</button>";
      res.parentNode.insertBefore(bar, res);
      bar.addEventListener("click", function (e) {
        var c = e.target.closest("button"); if (!c) return;
        if (c.dataset.f) { kwFilter = c.dataset.f; $$("[data-f]", bar).forEach(function (x) { x.classList.toggle("on", x === c); }); applyKwFilter(); }
        if (c.dataset.sort) { kwSorted = !kwSorted; c.classList.toggle("on", kwSorted); sortKw(); }
        if (c.dataset.csv) exportKw();
      });
    }
    applyKwFilter();
  }
  function applyKwFilter() { $$("#keywordResults .keyword-row").forEach(function (r) { var sc = +r.dataset.score || 0, show = kwFilter === "all" || (kwFilter === "hot" && sc >= 75) || (kwFilter === "commercial" && /commercial|transact/.test(r.dataset.intent || "")); r.style.display = show ? "" : "none"; }); }
  var origOrder = null;
  function sortKw() {
    var res = $("#keywordResults"), rows = $$(".keyword-row", res); if (!origOrder) origOrder = rows.slice();
    kwBusy = true; (kwSorted ? rows.slice().sort(function (a, b) { return b.dataset.score - a.dataset.score; }) : origOrder).forEach(function (r) { res.appendChild(r); }); setTimeout(function () { kwBusy = false; }, 0);
  }
  function exportKw() {
    var rows = $$("#keywordResults .keyword-row").filter(function (r) { return r.style.display !== "none"; }).map(scoreRow);
    var q = function (v) { return '"' + String(v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"'; };
    var csv = "keyword,topic,priority,intent,serp_position,opportunity_score\n" + rows.map(function (d) { return [d.keyword, d.topic, d.priority, d.intent, d.pos, d.score].map(q).join(","); }).join("\n");
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "keyword-opportunities.csv"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  var kwBusy = false;

  /* ================= BOOT ================= */
  function boot() {
    applyMode(); applyAccent(); applyFlags(); buildStudio(); renderMission(); annotateKeywords();
    var t;
    new MutationObserver(function (muts) {
      muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1 && !(n.dataset && n.dataset.zxIgnore) && !n.classList.contains("zx-opp")) enqueueTree(n); }); });
      clearTimeout(t); t = setTimeout(function () { if (!kwBusy) annotateKeywords(); renderMission(); buildStudio(); }, 80);
    }).observe(document.body, { childList: true, subtree: true, characterData: false });
    enqueueTree(document.body);
    setInterval(renderMission, 2500);                                    // counters can change without DOM insertion
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
