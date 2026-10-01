/* SEO Zypp Admin — premium UX layer. Purely additive: no data logic, no API calls. */
(function () {
  "use strict";
  var root = document.documentElement;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var get = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var set = function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} };

  /* ---- theme: dark default, remembers choice, "Auto" never forced ---- */
  root.dataset.atheme = get("zp_admin_theme") === "light" ? "light" : "dark";

  var ICONS = {
    overview: "M3 12l9-9 9 9M5 10v10h14V10",
    users: "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8",
    projects: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
    audits: "M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",
    monitoring: "M22 12h-4l-3 9L9 3l-3 9H2",
    activity: "M12 8v4l3 3M3 12a9 9 0 1018 0 9 9 0 00-18 0",
    performance: "M3 3v18h18M7 14l4-4 3 3 5-6",
    auditlog: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h5",
    live: "M12 12m-2 0a2 2 0 104 0 2 2 0 10-4 0M16.2 7.8a6 6 0 010 8.4M7.8 16.2a6 6 0 010-8.4",
    sessions: "M4 4h16v12H4zM8 20h8M12 16v4",
    apiusage: "M16 18l6-6-6-6M8 6l-6 6 6 6",
    logins: "M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"
  };
  var GROUPS = { overview: "Workspace", live: "Live operations", performance: "Intelligence", auditlog: "Governance" };
  var svg = function (d) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>'; };

  function enhanceNav() {
    $$(".sidebar .nav-item").forEach(function (n) {
      var sec = n.dataset.section, mk = $(".mk", n);
      if (mk && ICONS[sec] && !mk.dataset.zp) { mk.innerHTML = svg(ICONS[sec]); mk.dataset.zp = "1"; }
    });
    // Re-group nav logically (visual order only; handlers stay attached to the same elements)
    var side = $(".sidebar"); if (!side || side.dataset.zpGrouped) return; side.dataset.zpGrouped = "1";
    var order = [["Workspace", ["overview", "users", "projects", "audits"]], ["Live operations", ["live", "sessions", "activity", "logins"]],
      ["Intelligence", ["monitoring", "performance", "apiusage"]], ["Governance", ["auditlog"]]];
    var foot = $(".sidebar-foot", side), by = {};
    $$(".nav-item", side).forEach(function (n) { by[n.dataset.section] = n; });
    order.forEach(function (g) {
      var h = document.createElement("div"); h.className = "zp-grp"; h.textContent = g[0]; side.insertBefore(h, foot);
      g[1].forEach(function (s) { if (by[s]) side.insertBefore(by[s], foot); });
    });
  }

  function injectLoginHero() {
    var ls = $("#loginScreen"); if (!ls || $(".zp-hero", ls)) return;
    var h = document.createElement("div"); h.className = "zp-hero";
    h.innerHTML = '<div class="zp-logo">Z</div><h2>Run your SEO platform<br>with full clarity.</h2>' +
      '<p>Live users, audits, API usage and every admin action — one command centre built on your real database.</p>' +
      '<div class="zp-feats"><span>● Live presence</span><span>◆ Audit trail</span><span>⚡ API usage</span><span>🔒 Admin-only</span></div>';
    ls.insertBefore(h, ls.firstChild);
  }

  function enhanceTopbar() {
    var bar = $(".bar-right"); if (!bar || $("#zpSearch")) return;
    var s = document.createElement("button"); s.type = "button"; s.id = "zpSearch"; s.className = "zp-search";
    s.innerHTML = '<span>Jump to…</span><kbd>Ctrl K</kbd>'; s.onclick = openPalette; bar.insertBefore(s, bar.firstChild);
    var t = document.createElement("button"); t.type = "button"; t.className = "ghost-btn zp-theme"; t.title = "Toggle light / dark"; t.setAttribute("aria-label", "Toggle theme");
    function paint() { t.textContent = root.dataset.atheme === "light" ? "☀" : "☾"; }
    t.onclick = function () { root.dataset.atheme = root.dataset.atheme === "light" ? "dark" : "light"; set("zp_admin_theme", root.dataset.atheme); paint(); };
    paint(); bar.insertBefore(t, $("#refreshBtn"));
    var c = document.createElement("button"); c.type = "button"; c.className = "ghost-btn zp-theme"; c.title = "Collapse sidebar"; c.setAttribute("aria-label", "Collapse sidebar"); c.textContent = "⇤";
    c.onclick = function () { var on = root.classList.toggle("zp-collapsed"); set("zp_admin_rail", on ? "1" : "0"); c.textContent = on ? "⇥" : "⇤"; };
    if (get("zp_admin_rail") === "1") { root.classList.add("zp-collapsed"); c.textContent = "⇥"; }
    bar.insertBefore(c, bar.firstChild);
  }

  /* ---- command palette ---- */
  var pal, sel = 0, items = [];
  function buildItems() {
    items = $$(".sidebar .nav-item").map(function (n) { return { t: ($(".label", n) || n).textContent.trim(), h: "Go to section", run: function () { n.click(); } }; });
    [["Refresh data", "refreshBtn"], ["Sign out", "logoutBtn"]].forEach(function (a) { items.push({ t: a[0], h: "Action", run: function () { var b = document.getElementById(a[1]); if (b) b.click(); } }); });
    items.push({ t: "Toggle light / dark", h: "Appearance", run: function () { var b = $(".zp-theme"); if (b) b.click(); } });
  }
  function render(q) {
    var list = $(".zp-list", pal), f = items.filter(function (i) { return i.t.toLowerCase().indexOf(q.toLowerCase()) > -1; });
    sel = Math.min(sel, Math.max(0, f.length - 1)); pal._f = f;
    list.innerHTML = f.length ? "" : '<div class="zp-opt">No matches</div>';
    f.forEach(function (i, idx) {
      var d = document.createElement("div"); d.className = "zp-opt" + (idx === sel ? " sel" : ""); d.textContent = i.t;
      var sm = document.createElement("small"); sm.textContent = i.h; d.appendChild(sm);
      d.onclick = function () { closePalette(); i.run(); }; list.appendChild(d);
    });
  }
  function openPalette() {
    if (!$("#app") || $("#app").style.display === "none") return;
    if (!pal) {
      pal = document.createElement("div"); pal.className = "zp-pal";
      pal.innerHTML = '<div class="zp-box"><input type="text" placeholder="Search sections and actions…" aria-label="Command palette"><div class="zp-list"></div></div>';
      document.body.appendChild(pal);
      pal.addEventListener("click", function (e) { if (e.target === pal) closePalette(); });
      var inp = $("input", pal);
      inp.addEventListener("input", function () { sel = 0; render(inp.value); });
      inp.addEventListener("keydown", function (e) {
        var f = pal._f || [];
        if (e.key === "ArrowDown") { sel = Math.min(sel + 1, f.length - 1); render(inp.value); e.preventDefault(); }
        else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); render(inp.value); e.preventDefault(); }
        else if (e.key === "Enter" && f[sel]) { var r = f[sel].run; closePalette(); r(); }
      });
    }
    buildItems(); sel = 0; var i = $("input", pal); i.value = ""; render(""); pal.classList.add("on"); i.focus();
  }
  function closePalette() { if (pal) pal.classList.remove("on"); }
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal && pal.classList.contains("on") ? closePalette() : openPalette(); }
    else if (e.key === "Escape") closePalette();
  });

  /* ---- count-up animation for stat numbers (display only; real value restored at the end) ---- */
  function countUp(el) {
    var txt = el.textContent.trim(); if (el.dataset.zpAnim || !/^\d{1,9}$/.test(txt) || el.dataset.zpDone === txt) return;
    el.dataset.zpDone = txt; el.dataset.zpAnim = "1"; var end = +txt, t0 = performance.now(), dur = 700;
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) { delete el.dataset.zpAnim; return; }
    (function step(now) { var p = Math.min(1, (now - t0) / dur), v = Math.round(end * (1 - Math.pow(1 - p, 3))); el.textContent = p < 1 ? v : txt; if (p < 1) requestAnimationFrame(step); else delete el.dataset.zpAnim; })(t0);
  }
  var busy = false;
  new MutationObserver(function () {
    if (busy) return; busy = true;
    requestAnimationFrame(function () { $$(".stat .num").forEach(countUp); busy = false; });
  }).observe(document.body, { childList: true, subtree: true });

  function boot() { injectLoginHero(); enhanceNav(); enhanceTopbar(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
