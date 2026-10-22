// index.html の実際のインライン JavaScript を、最小限の DOM / Leaflet / fetch / FileReader スタブの上で実行する統合テスト。
// （実際の Gemini・ネットワーク・ブラウザは使わない）  実行: node --test tests/page.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SAMPLES = JSON.parse(fs.readFileSync(path.join(ROOT, "samples", "samples.json"), "utf8"));

function analysisFor(body, over = {}) {
  const text = body.text || "";
  return Object.assign({
    result: { species: "紅葉", stage: "見頃", stage_label: "見頃", bloom_ratio: 85, confidence: 0.9,
      place_name: "テスト公園 " + text, prefecture: "東京都", municipality: "八王子市", lat: 35.62, lng: 139.24,
      evidence_image: "赤", evidence_text: text, reasoning: "r", caution: "", consistency: "一致", consistency_note: "" },
    meta: { model: "fake", latency_s: 0.1 },
    location: { lat: 35.62, lng: 139.24, source: "Gemini 推定" },
    validation: { ok: true, issues: [], warnings: [] },
    input: { text, sample: body.sample || null, observed_at: body.observed_at ? body.observed_at + ":00+09:00" : null },
  }, over);
}

function loadPage() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const inline = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const els = {}, markers = [], readers = [], analyzeCalls = [];
  let posts = [];
  class El {
    constructor(id) { this.id = id; this.style = {}; this.dataset = {}; this.textContent = ""; this._html = ""; this.value = "";
      this.disabled = false; this.children = []; this.files = [];
      const set = new Set(); this.classList = { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) }; }
    set innerHTML(h) {
      this._html = h;
      if (this.id === "posts") posts = [...h.matchAll(/data-id="([^"]+)"/g)].map((m) => { const b = new El(); b.dataset.id = m[1]; return b; });
    }
    get innerHTML() { return this._html; }
    prepend(c) { this.children.unshift(c); }
    scrollIntoView() {}
    querySelectorAll(sel) {
      if (sel !== "button.confirm") return [];
      if (this._btnSrc !== this._html) {  // 要確認の候補ボタン（data-confirm / data-spot）だけを取り出す
        this._btns = [...this._html.matchAll(/<button type="button" class="confirm" data-confirm="(\w+)"(?: data-spot="([^"]*)")?/g)]
          .map((m) => { const b = new El(); b.dataset.confirm = m[1]; if (m[2] != null) b.dataset.spot = m[2]; return b; });
        this._btnSrc = this._html;
      }
      return this._btns;
    }
  }
  const $ = (id) => els[id] || (els[id] = new El(id));
  const document = { getElementById: $, createElement: () => new El(), querySelectorAll: (sel) => (sel === ".post" ? posts : []) };
  const marker = () => { const m = { addTo() { markers.push(m); return m; }, bindPopup(h) { m.popup = h; return m; },
    setIcon(i) { m.icon = i; return m; }, setPopupContent(h) { m.popup = h; return m; }, openPopup() {} }; return m; };
  const L = { map: () => ({ setView() { return this; }, flyTo() {} }), control: { zoom: () => ({ addTo() {} }) },
    tileLayer: () => ({ addTo() {} }), divIcon: (o) => o, marker };
  class FakeFileReader { readAsDataURL(f) { this.file = f; readers.push(this); }
    finish() { this.result = "data:image/jpeg;base64,QUJD"; this.onload(); } }
  function respond(data, status = 200) { return { ok: status < 400, status, json: async () => data }; }
  function fetch(url, opts = {}) {
    if (url === "samples/samples.json") return Promise.resolve(respond(SAMPLES));
    if (url === "/api/status") return Promise.resolve(respond({ gemini_api_key: "set", client_timeout_s: 160 }));
    if (url === "/api/analyze") {
      const call = { body: JSON.parse(opts.body), signal: opts.signal };
      call.promise = new Promise((resolve, reject) => {
        call.resolve = (data, status) => resolve(respond(data, status));
        opts.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
      });
      analyzeCalls.push(call);
      return call.promise;
    }
    return Promise.reject(new Error("unexpected fetch " + url));
  }
  const timers = new Map(); let tid = 0;
  const ctx = { document, L, fetch, FileReader: FakeFileReader, AbortController, console, Date, Math, JSON, Promise, Number, String, Object, Array,
    setTimeout: (fn, ms) => { timers.set(++tid, fn); return tid; }, clearTimeout: (id) => timers.delete(id) };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "seed.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "logic.js"), "utf8"), ctx);
  vm.runInContext(inline, ctx);
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  return { $, markers, readers, analyzeCalls, flush, posts: () => posts,
    async upload(text, date) {
      $("file").onchange({ target: { files: [{ type: "image/jpeg", name: "a.jpg" }] } });
      readers[readers.length - 1].finish();
      $("ftext").value = text; $("ftext").oninput({ target: $("ftext") });
      $("fdate").value = date; $("fdate").onchange({ target: $("fdate") });
    },
    edit(id, value) { $(id).value = value; const ev = { target: $(id) }; if (id === "ftext") $(id).oninput(ev); else { $(id).oninput(ev); $(id).onchange(ev); } },
  };
}

