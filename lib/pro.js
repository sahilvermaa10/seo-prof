/* Pro Studio: one Pro dashboard per tool group. Runs every sub-check of the group server-side in parallel,
   metered per user+group. Adds a short-lived per-user result cache and in-flight deduplication so repeat
   views return immediately without repeating expensive provider work. */
const PRO_RUNS = Number(process.env.PRO_RUNS) || 3;
const PRO_CACHE_TTL = Number(process.env.PRO_CACHE_TTL_MS) || 45000;
const PRO_CACHE_MAX = 80;
const PRO_CACHE = new Map();
const PRO_INFLIGHT = new Map();
const B = (b, ...k) => Object.fromEntries(k.filter(x => b[x] !== undefined && b[x] !== "").map(x => [x, b[x]]));

const HUBS = {
  audit: { label: "Site Health", need: ["url"], calls: [
    ["audit", "site-audit", b => ({ url: b.url })], ["actions", "seo-actions", b => ({ url: b.url })], ["evidence", "verify-url", b => ({ url: b.url })] ] },
  keywords: { label: "Keywords", need: ["url"], calls: [
    ["keywords", "keywords", b => ({ url: b.url, seed: b.keyword || "", country: b.country || "us" })],
    ["opportunity", "keyword-opportunity", b => ({ url: b.url, keyword: b.keyword || "", country: b.country || "us" })],
    ["gap", "agent/keyword-gap", b => ({ url: b.url, country: b.country || "us", keywords: b.keyword ? [b.keyword] : [] })] ] },
  content: { label: "Content Studio", need: ["url"], calls: [
    ["gap", "content-gap", b => ({ url: b.url, topic: b.keyword || "" })], ["brief", "content", b => ({ url: b.url, topic: b.keyword || "" })],
    ["optimizer", "agent/content-optimizer", b => ({ url: b.url, keyword: b.keyword || "" })] ] },
  rankings: { label: "Rankings", need: ["keyword"], calls: [
    ["rank", "rank-check", b => B(b, "url", "keyword", "country"), b => !!b.url], ["top", "top-rankings", b => B(b, "keyword", "country"), b => !b.url] ] },
  competitors: { label: "Competitors & Links", need: ["url"], calls: [
    ["competitors", "competitors", b => B(b, "url", "keyword", "country")], ["backlinks", "backlink-opportunities", b => ({ url: b.url })],
    ["internal", "internal-link-opportunities", b => ({ url: b.url, keyword: b.keyword || "" })] ] },
  performance: { label: "Speed & Trends", need: ["url"], calls: [
    ["speed", "pagespeed", b => ({ url: b.url })], ["trends", "trends", b => ({ keyword: b.keyword, topic: b.keyword, country: b.country }), b => !!b.keyword] ] },
  ai: { label: "AI Studio", need: ["url"], calls: [
    ["advisor", "agent/ai-advisor", b => ({ url: b.url })], ["growth", "agent/growth-os", b => ({ url: b.url })], ["intel", "seo-intelligence", b => ({ url: b.url })] ] },
  monitoring: { label: "Monitor & Reports", need: ["url"], calls: [
    ["snapshot", "monitor-snapshot", b => ({ url: b.url })], ["center", "agent/action-center", b => ({ url: b.url })], ["dash", "agent/dashboard", b => ({ url: b.url })] ] },
};

