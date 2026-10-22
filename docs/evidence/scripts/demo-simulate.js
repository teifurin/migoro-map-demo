// 保存済みの実 Gemini 出力（docs/evidence/demo-2026-10-22/gemini）を、修正後の seed.js に順に流す（API は呼ばない）。
// 実行（リポジトリのルートで）: node docs/evidence/scripts/demo-simulate.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..", ".."), L = require(path.join(ROOT, "logic.js"));
const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(ROOT, "seed.js"), "utf8"), ctx);
const spots = {}; ctx.window.SEED.forEach((s) => { spots[s.id] = Object.assign({ history: [] }, s); });
const dir = path.join(ROOT, "docs", "evidence", "demo-2026-10-22", "gemini");
const strip = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
let i = 0; const rows = [];
function run(name, opt) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8")).out;
  const p = L.planPlot(d, spots, Object.assign({ newId: () => "g" + ++i }, opt || {})); L.applyPlan(spots, p);
  rows.push({ name: name + (opt && opt.confirm ? "（人が候補を確認）" : ""), action: p.action, log: strip(p.logHtml) });
  return p;
}
run("demo_s3"); const b = run("demo_s6");
if (b.action === "ambiguous") run("demo_s6", { confirm: { spotId: b.candidates[0].id } });
run("demo_s8"); run("demo_s2"); run("edge_e_park_centre");
if (require.main === module) rows.forEach((r) => console.log(`| ${r.name} | ${r.action} | ${r.log} |`));
module.exports = { rows, spots };