for (const field of ["ftext", "fdate"]) {
  test(`R1: editing ${field} during an upload analysis aborts it; the late OLD response is not shown or plotted`, async () => {
    const pg = loadPage(); await pg.flush();
    await pg.upload("OLD", "2026-10-01T10:00");
    const markers0 = pg.markers.length;
    const run = pg.$("go").onclick();
    assert.equal(pg.analyzeCalls.length, 1);
    const call = pg.analyzeCalls[0];
    assert.equal(call.body.text, "OLD");
    assert.equal(call.body.observed_at, "2026-10-01T10:00");
    assert.equal(pg.$("think").style.display, "flex");
    pg.edit(field, field === "ftext" ? "NEW" : "2026-10-02T10:00");
    assert.equal(call.signal.aborted, true);
    assert.equal(pg.$("think").style.display, "none");
    assert.equal(pg.$("go").disabled, false);
    assert.equal(pg.$("result").dataset.state, "stale");
    call.resolve(analysisFor(call.body));   // 中断済みでも遅れて返ってきた場合
    await run; await pg.flush();
    assert.equal(pg.$("result").dataset.state, "stale");
    assert.equal(pg.markers.length, markers0);
    assert.doesNotMatch(pg.$("result").innerHTML, /OLD/);
    // 再実行は新しい入力で送られる
    pg.$("go").onclick();
    const call2 = pg.analyzeCalls[1];
    assert.equal(call2.body.text, field === "ftext" ? "NEW" : "OLD");
    assert.equal(call2.body.observed_at, field === "fdate" ? "2026-10-02T10:00" : "2026-10-01T10:00");
  });
}

test("R1: editing text after a completed upload analysis marks the result stale", async () => {
  const pg = loadPage(); await pg.flush();
  await pg.upload("OLD", "2026-10-01T10:00");
  const run = pg.$("go").onclick();
  const call = pg.analyzeCalls[0];
  call.resolve(analysisFor(call.body)); await run; await pg.flush();
  assert.equal(pg.$("result").dataset.state, "ok");
  assert.match(pg.$("result").innerHTML, /判定した本文/);
  pg.edit("ftext", "NEW");
  assert.equal(pg.$("result").dataset.state, "stale");
  assert.doesNotMatch(pg.$("result").innerHTML, /OLD/);
  assert.equal(pg.$("ptext").textContent, "NEW");
  pg.edit("fdate", "2026-10-02T10:00");
  assert.equal(pg.$("result").dataset.state, "stale");
});

test("R1: editing the upload text box while a sample is selected does not cancel the sample analysis", async () => {
  const pg = loadPage(); await pg.flush();
  pg.posts()[0].onclick();
  const run = pg.$("go").onclick();
  const call = pg.analyzeCalls[0];
  assert.equal(call.body.sample, SAMPLES[0].id);
  pg.edit("ftext", "something");
  assert.equal(call.signal.aborted, false);
  call.resolve(analysisFor({ sample: SAMPLES[0].id })); await run; await pg.flush();
  assert.equal(pg.$("result").dataset.state, "ok");
});

test("sample switch during a request aborts it and the late response is ignored (page-level)", async () => {
  const pg = loadPage(); await pg.flush();
  pg.posts()[0].onclick();
  const run = pg.$("go").onclick();
  const call = pg.analyzeCalls[0];
  pg.posts()[1].onclick();
  assert.equal(call.signal.aborted, true);
  assert.equal(pg.$("go").disabled, false);
  call.resolve(analysisFor({ sample: SAMPLES[0].id })); await run; await pg.flush();
  assert.notEqual(pg.$("result").dataset.state, "ok");
});

