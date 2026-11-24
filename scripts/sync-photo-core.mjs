// Copies lib/photo-core.js into public/tagbot.html (demo mode runs the same photo check in the browser).
import { readFileSync, writeFileSync } from "fs";
const core = readFileSync(new URL("../lib/photo-core.js", import.meta.url), "utf8").replace(/^export /m, "");
const p = new URL("../public/tagbot.html", import.meta.url); let html = readFileSync(p, "utf8");
const a = "/* photo-core:start */", b = "/* photo-core:end */";
if (!html.includes(a)) throw new Error("markers missing in tagbot.html");
html = html.slice(0, html.indexOf(a) + a.length) + "\n" + core + "\n" + html.slice(html.indexOf(b));
writeFileSync(p, html); console.log("photo-core synced");
