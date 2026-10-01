const fs = require("fs"), path = require("path"), assert = require("assert");
const pub = f => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
const html = pub("index.html"), shell = pub("zypp-shell.js"), js = pub("zypp-premium-plus.js"), css = pub("zypp-premium-plus.css");
const ids = ["snippet-lab", "schema-lab", "text-lab", "tech-files", "advanced"];
for (const id of ids) {
  assert(html.includes(`<button class="nav-item" data-section="${id}"`), `nav button missing: ${id}`);
  assert(html.includes(`id="view-${id}"`), `view container missing: ${id}`);
  assert(html.includes(`"${id}": document.getElementById("view-${id}")`), `views registry missing: ${id}`);
  assert(new RegExp(`"${id}": \\["[^"]+", "[^"]+"\\]`).test(html), `viewMeta missing: ${id}`);
  assert(js.includes(`"view-${id}"`), `renderer missing: ${id}`);
}
assert(html.includes("/zypp-premium-plus.css") && html.includes("/zypp-premium-plus.js"), "assets not linked");
assert(/id: "toolkit"[^}]*badge: "NEW"/.test(shell) && /id: "advanced"[^}]*badge: "SOON"/.test(shell), "shell hubs/badges missing");
assert(js.includes("COMING SOON") && js.includes("Nothing below is live yet"), "Advanced page must be clearly labelled as not live");
assert(!/localStorage\.setItem\([^)]*(token|password)/i.test(js), "must not store credentials");
assert(!/fetch\(/.test(js), "Toolkit tools must stay client-side (no API calls)");
assert(css.includes("prefers-reduced-motion"), "reduced-motion support missing");
console.log("premium plus static tests passed");
