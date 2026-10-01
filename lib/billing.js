/* Free-trial gating + paid plans.
   Each pro tool group gives every user FREE_TRIALS runs; after that the group is locked
   (HTTP 402) until the user has an active paid plan. Failed runs (status >= 400) are refunded. */
const crypto = require("crypto");
const FREE_TRIALS = Number(process.env.FREE_TRIALS) || 5;

const GROUPS = {
  audit:       { label: "Audit & Technical",   re: /^(analyze|site-audit|technical-check|crawl|seo-actions|verify-url|agent\/(dashboard|action-center))$/ },
  keywords:    { label: "Keyword Research",    re: /^(keywords|keyword-opportunity|keyword-verify|agent\/(keyword-gap|keyword-map))$/ },
  content:     { label: "Content Studio",      re: /^(content|content-gap|content-plan|agent\/(content-optimizer|content-refresh|content-decay))$/ },
  rankings:    { label: "Rankings & SERP",     re: /^(rank-check|rank-track|top-rankings|agent\/rank-history)$/ },
  competitors: { label: "Competitors & Links", re: /^(competitors|backlink-opportunities|internal-link-opportunities|domain-authority)$/ },
  performance: { label: "Performance & Trends",re: /^(pagespeed|trends)$/ },
  ai:          { label: "AI Assistant",        re: /^(ai-recommendations|seo-intelligence|agent\/(ask|ai-advisor|ai-strategy|growth-os))$/ },
  monitoring:  { label: "Monitoring & Reports",re: /^(monitor-snapshot|agent\/(monitor\/run|report-pdf|change-detect)|export-pdf)$/ },
};
const PLANS = {
  pro_monthly: { label: "Pro Monthly", amountInr: Number(process.env.PRICE_MONTHLY_INR) || 99,   days: 30 },
  pro_yearly:  { label: "Pro Yearly",  amountInr: Number(process.env.PRICE_YEARLY_INR)  || 4999, days: 365 },
};
const BONUS_DAYS = 60; // new users (still on the 30-day trial) who buy get 2 free months on top
const groupFor = p => { const k = String(p).replace(/^\/+|\/+$/g, ""); for (const [id, g] of Object.entries(GROUPS)) if (g.re.test(k)) return id; return null; };

