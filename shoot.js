// 使い方: npm i playwright-core && node shoot.js  （server.py 起動中に実行。実際に Gemini を呼びます）
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    recordVideo: { dir: "shots/video", size: { width: 1440, height: 900 } } });
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:8765/", { waitUntil: "networkidle" });
  const st = await (await p.request.get("http://127.0.0.1:8765/api/status")).json();
  const WAIT_MS = ((Number(st.client_timeout_s) || 160) + 30) * 1000;
  let failed = 0;
  await p.waitForTimeout(1500);
  await p.screenshot({ path: "shots/00_start.png" });
  for (const id of ["s3", "s6", "s8"]) {
    await p.click(`.post[data-id=${id}]`);
    await p.waitForTimeout(600);
    await p.click("#go");
    // 成功（data-state=ok）とエラー表示（data-state=error）を区別する。待ち時間はサーバーの client_timeout_s より長くとる
    await p.waitForSelector('#result[data-state="ok"], #result[data-state="error"]', { timeout: WAIT_MS });
    const state = await p.getAttribute("#result", "data-state");
    if (state !== "ok") {
      console.error(id, "ERROR:", await p.textContent("#result"));
      await p.screenshot({ path: `shots/${id}_error.png` });
      failed++;
      continue;
    }
    await p.waitForTimeout(3200);
    await p.screenshot({ path: `shots/${id}_result.png` });
    console.log(id, (await p.textContent("#result .big").catch(() => "?")), "|", await p.textContent("#log li"), "|", await p.textContent("#cmp .dec").catch(() => "-"));
  }
  await p.evaluate(() => { document.querySelector(".leaflet-popup-close-button")?.click(); });
  await p.evaluate(() => map.flyTo([35.3, 137.2], 6, { duration: 1 }));
  await p.waitForTimeout(2000);
  await p.screenshot({ path: "shots/99_overview.png" });
  const v = p.video(); await ctx.close(); await b.close();
  if (v) { const fs = require("fs"); fs.renameSync(await v.path(), "shots/demo_run.webm"); }
  if (failed) { console.error(`${failed} 件がエラーでした`); process.exit(1); }
})();
