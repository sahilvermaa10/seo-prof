/* SEO Zypp Premium Plus: Toolkit (4 client-side tools) and the Advanced "coming soon" page.
   All tools run in the browser on user-supplied input: nothing here invents SEO metrics. */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

  function toast(msg) {
    let t = $("#ppToast"); if (!t) { t = document.createElement("div"); t.id = "ppToast"; t.className = "pp-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("on"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("on"), 1800);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); }
    catch (e) { const a = document.createElement("textarea"); a.value = text; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); toast("Copied to clipboard"); }
  }
  const head = (eyebrow, title, sub) => `<div class="section-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="muted-copy">${sub}</p></div></div>`;
  const meter = (pct, tone) => `<div class="pp-meter"><i class="${tone}" style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>`;

  /* ---------------- 1. SERP Snippet Lab ---------------- */
  const _cv = document.createElement("canvas").getContext("2d");
  const px = (txt, font) => { _cv.font = font; return Math.round(_cv.measureText(txt).width); };
  function snippetLab(root) {
    root.innerHTML = head("TOOLKIT · NO API NEEDED", "SERP Snippet Lab", "Preview how a title and meta description may appear in Google, with pixel-width checks. Widths are browser estimates; Google can still rewrite snippets.") + `
    <div class="pp-grid2">
      <div class="pp-box">
        <label>Page title<input id="slT" maxlength="120" placeholder="Best Running Shoes 2026: Tested & Ranked | YourBrand"/></label>
        <div class="pp-count" id="slTc"></div><div id="slTm"></div>
        <label>Meta description<textarea id="slD" rows="4" maxlength="400" placeholder="Describe the page in one or two sentences that earn the click."></textarea></label>
        <div class="pp-count" id="slDc"></div><div id="slDm"></div>
        <label>Page URL<input id="slU" placeholder="https://example.com/running-shoes/"/></label>
      </div>
      <div class="pp-box"><div class="pp-tabs" id="slTabs"><button class="on" data-m="d">Desktop</button><button data-m="m">Mobile</button></div><div id="slPrev"></div></div>
    </div>`;
    const T = $("#slT", root), D = $("#slD", root), U = $("#slU", root); let mode = "d";
    function draw() {
      const t = T.value.trim(), d = D.value.trim(), u = U.value.trim();
      const tw = px(t, "20px Arial"), dw = px(d, "14px Arial"), tMax = 580, dMax = mode === "d" ? 920 : 680;
      $("#slTc", root).textContent = `${t.length} chars · ~${tw}px of ${tMax}px`; $("#slDc", root).textContent = `${d.length} chars · ~${dw}px of ${dMax}px`;
      $("#slTm", root).innerHTML = meter(tw / tMax * 100, tw > tMax ? "bad" : tw < 300 && t ? "warn" : "ok");
      $("#slDm", root).innerHTML = meter(dw / dMax * 100, dw > dMax ? "bad" : dw < 400 && d ? "warn" : "ok");
      let host = "example.com", path = "";
      try { const x = new URL(/^https?:/.test(u) ? u : "https://" + (u || "example.com")); host = x.hostname.replace(/^www\./, ""); path = x.pathname.replace(/\/$/, "").split("/").filter(Boolean).join(" › "); } catch (e) {}
      const cut = (s, max, f) => { if (px(s, f) <= max) return s; while (s.length && px(s + "…", f) > max) s = s.slice(0, -1); return s.trimEnd() + "…"; };
      const tt = cut(t || "Your page title appears here", tMax, "20px Arial"), dd = cut(d || "Your meta description appears here. Write a clear, specific summary of the page.", dMax * (mode === "d" ? 2 : 3) / (mode === "d" ? 2 : 2.2), "14px Arial");
      $("#slPrev", root).innerHTML = `<div class="pp-serp ${mode}"><div class="pp-serp-site"><span class="fav">${esc(host[0] || "e").toUpperCase()}</span><div><b>${esc(host)}</b><small>${esc(host)}${path ? " › " + esc(path) : ""}</small></div></div><div class="pp-serp-t">${esc(tt)}</div><div class="pp-serp-d">${esc(dd)}</div></div>
        <ul class="pp-notes">${[!t && "Add a title.", t && tw > tMax && "Title is likely truncated in desktop results.", t && tw < 300 && "Title is short; consider using more of the available width.", !d && "Add a meta description.", d && dw > dMax * 2 && "Description may be truncated.", d && d.length < 70 && "Description is very short."].filter(Boolean).map(x => `<li>${x}</li>`).join("") || "<li class='okk'>No length issues detected.</li>"}</ul>`;
    }
    [T, D, U].forEach(e => e.addEventListener("input", draw));
    $$("#slTabs button", root).forEach(b => b.onclick = () => { mode = b.dataset.m; $$("#slTabs button", root).forEach(x => x.classList.toggle("on", x === b)); draw(); });
    draw();
  }

  /* ---------------- 2. Schema Lab ---------------- */
  const SCHEMAS = {
    Article: { f: [["headline", "Headline"], ["author", "Author name"], ["datePublished", "Date published", "2026-10-01"], ["image", "Image URL"], ["url", "Page URL"]], b: v => ({ "@type": "Article", headline: v.headline, author: { "@type": "Person", name: v.author }, datePublished: v.datePublished, image: v.image, mainEntityOfPage: v.url }) },
    FAQPage: { f: [["faq", "Questions (one per line: Question | Answer)", "", "area"]], b: v => ({ "@type": "FAQPage", mainEntity: (v.faq || "").split("\n").map(l => l.split("|")).filter(p => p[0] && p[0].trim() && p[1] && p[1].trim()).map(p => ({ "@type": "Question", name: p[0].trim(), acceptedAnswer: { "@type": "Answer", text: p.slice(1).join("|").trim() } })) }) },
    LocalBusiness: { f: [["name", "Business name"], ["url", "Website"], ["telephone", "Phone"], ["streetAddress", "Street"], ["addressLocality", "City"], ["addressRegion", "State / region"], ["postalCode", "Postal code"], ["addressCountry", "Country code", "IN"]], b: v => ({ "@type": "LocalBusiness", name: v.name, url: v.url, telephone: v.telephone, address: { "@type": "PostalAddress", streetAddress: v.streetAddress, addressLocality: v.addressLocality, addressRegion: v.addressRegion, postalCode: v.postalCode, addressCountry: v.addressCountry } }) },
    Product: { f: [["name", "Product name"], ["description", "Description"], ["image", "Image URL"], ["brand", "Brand"], ["price", "Price"], ["priceCurrency", "Currency", "INR"]], b: v => ({ "@type": "Product", name: v.name, description: v.description, image: v.image, brand: v.brand && { "@type": "Brand", name: v.brand }, offers: v.price && { "@type": "Offer", price: v.price, priceCurrency: v.priceCurrency, availability: "https://schema.org/InStock" } }) },
    Organization: { f: [["name", "Organization name"], ["url", "Website"], ["logo", "Logo URL"], ["sameAs", "Profile URLs (comma separated)"]], b: v => ({ "@type": "Organization", name: v.name, url: v.url, logo: v.logo, sameAs: (v.sameAs || "").split(",").map(s => s.trim()).filter(Boolean) }) },
  };
  const prune = o => Array.isArray(o) ? o.map(prune).filter(x => x !== undefined) : (o && typeof o === "object") ? (r => Object.keys(r).length ? r : undefined)(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, prune(v)]).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)))) : (o === "" || o == null ? undefined : o);
  function schemaLab(root) {
    root.innerHTML = head("TOOLKIT · NO API NEEDED", "Schema Lab", "Generate clean JSON-LD structured data. Only fields you fill in are output. Validate in Google's Rich Results Test before shipping.") + `
    <div class="pp-grid2"><div class="pp-box"><label>Schema type<select id="scT">${Object.keys(SCHEMAS).map(k => `<option>${k}</option>`).join("")}</select></label><div id="scF"></div></div>
    <div class="pp-box"><div class="pp-row"><b>JSON-LD output</b><button class="pp-btn" id="scC" type="button">Copy</button></div><pre class="pp-code" id="scO"></pre></div></div>`;
    const sel = $("#scT", root), box = $("#scF", root), out = $("#scO", root); let text = "";
    const vals = () => Object.fromEntries($$("[data-k]", box).map(e => [e.dataset.k, e.value.trim()]));
    function render() { const s = SCHEMAS[sel.value]; box.innerHTML = s.f.map(([k, l, ph, kind]) => `<label>${l}${kind === "area" ? `<textarea data-k="${k}" rows="6" placeholder="${esc(ph || "")}"></textarea>` : `<input data-k="${k}" placeholder="${esc(ph || "")}"/>`}</label>`).join(""); $$("[data-k]", box).forEach(e => e.oninput = gen); gen(); }
    function gen() { const o = prune({ "@context": "https://schema.org", ...SCHEMAS[sel.value].b(vals()) }); const body = o && Object.keys(o).length > 2 ? JSON.stringify(o, null, 2) : JSON.stringify({ "@context": "https://schema.org", "@type": sel.value }, null, 2); text = `<script type="application/ld+json">\n${body}\n<\/script>`; out.textContent = text; }
    sel.onchange = render; $("#scC", root).onclick = () => copy(text); render();
  }

  /* ---------------- 3. Content Lab ---------------- */
  const STOP = new Set("a an and are as at be but by for from has have he her his i in is it its of on or our she that the their them they this to was we were will with you your not can all more than also into about which when what who how there been if so do does did".split(" "));
  const syl = w => { w = w.toLowerCase().replace(/[^a-z]/g, ""); if (!w) return 0; if (w.length <= 3) return 1; w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, ""); return Math.max(1, (w.match(/[aeiouy]{1,2}/g) || []).length); };
  function textLab(root) {
    root.innerHTML = head("TOOLKIT · NO API NEEDED", "Content Lab", "Paste a draft to measure length, readability and keyword usage. Deterministic calculations on your text only.") + `
    <div class="pp-grid2"><div class="pp-box"><label>Target keyword (optional)<input id="tlK" placeholder="running shoes"/></label><label>Your content<textarea id="tlT" rows="14" placeholder="Paste your article or page copy here…"></textarea></label></div>
    <div class="pp-box" id="tlR"></div></div>`;
    const K = $("#tlK", root), Tx = $("#tlT", root), R = $("#tlR", root);
    function run() {
      const txt = Tx.value.trim(); if (!txt) { R.innerHTML = `<div class="pp-empty">Results appear as you type.</div>`; return; }
      const words = txt.match(/[\p{L}\p{N}'’-]+/gu) || [], n = words.length, sents = txt.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
      const sy = words.reduce((a, w) => a + syl(w), 0), fre = n ? 206.835 - 1.015 * (n / Math.max(1, sents.length)) - 84.6 * (sy / n) : 0;
      const grade = fre >= 70 ? "Easy" : fre >= 50 ? "Fairly readable" : fre >= 30 ? "Difficult" : "Very difficult";
      const kw = K.value.trim().toLowerCase(); let kc = 0; if (kw) { const lt = txt.toLowerCase(); let i = 0; while ((i = lt.indexOf(kw, i)) !== -1) { kc++; i += kw.length; } }
      const dens = n && kw ? kc * kw.split(/\s+/).length / n * 100 : 0;
      const freq = {}; words.map(w => w.toLowerCase().replace(/^['’-]+|['’-]+$/g, "")).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).forEach(w => freq[w] = (freq[w] || 0) + 1);
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8), long = sents.filter(s => (s.match(/\S+/g) || []).length > 25).length;
      const stat = (v, l) => `<div class="pp-stat"><b>${v}</b><small>${l}</small></div>`;
      R.innerHTML = `<div class="pp-stats">${stat(n.toLocaleString(), "words")}${stat(sents.length, "sentences")}${stat(Math.max(1, Math.round(n / 220)) + " min", "read time")}${stat(fre.toFixed(0), "Flesch ease")}</div>
        <p class="pp-note"><b>Readability:</b> ${grade}. ${long ? `${long} sentence${long > 1 ? "s run" : " runs"} past 25 words.` : "No overly long sentences."}</p>
        ${kw ? `<p class="pp-note"><b>“${esc(kw)}”</b> appears ${kc}× (${dens.toFixed(2)}% of words). ${dens > 3 ? "That is high; check it still reads naturally." : kc === 0 ? "Not found in the text." : "Looks natural."}</p>` : ""}
        <div class="pp-row"><b>Most-used terms</b></div><div class="pp-chips">${top.map(([w, c]) => `<span>${esc(w)} <i>${c}</i></span>`).join("") || "<small>Not enough text.</small>"}</div>`;
    }
    [K, Tx].forEach(e => e.addEventListener("input", run)); run();
  }

  /* ---------------- 4. Tech Files ---------------- */
  function techFiles(root) {
    root.innerHTML = head("TOOLKIT · NO API NEEDED", "Tech Files", "Generate robots.txt, sitemap.xml and redirect rules, with safety checks before you deploy.") + `
    <div class="pp-tabs" id="tfTabs"><button class="on" data-m="robots">robots.txt</button><button data-m="sitemap">sitemap.xml</button><button data-m="redirect">Redirects</button></div>
    <div class="pp-grid2"><div class="pp-box" id="tfIn"></div><div class="pp-box"><div class="pp-row"><b id="tfName">robots.txt</b><button class="pp-btn" id="tfC" type="button">Copy</button></div><div id="tfW"></div><pre class="pp-code" id="tfO"></pre></div></div>`;
    let mode = "robots", text = ""; const In = $("#tfIn", root), O = $("#tfO", root), W = $("#tfW", root);
    const M = {
      robots: { name: "robots.txt", ui: `<label>Preset<select id="tfP"><option value="allow">Allow all crawlers</option><option value="wp">WordPress-style</option><option value="block">Block everything (staging)</option></select></label><label>Extra Disallow paths (one per line)<textarea id="tfX" rows="5" placeholder="/cart/&#10;/search"></textarea></label><label>Sitemap URL<input id="tfS" placeholder="https://example.com/sitemap.xml"/></label>`,
        gen() { const p = $("#tfP").value, ex = $("#tfX").value.split("\n").map(s => s.trim()).filter(Boolean), s = $("#tfS").value.trim(); const dis = p === "block" ? ["/"] : [...(p === "wp" ? ["/wp-admin/"] : []), ...ex]; const l = ["User-agent: *", ...(dis.length ? dis.map(d => "Disallow: " + (d[0] === "/" ? d : "/" + d)) : ["Disallow:"]), ...(p === "wp" ? ["Allow: /wp-admin/admin-ajax.php"] : []), ...(s ? ["", "Sitemap: " + s] : [])]; return { text: l.join("\n") + "\n", warn: [p === "block" && "This blocks all crawling. Never deploy it on a live site you want indexed.", s && !/^https?:\/\//.test(s) && "Sitemap should be a full absolute URL."].filter(Boolean) }; } },
      sitemap: { name: "sitemap.xml", ui: `<label>URLs (one per line)<textarea id="tfU" rows="9" placeholder="https://example.com/&#10;https://example.com/about"></textarea></label><label class="pp-check"><input type="checkbox" id="tfL" checked/> Include today's date as lastmod</label>`,
        gen() { const raw = $("#tfU").value.split("\n").map(s => s.trim()).filter(Boolean), ok = [...new Set(raw.filter(u => /^https?:\/\/[^\s]+$/.test(u)))], bad = raw.length - raw.filter(u => /^https?:\/\/[^\s]+$/.test(u)).length, d = new Date().toISOString().slice(0, 10), lm = $("#tfL").checked; const x = e => e.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); return { text: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${ok.map(u => `  <url>\n    <loc>${x(u)}</loc>${lm ? `\n    <lastmod>${d}</lastmod>` : ""}\n  </url>`).join("\n")}\n</urlset>\n`, warn: [bad && `${bad} line(s) skipped: URLs must start with http:// or https://.`, ok.length > 50000 && "Sitemaps are limited to 50,000 URLs; split into several files."].filter(Boolean) }; } },
      redirect: { name: "redirect rules", ui: `<label>Old → New (one pair per line, separated by a space)<textarea id="tfR" rows="9" placeholder="/old-page /new-page&#10;/blog/a https://example.com/blog/b"></textarea></label><label>Format<select id="tfF"><option value="apache">Apache (.htaccess)</option><option value="nginx">Nginx</option></select></label>`,
        gen() { const pairs = $("#tfR").value.split("\n").map(l => l.trim().split(/\s+/)).filter(p => p.length >= 2 && p[0][0] === "/"), olds = new Set(pairs.map(p => p[0])); const w = [], rx = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); pairs.forEach(([a, b]) => { if (a === b) w.push(`${a} redirects to itself (loop).`); else if (olds.has(b)) w.push(`${a} → ${b} is a chain; point it to the final URL.`); }); const f = $("#tfF").value; return { text: pairs.map(([a, b]) => f === "apache" ? `Redirect 301 ${a} ${b}` : `rewrite ^${rx(a)}$ ${b} permanent;`).join("\n") + (pairs.length ? "\n" : ""), warn: w }; } },
    };
    function render() { In.innerHTML = M[mode].ui; $("#tfName", root).textContent = M[mode].name; $$("input,select,textarea", In).forEach(e => { e.oninput = e.onchange = gen; }); gen(); }
    function gen() { const r = M[mode].gen(); text = r.text; O.textContent = text || "Fill in the form to generate output."; W.innerHTML = r.warn.map(x => `<div class="pp-warn">⚠ ${esc(x)}</div>`).join(""); }
    $$("#tfTabs button", root).forEach(b => b.onclick = () => { mode = b.dataset.m; $$("#tfTabs button", root).forEach(x => x.classList.toggle("on", x === b)); render(); });
    $("#tfC", root).onclick = () => text && copy(text); render();
  }

  /* ---------------- 5. Advanced (coming soon) ---------------- */
  /* Edit this list to match your real roadmap. Stage labels are plain text, not measured progress. */
  const ROADMAP = [
    { id: "forecast", ic: "📈", name: "Rank Forecasting", stage: "In design", d: "Project likely ranking movement from your own tracked history and planned fixes." },
    { id: "alerts", ic: "🔔", name: "Always-on Monitoring", stage: "In design", d: "Scheduled re-crawls with email and Slack alerts when titles, status codes or indexability change." },
    { id: "radar", ic: "🎯", name: "Competitor Gap Radar", stage: "Planned", d: "Side-by-side topic and keyword coverage against competitors you choose." },
    { id: "briefs", ic: "🧠", name: "Bulk Content Briefs", stage: "Planned", d: "Generate evidence-backed briefs for dozens of pages in one run." },
    { id: "white", ic: "🏷️", name: "White-label Reports", stage: "Planned", d: "Client-ready PDF reports with your logo, colours and domain." },
    { id: "links", ic: "🔗", name: "Link Prospecting Engine", stage: "Planned", d: "Find and prioritise outreach targets from verified, crawlable sources." },
  ];
  function advanced(root) {
    const mine = new Set(store.get("ppInterest", []));
    root.innerHTML = `<div class="pp-adv"><div class="pp-orb"><i></i><i></i><i></i><span>⚡</span></div>
      <div class="pp-pill">COMING SOON</div><h1 class="pp-title">Advanced Suite</h1>
      <p class="pp-lead">A new tier of automation and forecasting is being built. Nothing below is live yet. Tell us what you want first and it shapes the order we ship in.</p>
      <div class="pp-road" id="advG">${ROADMAP.map(r => `<div class="pp-rm ${mine.has(r.id) ? "voted" : ""}" data-id="${r.id}"><div class="pp-lock">🔒</div><div class="pp-ic">${r.ic}</div><span class="pp-stage">${r.stage}</span><h3>${r.name}</h3><p>${r.d}</p><button type="button" class="pp-btn ghost">${mine.has(r.id) ? "✓ On your wishlist" : "+ I want this"}</button></div>`).join("")}</div>
      <p class="pp-fine" id="advF"></p></div>`;
    const fine = () => { const n = store.get("ppInterest", []).length; $("#advF", root).textContent = n ? `${n} of ${ROADMAP.length} saved on this device. Tap again to remove.` : "Wishlist is saved on this device only."; };
    root.addEventListener("click", e => { const b = e.target.closest(".pp-rm button"); if (!b) return; const c = b.closest(".pp-rm"), s = new Set(store.get("ppInterest", [])); s.has(c.dataset.id) ? s.delete(c.dataset.id) : s.add(c.dataset.id); store.set("ppInterest", [...s]); c.classList.toggle("voted", s.has(c.dataset.id)); b.textContent = s.has(c.dataset.id) ? "✓ On your wishlist" : "+ I want this"; fine(); if (s.has(c.dataset.id)) toast("Saved to your wishlist"); });
    fine();
  }

  const MAP = { "view-snippet-lab": snippetLab, "view-schema-lab": schemaLab, "view-text-lab": textLab, "view-tech-files": techFiles, "view-advanced": advanced };
  const init = () => { Object.entries(MAP).forEach(([id, fn]) => { const r = document.getElementById(id); if (r && !r.dataset.ppReady) { r.dataset.ppReady = "1"; try { fn(r); } catch (e) { console.warn("Premium Plus:", id, e); } } }); };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