test("error responses set data-state=error with escaped message", async () => {
  const pg = loadPage(); await pg.flush();
  pg.posts()[0].onclick();
  const run = pg.$("go").onclick();
  pg.analyzeCalls[0].resolve({ error: "<img src=x onerror=1>", error_code: "x" }, 502); await run; await pg.flush();
  assert.equal(pg.$("result").dataset.state, "error");
  assert.doesNotMatch(pg.$("result").innerHTML, /<img/);
  assert.equal(pg.$("think").style.display, "none");
});


test("upload date starts unknown instead of silently asserting a fresh observation", async () => {
  const pg = loadPage(); await pg.flush();
  assert.equal(pg.$("fdate").value, "");
});


test("ambiguous result: confirm button applies only the chosen candidate; buttons from an old result are ignored", async () => {
  const pg = loadPage(); await pg.flush();
  const ambiguous = (body) => analysisFor(body, { result: Object.assign(analysisFor(body).result,
    { species: "彼岸花", stage: "つぼみ", place_name: "北堀公園", lat: 34.9415, lng: 135.7793 }),
    location: { lat: 34.9415, lng: 135.7793, source: "OSM Nominatim" } });
  pg.posts()[0].onclick();
  let run = pg.$("go").onclick(); let call = pg.analyzeCalls[0];
  call.resolve(ambiguous(call.body)); await run; await pg.flush();
  const kita = pg.markers.find((m) => /伏見北堀公園/.test(m.popup));
  const before = kita.popup, n0 = pg.markers.length;
  const btns = pg.$("cmp").querySelectorAll("button.confirm");
  assert.deepEqual(btns.map((b) => b.dataset.spot || b.dataset.confirm), ["kitahori", "new"]);
  assert.equal(kita.popup, before);                        // 確認前は何も変えない
  // 別のサンプルを選んだ後に古い結果のボタンを押しても無視される
  pg.posts()[1].onclick();
  btns[0].onclick(); assert.equal(kita.popup, before);
  // もう一度判定して、今度は候補を確認する
  pg.posts()[0].onclick();
  run = pg.$("go").onclick(); call = pg.analyzeCalls[1];
  call.resolve(ambiguous(call.body)); await run; await pg.flush();
  pg.$("cmp").querySelectorAll("button.confirm")[0].onclick();
  assert.match(kita.popup, /人が同じ場所と確認/);
  assert.equal(pg.markers.length, n0);
  assert.match(pg.$("cmp").innerHTML, /掲載中/);
});

test("the page tells users every listed post is synthetic demo data", async () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /id="synthBanner"[^>]*>[^<]*<b>合成デモデータ<\/b>/);
  const pg = loadPage(); await pg.flush();
  assert.match(pg.$("posts").innerHTML, /合成デモデータ/);
  assert.equal((pg.$("posts").innerHTML.match(/class="synth"/g) || []).length, SAMPLES.length);
  pg.posts()[0].onclick();
  assert.match(pg.$("phandle").textContent, /合成デモデータ・架空の投稿/);
});


for (const state of ["pending", "loaded", "error"]) {
  test(`new upload invalidates old confirmation immediately and after ${state}`, async () => {
    const pg = loadPage(); await pg.flush();
    pg.posts()[0].onclick();
    const run = pg.$("go").onclick(), call = pg.analyzeCalls[0];
    const d = analysisFor(call.body);
    Object.assign(d.result, { species: "彼岸花", stage: "つぼみ", place_name: "北堀公園" });
    d.location = { lat: 34.9415, lng: 135.7793, source: "offline" };
    call.resolve(d); await run; await pg.flush();
    const before = pg.markers.map(m => m.popup);
    const buttons = pg.$("cmp").querySelectorAll("button.confirm");
    assert.equal(buttons.length, 2);
    pg.$("file").onchange({ target: { files: [{ type: "image/jpeg", name: "new.jpg" }] } });
    assert.equal(pg.$("result").style.display, "none");
    assert.equal(pg.$("result").innerHTML, "");
    assert.equal(pg.$("go").disabled, true);
    const reader = pg.readers[0];
    if (state === "loaded") reader.finish();
    if (state === "error") reader.onerror();
    // DOM から外れた古いコールバックを呼んでも same/new の両方が無効。
    buttons.forEach(b => b.onclick());
    assert.deepEqual(pg.markers.map(m => m.popup), before);
    if (state === "error") {
      assert.equal(pg.$("result").dataset.state, "error");
      assert.match(pg.$("result").innerHTML, /画像を読み込めませんでした/);
      assert.equal(pg.$("go").disabled, true);
    }
    if (state === "loaded") assert.equal(pg.$("go").disabled, false);
  });
}
