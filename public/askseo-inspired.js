
(function () {
  "use strict";

  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const AUTH_KEY = "seoAgentAuth";

  function authHeaders() {
    try {
      const a = JSON.parse(localStorage.getItem(AUTH_KEY) || "{}");
      return a.token ? { Authorization: "Bearer " + a.token } : {};
    } catch (_) { return {}; }
  }

  async function api(path, body, method="POST") {
    const r = await fetch(path, {
      method,
      headers: { "Content-Type":"application/json", ...authHeaders() },
      body: method === "GET" ? undefined : JSON.stringify(body || {})
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || d.detail || "Request failed.");
    return d;
  }

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }

  // Never infer the AI target from another section. A global fallback was a
  // source of cross-site contamination when multiple URLs were open at once.
  function currentUrl() { return $("#askAiUrl")?.value.trim() || ""; }

  /* ---------- AskSEO-style top search ---------- */
  function installTopbar() {
    const header = $(".header");
    const actions = $(".header-actions");
    if (!header || !actions || $(".ask-top-search")) return;

    const search = document.createElement("div");
    search.className = "ask-top-search";
    search.innerHTML =
      '<span class="ask-search-icon">⌕</span>' +
      '<input id="askGlobalSearch" type="search" placeholder="Search SEO tools, domains, keywords…" autocomplete="off">' +
      '<span class="ask-kbd">Ctrl K</span>';
    header.insertBefore(search, actions);

    /* Account identity lives in ONE place: #agentUserChip in the header (index.html).
       The duplicate "ask-user-chip" that used to render the name a second time was removed. */

    const input = $("#askGlobalSearch");
    input.addEventListener("focus", () => openPalette(input.value));
    input.addEventListener("input", () => openPalette(input.value));
    input.addEventListener("keydown", e => {
      if (e.key === "Escape") { closePalette(); input.blur(); }
      if (e.key === "Enter") { e.preventDefault(); selectFirstPaletteItem(); }
    });

    window.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette("");
        setTimeout(() => $("#askPaletteInput")?.focus(), 0);
      }
      if (e.key === "Escape") closePalette();
    });
  }

  /* ---------- Command palette ---------- */
  let paletteItems = [];

  function buildPalette() {
    paletteItems = $$(".nav-item[data-section]").map(btn => ({
      section: btn.dataset.section,
      label: btn.textContent.replace(/\s+/g," ").trim(),
      button: btn
    })).filter(x => x.section);
  }

  function ensurePalette() {
    if ($("#askPaletteBackdrop")) return;
    const el = document.createElement("div");
    el.id = "askPaletteBackdrop";
    el.className = "ask-palette-backdrop";
    el.innerHTML =
      '<div class="ask-palette" role="dialog" aria-modal="true" aria-label="SEO command palette">' +
        '<div class="ask-palette-head"><span>⌕</span><input id="askPaletteInput" placeholder="Jump to a tool…" autocomplete="off"></div>' +
        '<div class="ask-palette-list" id="askPaletteList"></div>' +
        '<div class="ask-palette-foot">Enter to open · ↑ ↓ to navigate · Esc to close · Ctrl K from anywhere</div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener("click", e => { if (e.target === el) closePalette(); });
    $("#askPaletteInput", el).addEventListener("input", e => renderPalette(e.target.value));
    $("#askPaletteInput", el).addEventListener("keydown", paletteKeydown);
  }

  function openPalette(query="") {
    ensurePalette(); buildPalette();
    const b = $("#askPaletteBackdrop");
    b.classList.add("open");
    $("#askPaletteInput").value = query;
    renderPalette(query);
  }
  function closePalette() { $("#askPaletteBackdrop")?.classList.remove("open"); }
  function renderPalette(query="") {
    const q = query.trim().toLowerCase();
    const list = $("#askPaletteList");
    if (!list) return;
    const found = paletteItems.filter(x => !q || x.label.toLowerCase().includes(q) || x.section.includes(q));
    list.innerHTML = found.slice(0,16).map((x,i) =>
      `<div class="ask-palette-item ${i===0?"selected":""}" data-palette-index="${i}">
        <span>${esc(x.label)}</span><small>${esc(x.section)}</small>
      </div>`).join("") ||
      '<div class="ask-palette-item"><span>No matching SEO tool</span><small>Try audit, keyword, rank or AI</small></div>';
    $$(".ask-palette-item[data-palette-index]", list).forEach(item => {
      item.addEventListener("click", () => {
        const idx = Number(item.dataset.paletteIndex);
        if (found[idx]) {
          closePalette();
          found[idx].button.click();
        }
      });
    });
  }
  function selectFirstPaletteItem() {
    const first = $(".ask-palette-item[data-palette-index]");
    first?.click();
  }
  function paletteKeydown(e) {
    const items = $$(".ask-palette-item[data-palette-index]");
    if (!items.length) return;
    let active = items.findIndex(x => x.classList.contains("selected"));
    if (e.key === "ArrowDown") {
      e.preventDefault(); active = (active + 1) % items.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); active = (active - 1 + items.length) % items.length;
    } else if (e.key === "Enter") {
      e.preventDefault(); items[Math.max(active,0)].click(); return;
    } else if (e.key === "Escape") { closePalette(); return; }
    items.forEach((x,i)=>x.classList.toggle("selected",i===active));
  }

  /* ---------- AskSEO-style lamp login ---------- */
  function installLampAuth() {
    // Keep authentication itself in the PostgreSQL controller in index.html.
    // This handler only controls the AskSEO-style visual gate.
    const screen = $("authScreen");
    const handle = $("pullHandle");
    if (!screen || !handle || handle.dataset.lampBound === "1") return;
    handle.dataset.lampBound = "1";

    const reveal = () => {
      if (screen.classList.contains("revealed")) return;
      screen.classList.add("lit");
      const prompt = $("lampPrompt");
      if (prompt) prompt.textContent = "Welcome to SEO Agent";
      window.setTimeout(() => {
        screen.classList.add("revealed");
        $("loginIdentifier")?.focus();
      }, 380);
    };

    handle.addEventListener("click", reveal);
    handle.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reveal(); }
    });
  }

  /* ---------- AI assistant ---------- */
  function installAiAssistant() {
    if ($("#askAiFab")) return;
    const fab = document.createElement("button");
    fab.id="askAiFab"; fab.type="button"; fab.title="Ask SEO Agent AI"; fab.textContent="✦";
    document.body.appendChild(fab);

    const panel=document.createElement("div");
    panel.id="askAiPanel";
    panel.innerHTML =
      '<div class="ask-ai-head"><div><strong>SEO Agent AI</strong><span>● Evidence grounded</span></div><button type="button" class="icon-btn" id="askAiClose">×</button></div>' +
      '<div class="ask-ai-msgs" id="askAiMsgs"><div class="ask-ai-msg bot">Ask me what your verified SEO data means. Add a URL and I will answer from the live evidence.</div></div>' +
      '<form class="ask-ai-form" id="askAiForm"><input id="askAiUrl" placeholder="https://example.com" required><input id="askAiQuestion" placeholder="Why is this page weak?" required><button class="button" type="submit">Ask</button></form>';
    document.body.appendChild(panel);

    fab.onclick=()=>panel.classList.toggle("open");
    $("#askAiClose").onclick=()=>panel.classList.remove("open");

    $("#askAiForm").addEventListener("submit", async e => {
      e.preventDefault();
      const url=$("#askAiUrl").value.trim();
      const question=$("#askAiQuestion").value.trim();
      const msgs=$("#askAiMsgs");
      if (!url || !question) return;
      msgs.insertAdjacentHTML("beforeend",`<div class="ask-ai-msg user">${esc(question)}</div>`);
      $("#askAiQuestion").value="";
      msgs.insertAdjacentHTML("beforeend",'<div class="ask-ai-msg bot" id="askAiTyping">Analyzing verified evidence…</div>');
      msgs.scrollTop=msgs.scrollHeight;
      try {
        const d=await api("/api/agent/ask",{url,question});
        const a=d.answer||{};
        const evidence=Array.isArray(a.evidence)?a.evidence.slice(0,3).join("\n• "):"";
        const actions=Array.isArray(a.actions)?a.actions.slice(0,3).map(x=>x.title||x.what_to_do).join("\n• "):"";
        const text=(a.answer||"The assistant returned no answer.")+
          (actions?`\n\nNext steps:\n• ${actions}`:"")+
          (evidence?`\n\nEvidence:\n• ${evidence}`:"");
        $("#askAiTyping")?.remove();
        msgs.insertAdjacentHTML("beforeend",`<div class="ask-ai-msg bot">${esc(text)}</div>`);
      } catch (error) {
        $("#askAiTyping")?.remove();
        msgs.insertAdjacentHTML("beforeend",`<div class="ask-ai-msg bot">AI request failed: ${esc(error.message)}</div>`);
      }
      msgs.scrollTop=msgs.scrollHeight;
    });

  }

  /* ---------- UX upgrades ---------- */
  function installQuickActions() {
    // Add a compact "AI assistant" hint to the dashboard without replacing
    // the existing evidence cards or metrics.
    const dashboard=document.querySelector("#view-dashboard");
    if (dashboard && !$("#askQuickActions",dashboard)) {
      const box=document.createElement("div");
      box.id="askQuickActions";
      box.className="panel";
      box.style.cssText="margin:16px 0;padding:0;overflow:hidden";
      box.innerHTML='<div class="panel-header"><strong>AskSEO-style quick actions</strong><span class="small-muted">Evidence-first shortcuts</span></div>' +
        '<div class="panel-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">' +
        '<button class="button" data-quick="audit">Run Site Audit</button>' +
        '<button class="button secondary" data-quick="keywords">Research Keywords</button>' +
        '<button class="button secondary" data-quick="rank-checker">Check Rankings</button>' +
        '<button class="button secondary" data-quick="ai-advisor">Open AI Advisor</button>' +
        '</div>';
      const anchor=dashboard.querySelector(".scanner") || dashboard.firstElementChild;
      anchor ? anchor.before(box) : dashboard.prepend(box);
      $$("[data-quick]",box).forEach(b=>b.onclick=()=>{
        const target=$(`.nav-item[data-section="${b.dataset.quick}"]`);
        target?.click();
      });
    }
  }

  function init() {
    installTopbar();
    ensurePalette();
    installLampAuth();
    installAiAssistant();
    installQuickActions();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
