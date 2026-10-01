/* SEO Zypp — luxe layer helpers (header hygiene + Pro suite niceties). Presentation only. */
(function () {
  "use strict";
  /* 1. One account chip only: drop any stray duplicate identity chip (e.g. from cached older scripts). */
  const dedupe = () => document.querySelectorAll(".header .ask-user-chip").forEach(n => n.remove());
  /* 2. Keep the header chip's tooltip in sync with the name/plan it shows. */
  const label = () => {
    const c = document.getElementById("agentUserChip"); if (!c) return;
    const n = document.getElementById("agentUserName")?.textContent || "", p = document.getElementById("agentUserPlan")?.textContent || "";
    c.title = [n, p].filter(Boolean).join(" · ");
  };
  /* 3. "[" collapses / expands the Private Suite sidebar while it is open. */
  document.addEventListener("keydown", e => {
    if (e.key !== "[" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    document.querySelector(".ps:not([hidden]) .ps-fold")?.click();
  });
  const tick = () => { dedupe(); label(); };
  document.addEventListener("DOMContentLoaded", tick);
  window.addEventListener("seo-agent-auth-changed", () => setTimeout(tick, 250));
  setInterval(tick, 2000);
  tick();
})();