function install(app, { query, currentSession }) {
  const cacheKey = (userId, hubId, b) => JSON.stringify([userId, hubId, b.url, b.keyword, b.country]);
  const getCached = key => {
    const item = PRO_CACHE.get(key);
    if (!item) return null;
    if (Date.now() - item.at > PRO_CACHE_TTL) { PRO_CACHE.delete(key); return null; }
    return item.data;
  };
  const setCached = (key, data) => {
    PRO_CACHE.set(key, { at: Date.now(), data });
    while (PRO_CACHE.size > PRO_CACHE_MAX) PRO_CACHE.delete(PRO_CACHE.keys().next().value);
  };
  const ready = query(`CREATE TABLE IF NOT EXISTS pro_usage (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, hub TEXT NOT NULL,
    used INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, hub))`)
    .catch(e => console.error("pro schema:", e.message));
  const loadUser = async req => { const s = await currentSession(req); if (!s) return null;
    return (await query(`SELECT id, role, plan, plan_expires_at FROM users WHERE id=$1`, [s.user_id])).rows[0] || null; };
  const unlimited = u => u.role === "admin" || (u.plan && !["free", "trial"].includes(u.plan) && u.plan_expires_at && new Date(u.plan_expires_at) > new Date());

  app.get("/api/pro/status", async (req, res) => {
    try { await ready; const u = await loadUser(req); if (!u) return res.status(401).json({ success: false });
      const used = Object.fromEntries((await query(`SELECT hub, used FROM pro_usage WHERE user_id=$1`, [u.id])).rows.map(r => [r.hub, r.used]));
      const un = unlimited(u);
      res.json({ success: true, unlimited: un, limit: PRO_RUNS, cacheTtlMs: PRO_CACHE_TTL, hubs: Object.fromEntries(Object.entries(HUBS).map(([id, h]) =>
        [id, { label: h.label, need: h.need, left: un ? null : Math.max(0, PRO_RUNS - (used[id] || 0)) }])) });
    } catch (e) { res.status(503).json({ success: false, error: "Pro status unavailable." }); }
  });

  app.post("/api/pro/run", async (req, res) => {
    let u, hubId;
    try {
      await ready;
      u = await loadUser(req);
      if (!u) return res.status(401).json({ success: false, error: "Please sign in." });
      hubId = String(req.body?.hub || "");
      const hub = HUBS[hubId];
      if (!hub) return res.status(400).json({ success: false, error: "Unknown Pro section." });
      const b = { url: String(req.body?.url || "").trim(), keyword: String(req.body?.keyword || "").trim().slice(0, 120), country: String(req.body?.country || "us").slice(0, 4) };
      if (hub.need.includes("url") && !b.url) return res.status(400).json({ success: false, error: "Enter your website URL." });
      if (b.url && !/^https?:\/\//i.test(b.url)) b.url = "https://" + b.url;
      if (hub.need.includes("keyword") && !b.keyword) return res.status(400).json({ success: false, error: "Enter a keyword." });

      const ckey = cacheKey(u.id, hubId, b);
      const cached = getCached(ckey);
      if (cached) {
        res.set("X-Pro-Mode", "cache");
        return res.json({ ...cached, cached: true, ms: 0 });
      }
      const shared = PRO_INFLIGHT.get(ckey);
      if (shared) {
        const result = await shared;
        res.set("X-Pro-Mode", "shared");
        return res.json({ ...result, shared: true, ms: 0 });
      }

      let claimed = false;
      const execute = (async () => {
        try {
          if (!unlimited(u)) {
            const r = await query(`INSERT INTO pro_usage (user_id, hub, used) VALUES ($1,$2,1)
              ON CONFLICT (user_id, hub) DO UPDATE SET used = pro_usage.used + 1, updated_at = NOW()
              WHERE pro_usage.used < $3 RETURNING used`, [u.id, hubId, PRO_RUNS]);
            if (!r.rows.length) throw Object.assign(new Error(`You've used all ${PRO_RUNS} Pro runs for ${hub.label}. Upgrade to keep going — new buyers get 2 extra months free.`), { statusCode: 402, code: "PRO_LIMIT" });
            claimed = true;
          }

          const base = `http://127.0.0.1:${req.socket.localPort}/api/`, started = Date.now();
          const jobs = hub.calls.filter(c => !c[3] || c[3](b)).map(async ([id, ep, build]) => {
            try {
              const r = await fetch(base + ep, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "", Cookie: req.headers.cookie || "" },
                body: JSON.stringify(build(b)),
                signal: AbortSignal.timeout(150000)
              });
              const d = await r.json().catch(() => ({}));
              return [id, r.ok && d.success !== false ? { ok: true, data: d } : { ok: false, error: d.error || d.detail || `Request failed (${r.status})` }];
            } catch (e) {
              return [id, { ok: false, error: e.name === "TimeoutError" ? "Timed out — try again." : e.message }];
            }
          });
          const sections = Object.fromEntries(await Promise.all(jobs));
          if (claimed && !Object.values(sections).some(s => s.ok)) {
            await query(`UPDATE pro_usage SET used = GREATEST(used-1,0) WHERE user_id=$1 AND hub=$2`, [u.id, hubId]).catch(() => {});
            claimed = false;
          }
          const result = { success: true, hub: hubId, label: hub.label, input: b, ms: Date.now() - started, sections };
          if (Object.values(sections).some(s => s.ok)) setCached(ckey, result);
          return result;
        } catch (e) {
          if (claimed) query(`UPDATE pro_usage SET used = GREATEST(used-1,0) WHERE user_id=$1 AND hub=$2`, [u.id, hubId]).catch(() => {});
          throw e;
        }
      })();
      PRO_INFLIGHT.set(ckey, execute);
      try {
        res.set("X-Pro-Mode", "parallel");
        res.set("X-Pro-Cache-TTL", String(PRO_CACHE_TTL));
        res.json(await execute);
      } catch (e) {
        res.status(e.statusCode || 500).json({ success: false, code: e.code, error: e.message });
      } finally {
        PRO_INFLIGHT.delete(ckey);
      }
    } catch (e) {
      if (res.headersSent) return;
      res.status(e.statusCode || 500).json({ success: false, code: e.code, error: e.message });
    }
  });
}
module.exports = { install, HUBS, PRO_RUNS };