function install(app, { query, currentSession }) {
  const ready = query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS feature_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, used INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, feature));
    CREATE TABLE IF NOT EXISTS payments (
      order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL, amount_inr INT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
      payment_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    UPDATE users SET plan='trial', plan_expires_at=NOW() + INTERVAL '30 days'
      WHERE role <> 'admin' AND (plan IS NULL OR plan='free') AND plan_expires_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = users.id);
  `).catch(e => console.error("billing schema:", e.message));

  const isPaid = u => u.role === "admin" || (u.plan && u.plan !== "free" && u.plan_expires_at && new Date(u.plan_expires_at) > new Date());
  async function loadUser(req) {
    const s = await currentSession(req); if (!s) return null;
    const r = await query(`SELECT id, role, plan, plan_expires_at FROM users WHERE id=$1`, [s.user_id]);
    return r.rows[0] || null;
  }
  async function summary(u) {
    const r = await query(`SELECT feature, used FROM feature_usage WHERE user_id=$1`, [u.id]);
    const used = Object.fromEntries(r.rows.map(x => [x.feature, x.used]));
    const paid = isPaid(u);
    const trial = paid && u.plan === "trial";
    return { paid, trial, bonusEligible: trial, bonusDays: BONUS_DAYS, plan: paid ? u.plan : "free", expiresAt: u.plan_expires_at, limit: FREE_TRIALS,
      groups: Object.fromEntries(Object.entries(GROUPS).map(([id, g]) => [id, { label: g.label, used: used[id] || 0, left: paid ? null : Math.max(0, FREE_TRIALS - (used[id] || 0)) }])) };
  }

  // Gate + meter. Runs before any route/proxy handler.
  app.use("/api", async (req, res, next) => {
    if (req.method !== "POST") return next();
    const group = groupFor(req.path); if (!group) return next();
    try {
      await ready;
      const u = await loadUser(req);
      if (!u) return res.status(401).json({ success: false, error: "Please sign in to use this tool." });
      if (isPaid(u)) return next();
      // atomic increment: only succeeds while under the limit
      const r = await query(`
        INSERT INTO feature_usage (user_id, feature, used) VALUES ($1,$2,1)
        ON CONFLICT (user_id, feature) DO UPDATE SET used = feature_usage.used + 1, updated_at = NOW()
        WHERE feature_usage.used < $3 RETURNING used`, [u.id, group, FREE_TRIALS]);
      if (!r.rows.length) return res.status(402).json({ success: false, code: "TRIAL_EXHAUSTED", group, label: GROUPS[group].label,
        limit: FREE_TRIALS, error: `Your ${FREE_TRIALS} free ${GROUPS[group].label} runs are used. Upgrade to Pro to keep going.` });
      res.set("X-Trials-Left", String(FREE_TRIALS - r.rows[0].used)).set("X-Trial-Group", group);
      res.on("finish", () => { if (res.statusCode >= 400)   // refund failed runs
        query(`UPDATE feature_usage SET used = GREATEST(used-1,0) WHERE user_id=$1 AND feature=$2`, [u.id, group]).catch(() => {}); });
      next();
    } catch (e) { console.error("billing gate:", e.message); res.status(503).json({ success: false, error: "Usage service unavailable. Try again shortly." }); }
  });

  app.get("/api/billing/status", async (req, res) => {
    try { await ready; const u = await loadUser(req); if (!u) return res.status(401).json({ success: false });
      res.json({ success: true, ...(await summary(u)), plans: PLANS, checkout: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) });
    } catch (e) { res.status(503).json({ success: false, error: e.message }); }
  });

  // Razorpay Standard Checkout (set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). Amount is decided server-side.
  app.post("/api/billing/checkout", async (req, res) => {
    try {
      await ready; const u = await loadUser(req); if (!u) return res.status(401).json({ success: false, error: "Sign in first." });
      const plan = PLANS[req.body?.plan]; if (!plan) return res.status(400).json({ success: false, error: "Unknown plan." });
      const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
      if (!id || !secret) return res.status(501).json({ success: false, error: "Payments are not configured yet. Ask the admin to set Razorpay keys." });
      const r = await fetch("https://api.razorpay.com/v1/orders", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") },
        body: JSON.stringify({ amount: plan.amountInr * 100, currency: "INR", receipt: `u${u.id}`.slice(0, 40) }), signal: AbortSignal.timeout(15000) });
      const o = await r.json(); if (!r.ok) return res.status(502).json({ success: false, error: "Payment provider error." });
      await query(`INSERT INTO payments (order_id,user_id,plan,amount_inr) VALUES ($1,$2,$3,$4)`, [o.id, u.id, req.body.plan, plan.amountInr]);
      res.json({ success: true, keyId: id, orderId: o.id, amount: o.amount, currency: o.currency, plan: plan.label });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post("/api/billing/verify", async (req, res) => {
    try {
      await ready; const u = await loadUser(req); if (!u) return res.status(401).json({ success: false });
      const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body || {};
      const expect = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "").update(`${oid}|${pid}`).digest("hex");
      const ok = sig && expect.length === String(sig).length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(sig)));
      if (!ok) return res.status(400).json({ success: false, error: "Payment signature invalid." });
      const p = (await query(`SELECT plan FROM payments WHERE order_id=$1 AND user_id=$2 AND status='created'`, [oid, u.id])).rows[0];
      if (!p) return res.status(400).json({ success: false, error: "Order not found or already used." });
      await query(`UPDATE payments SET status='paid', payment_id=$2 WHERE order_id=$1`, [oid, pid]);
      const bonus = (u.plan === "trial" && isPaid(u)) ? BONUS_DAYS : 0; // welcome bonus: +2 months for buying during the trial
      await query(`UPDATE users SET plan=$2, plan_expires_at = GREATEST(COALESCE(plan_expires_at,NOW()),NOW()) + (($3::int + $4::int) * INTERVAL '1 day') WHERE id=$1`, [u.id, p.plan, PLANS[p.plan].days, bonus]);
      res.json({ success: true, ...(await summary(await loadUser(req))) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}
module.exports = { install, GROUPS, FREE_TRIALS, groupFor };
