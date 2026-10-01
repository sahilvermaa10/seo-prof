// Static guard for the luxe UI pass: single identity chip, luxe layer loaded, theme tokens present.
const fs = require("fs"), path = require("path"), assert = require("assert");
const pub = f => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
const html = pub("index.html"), ask = pub("askseo-inspired.js"), css = pub("pro-luxe.css"), studio = pub("pro-studio.js");
assert(!/createElement\([^)]*\)[\s\S]{0,80}ask-user-chip|userChip\.className/.test(ask), "askseo must not create a second user chip");
assert.strictEqual((html.match(/id="agentUserName"/g) || []).length, 1, "exactly one visible account name element");
assert(html.includes("/pro-luxe.css") && html.includes("/pro-luxe.js"), "luxe layer must be loaded");
assert(html.indexOf("/pro-luxe.css") > html.indexOf("/pro-studio.css"), "luxe css must load after pro-studio.css");
for (const t of ['html[data-theme="dark"]', 'html[data-theme="light"]', "--lx-cell", "--lx-text"]) assert(css.includes(t), "missing token " + t);
assert(/class="ps-fold"/.test(studio) && /class="ps-theme"/.test(studio), "suite sidebar collapse + in-suite theme switch");
const reset = html.slice(html.indexOf("function resetWorkspaceClientState"), html.indexOf("function clearAuth"));
assert(/view-dashboard"\)\?\.classList\.add\("active-view"\)/.test(reset), "reset must re-activate the dashboard view (blank Overview bug)");
console.log("luxe ui static test passed");
