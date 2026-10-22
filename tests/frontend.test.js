// logic.js の回帰テスト（Node 標準の node:test のみ。DOM・ネットワーク不要）
// 実行: node --test tests/   （または make test）
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../logic.js");

const XSS = `<img src=x onerror="window.__xss=1">&'"\`<script>alert(1)</script>`;
const RAW_TAG = /<img src=x|<script|onerror="|onmouseover="/i; // エスケープされていない注入だけを検出

function analysis(over = {}, extra = {}) {
  const result = Object.assign({ species: "紅葉", stage: "見頃", stage_label: "見頃", bloom_ratio: 85, confidence: 0.9,
    place_name: "高尾山薬王院", prefecture: "東京都", municipality: "八王子市", lat: 35.625, lng: 139.25,
    evidence_image: "赤", evidence_text: "真っ赤", reasoning: "一致", caution: "", consistency: "一致", consistency_note: "一致" }, over);
  return Object.assign({ result, meta: { model: "gemini-test", latency_s: 1.2 },
    location: { lat: result.lat, lng: result.lng, source: "Gemini 推定" },
    validation: { ok: true, issues: [], warnings: [] },
    input: { observed_at: "2026-11-20T10:45:00+09:00" },
    // 実サーバーは必ず analyzed_at を返す。テストの投稿日時（10〜11月）より後の固定値にして、未来日判定を時計に依存させない
    analyzed_at: "2026-11-21T12:00:00+09:00" }, extra);
}
function seedSpot(over = {}) {
  return Object.assign({ id: "x", name: "高尾山薬王院", place: "東京都八王子市", lat: 35.625, lng: 139.25, stage: "咲き始め",
    species: "紅葉", src: "seed", history: [] }, over);
}
const applyPlan = L.applyPlan; // index.html の plot() が使うのと同じ適用関数

// ---- 2. エスケープ ----
test("escapeHtml escapes all HTML-significant characters", () => {
  assert.equal(L.escapeHtml(`<a href="x" onclick='y'>&\``), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;");
  assert.equal(L.escapeHtml(null), "");
  assert.equal(L.escapeHtml(5), "5");
});

test("resultHtml escapes every model field, meta and JSON preview", () => {
  const fields = ["species", "stage_label", "place_name", "prefecture", "municipality", "evidence_image", "evidence_text",
    "reasoning", "caution", "consistency_note"];
  const over = {}; fields.forEach((f) => { over[f] = XSS; });
  const d = analysis(over); d.meta.model = XSS;
  const html = L.resultHtml(d);
  assert.doesNotMatch(html, RAW_TAG);
  assert.match(html, /&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;/);
  assert.match(html, /<pre>[^<]*&lt;img/); // JSON プレビューもエスケープ済み
});

test("resultHtml with invalid stage/numbers does not inject into style or text", () => {
  const html = L.resultHtml(analysis({ stage: `"><img onerror=1>`, bloom_ratio: "<b>", confidence: "<i>" }));
  assert.doesNotMatch(html, RAW_TAG);
  assert.match(html, /要確認/);
});

test("popup, sample card, error and log/compare HTML are escaped", () => {
  const spot = seedSpot({ name: XSS, place: XSS, species: XSS, stage_label: XSS, flag: XSS, src: XSS, stage: XSS });
  assert.doesNotMatch(L.popupHtml(spot), RAW_TAG);
  const card = L.sampleCardHtml({ id: `x" onmouseover="alert(1)`, image: `x" onerror="1`, text: XSS, handle: XSS, posted: XSS });
  assert.doesNotMatch(card, RAW_TAG);
  assert.equal((card.match(/<img /g) || []).length, 1);
  assert.match(card, /src="x&quot; onerror=&quot;1"/);
  assert.doesNotMatch(L.errorHtml(XSS), RAW_TAG);
  for (const spots of [{}, { x: seedSpot() }]) {
    const d = analysis({ place_name: XSS, consistency: "矛盾", consistency_note: XSS, prefecture: XSS }); d.meta.model = XSS;
    const p = L.planPlot(d, spots, { newId: () => "n1" });
    assert.doesNotMatch(p.cmpHtml + p.logHtml, RAW_TAG, p.action);
  }
  const lowConf = L.planPlot(analysis({ place_name: XSS, confidence: 0.3 }), {}, {});
  assert.equal(lowConf.action, "hold");
  assert.doesNotMatch(lowConf.cmpHtml + lowConf.logHtml, RAW_TAG);
});

// ---- 5. 出力検証（フロント側の二重防御） ----
test("invalid coordinates never update the map", () => {
  for (const [lat, lng] of [[95, 999], [NaN, 139], [35, Infinity], ["35.6", "139.7"], [null, null], [0, 0], [40.7, -74]]) {
    const d = analysis({}, { location: { lat, lng, source: "x" } });
    const v = L.validateAnalysis(d);
    assert.equal(v.location, null, `${lat},${lng}`);
    const p = L.planPlot(d, {}, { newId: () => "n" });
    assert.equal(p.action, "unlocatable");
    assert.equal(p.spot, undefined);
    assert.match(p.cmpHtml, /要確認/);
  }
  assert.equal(L.planPlot(analysis({}, { location: null }), {}, {}).action, "unlocatable");
});

test("invalid enums / numbers are flagged and not plotted", () => {
  const bad = [{ confidence: 1.5 }, { confidence: "0.9" }, { confidence: NaN }, { bloom_ratio: 120 }, { bloom_ratio: null },
    { stage: "満開" }, { consistency: "?" }, { species: "" }];
  for (const over of bad) {
    const p = L.planPlot(analysis(over), {}, {});
    assert.equal(p.action, "invalid", JSON.stringify(over));
  }
  const d = analysis(); d.validation = { ok: false, issues: ["confidence: 0〜1 の数値ではありません"] };
  assert.equal(L.planPlot(d, {}, {}).action, "invalid");
  assert.equal(L.validateAnalysis(null).ok, false);
});

// ---- 4. 観測日時の順序 ----
test("decideObservation: new->old, old->new, unknown, same-day conflict", () => {
  const a = "2026-10-20T11:05:00+09:00", b = "2026-11-20T10:45:00+09:00";
  assert.equal(L.decideObservation(b, a, false).action, "history");      // 新 → 旧（古い投稿は上書きしない）
  assert.equal(L.decideObservation(a, b, false).action, "update");       // 旧 → 新
  assert.equal(L.decideObservation(undefined, a, false).action, "update"); // 既存が日時不明（初期データ）
  assert.equal(L.decideObservation(a, null, false).action, "history");   // 新しい投稿が日時不明
  const same = L.decideObservation("2026-11-20T08:00:00+09:00", "2026-11-20T18:00:00+09:00", false);
  assert.deepEqual([same.action, same.conflict], ["update", true]);      // 同日で段階が違う → 更新＋要確認
  assert.equal(L.decideObservation("2026-11-20T08:00:00+09:00", "2026-11-20T18:00:00+09:00", true).conflict, false);
  // JST の日付で判定（UTC では別日になる時刻）
  assert.equal(L.decideObservation("2026-11-20T00:30:00+09:00", "2026-11-20T23:30:00+09:00", false).conflict, true);
});

test("s7 (newer) then s3 (older) at the same spot keeps the newer stage", () => {
  const spots = {};
  let n = 0; const newId = () => "g" + (++n);
  const s7 = analysis({ stage: "見頃", stage_label: "見頃" }, { input: { observed_at: "2026-11-20T10:45:00+09:00" } });
  const s3 = analysis({ stage: "咲き始め", stage_label: "色づき始め", place_name: "高尾山 薬王院" }, { input: { observed_at: "2026-10-20T11:05:00+09:00" } });
  const p1 = L.planPlot(s7, spots, { newId }); assert.equal(p1.action, "new"); applyPlan(spots, p1);
  const p2 = L.planPlot(s3, spots, { newId }); assert.equal(p2.action, "history"); applyPlan(spots, p2);
  assert.equal(spots.g1.stage, "見頃");
  assert.equal(spots.g1.observed_at, "2026-11-20T10:45:00+09:00");
  assert.match(p2.cmpHtml, /古いため/);
});

test("s3 then s7 updates, and 'same stage' message shows the real observed time", () => {
  const spots = {};
  let n = 0; const newId = () => "g" + (++n);
  const s3 = analysis({ stage: "咲き始め" }, { input: { observed_at: "2026-10-20T11:05:00+09:00" } });
  const s7 = analysis({ stage: "見頃" }, { input: { observed_at: "2026-11-20T10:45:00+09:00" } });
  applyPlan(spots, L.planPlot(s3, spots, { newId }));
  const p = L.planPlot(s7, spots, { newId }); assert.equal(p.action, "update"); applyPlan(spots, p);
  assert.equal(spots.g1.stage, "見頃");
  const again = analysis({ stage: "見頃" }, { input: { observed_at: "2026-11-21T09:00:00+09:00" } });
  const p3 = L.planPlot(again, spots, { newId });
  assert.match(p3.cmpHtml, /確認日時を 2026-11-21 09:00 に更新/);
  const noDate = L.planPlot(analysis({ stage: "咲き始め" }, { input: { observed_at: null } }), { x: seedSpot() }, {});
  assert.equal(noDate.action, "update"); // 初期データ（日時不明）は日時不明の投稿でも更新できる
  assert.doesNotMatch(noDate.cmpHtml, /確認日時/);
});

test("fmtTime is JST regardless of input offset", () => {
  assert.equal(L.fmtTime("2026-11-20T01:45:00Z"), "2026-11-20 10:45");
  assert.equal(L.fmtTime("garbage"), "");
});

// ---- 照合ルール（種類＋距離＋名称） ----
test("matchSpot: nearby spot with a different name is ambiguous, not merged", () => {
  const A = seedSpot({ id: "A", name: "府中郷土の森博物館", lat: 35.6502, lng: 139.4724, species: "彼岸花" });
  const cand = { species: "彼岸花", lat: 35.6502 + 0.0099, lng: 139.4724, name: "大國魂神社" }; // 約 1.1km
  const m = L.matchSpot([A], cand);
  assert.equal(m.kind, "ambiguous");
  const p = L.planPlot(analysis({ species: "彼岸花", place_name: "大國魂神社", lat: cand.lat, lng: cand.lng }), { A }, {});
  assert.equal(p.action, "ambiguous");
  assert.equal(A.stage, "咲き始め"); // 変更されない
});

test("matchSpot: legacy name aliases now require confirmation of the actual area", () => {
  const cases = [["東福寺（通天橋）", "東福寺"], ["いろは坂（明智平周辺）", "日光いろは坂"], ["明日香・稲渕棚田", "稲渕の棚田"],
    ["権現堂堤", "権現堂公園"], ["伏見北堀公園", "北堀公園"], ["巾着田曼珠沙華公園", "巾着田"]];
  for (const [seed, gem] of cases) {
    const s = seedSpot({ name: seed });
    const m = L.matchSpot([s], { species: "紅葉", lat: s.lat + 0.005, lng: s.lng, name: gem });
    assert.equal(m.kind, "ambiguous", `${seed} vs ${gem} sim=${L.nameSimilarity(seed, gem)}`);
  }
});

test("matchSpot: other species or far away -> none; two equally similar -> ambiguous", () => {
  const s = seedSpot();
  assert.equal(L.matchSpot([s], { species: "彼岸花", lat: s.lat, lng: s.lng, name: s.name }).kind, "none");
  assert.equal(L.matchSpot([s], { species: "紅葉", lat: s.lat + 0.1, lng: s.lng, name: s.name }).kind, "none");
  const s2 = seedSpot({ id: "y", lat: s.lat + 0.001 });
  assert.equal(L.matchSpot([s, s2], { species: "紅葉", lat: s.lat, lng: s.lng, name: s.name }).kind, "ambiguous");
});

// ---- 3. リクエスト競合 ----
test("RequestGate: stale response (A after B) is ignored and does not clear B's busy state", async () => {
  const gate = new L.RequestGate();
  const shown = [];
  let resolveA, resolveB;
  const fetchA = new Promise((r) => { resolveA = r; }), fetchB = new Promise((r) => { resolveB = r; });
  async function run(fetchP, start) { // index.html の go.onclick と同じ流れ
    const { id } = start;
    try { const d = await fetchP; if (!gate.isCurrent(id)) return; shown.push(d); }
    finally { if (gate.finish(id)) shown.push("idle"); }
  }
  const startA = gate.start(0);
  const pa = run(fetchA, startA);
  const startB = gate.start(0); // サンプル切り替え後に再実行
  assert.equal(gate.busy, true);
  const pb = run(fetchB, startB);
  resolveB("B"); await pb;
  resolveA("A"); await pa;
  assert.deepEqual(shown, ["B", "idle"]);
  assert.equal(gate.busy, false);
});

test("RequestGate: starting B aborts A; A finishing late keeps B busy", async () => {
  const gate = new L.RequestGate();
  const a = gate.start(0), b = gate.start(0);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  assert.equal(gate.finish(a.id), false);
  assert.equal(gate.busy, true);
  assert.equal(gate.finish(b.id), true);
  assert.equal(gate.busy, false);
});

test("RequestGate: cancel on selection change and timeout abort", async () => {
  const gate = new L.RequestGate();
  const a = gate.start(0);
  gate.cancel();
  assert.equal(a.signal.aborted, true);
  assert.equal(gate.isCurrent(a.id), false);
  const t = gate.start(10);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.signal.aborted, true);
  assert.equal(gate.timedOut(t.id), true);
  gate.finish(t.id);
});

// ---- 6. FileReader 競合 ----
test("SelectionTracker: late FileReader completion does not override a newer choice", () => {
  const sel = new L.SelectionTracker();
  let preview = null;
  const readers = [];
  function pickFile(name) { const v = sel.next(); readers.push(() => { if (sel.isCurrent(v)) preview = name; }); }
  function pickSample(id) { sel.next(); preview = id; }
  pickFile("upload.jpg");
  pickSample("s5");           // 読み込み完了前にサンプルを選択
  readers[0]();               // 古い読み込みが完了
  assert.equal(preview, "s5");
  pickFile("one.jpg"); pickFile("two.jpg");
  readers[2](); readers[1](); // 逆順に完了
  assert.equal(preview, "two.jpg");
});

// ---- R2: 同日の食い違いは、同じ観測の再送では解除されない ----
test("R2: re-submitting the identical observation after a same-day conflict keeps the conflict", () => {
  const spots = {}; let n = 0; const newId = () => "g" + (++n);
  const at = (t, stage) => analysis({ stage, stage_label: stage }, { input: { observed_at: t } });
  applyPlan(spots, L.planPlot(at("2026-11-20T09:00:00+09:00", "咲き始め"), spots, { newId }));
  const p1 = L.planPlot(at("2026-11-20T10:00:00+09:00", "見頃"), spots, { newId });
  assert.equal(p1.action, "update"); applyPlan(spots, p1);
  assert.match(spots.g1.flag, /同じ日の観測で段階が食い違っています/);
  // 完全に同じ 10:00 の観測をもう一度
  const p2 = L.planPlot(at("2026-11-20T10:00:00+09:00", "見頃"), spots, { newId });
  assert.equal(p2.action, "duplicate"); applyPlan(spots, p2);
  assert.match(spots.g1.flag, /食い違/);
  assert.match(p2.cmpHtml, /要確認は維持/);
  // 同じ日の別の（同じ段階の）観測でも解除しない
  const p3 = L.planPlot(at("2026-11-20T15:00:00+09:00", "見頃"), spots, { newId });
  assert.equal(p3.action, "update"); applyPlan(spots, p3);
  assert.match(spots.g1.flag, /食い違/);
  assert.match(p3.cmpHtml, /未解決のため要確認を維持/);
  // 写真と本文の矛盾フラグとは別管理：一致の観測でも同日の食い違いは残る
  assert.equal(spots.g1.consFlag, "");
  // 翌日（JST）の観測で解除
  const p4 = L.planPlot(at("2026-11-21T09:00:00+09:00", "見頃"), spots, { newId });
  applyPlan(spots, p4);
  assert.equal(spots.g1.flag, "");
  assert.equal(spots.g1.conflict, null);
  assert.match(p4.cmpHtml, /要確認を解除/);
});

test("R2: consistency flag and same-day conflict are combined but tracked separately", () => {
  const spots = {}; let n = 0; const newId = () => "g" + (++n);
  applyPlan(spots, L.planPlot(analysis({ stage: "咲き始め" }, { input: { observed_at: "2026-11-20T09:00:00+09:00" } }), spots, { newId }));
  const p = L.planPlot(analysis({ stage: "見頃", consistency: "矛盾", consistency_note: "写真は落葉" }, { input: { observed_at: "2026-11-20T10:00:00+09:00" } }), spots, { newId });
  applyPlan(spots, p);
  assert.match(spots.g1.consFlag, /矛盾/);
  assert.ok(spots.g1.conflict);
  assert.match(spots.g1.flag, /矛盾.*／.*食い違/);
  assert.equal(spots.g1.history.length, 2);
});

// ---- 細かい指摘 ----
test("validateAnalysis: validation.ok=false with empty/missing issues is still not ok", () => {
  for (const validation of [{ ok: false, issues: [] }, { ok: false }, { ok: false, issues: [""] }]) {
    const v = L.validateAnalysis(analysis({}, { validation }));
    assert.equal(v.ok, false, JSON.stringify(validation));
    assert.ok(v.issues.length);
    assert.equal(L.planPlot(analysis({}, { validation }), {}, {}).action, "invalid");
  }
});

test("parseTime is strict: impossible dates and malformed strings are NaN", () => {
  for (const bad of ["2026-02-30T10:00", "2026-02-29T10:00", "2026-04-31 10:00", "2026-13-01T00:00", "2026-11-20T24:00",
    "2026-11-20T10:60", "2026-11-20T10:00+25:00", "2026-11-20", "20261120T1000", "Nov 20 2026", "", null, 123]) {
    assert.ok(Number.isNaN(L.parseTime(bad)), String(bad));
  }
  assert.equal(L.parseTime("2028-02-29T10:00"), Date.parse("2028-02-29T10:00:00+09:00"));
  assert.equal(L.parseTime("2026-11-20 10:45"), Date.parse("2026-11-20T10:45:00+09:00"));
  assert.equal(L.parseTime("2026-11-20T01:45:00Z"), Date.parse("2026-11-20T10:45:00+09:00"));
  assert.equal(L.parseTime("2026-11-20T10:45:00.123+09:00"), Date.parse("2026-11-20T10:45:00+09:00"));
  // 不正な日付は「日時不明」として扱われ、日付つきの掲載を上書きしない
  assert.equal(L.decideObservation("2026-11-20T10:00:00+09:00", "2026-02-30T10:00", false).action, "history");
});


test("nearby east/west areas and parent/child names never silently overwrite each other", () => {
  for (const [a, b] of [["代々木公園東側", "代々木公園西側"], ["東福寺", "東福寺（通天橋）"], ["テスト公園", "テスト公園北門"]]) {
    const spot = seedSpot({name: a});
    const p = L.planPlot(analysis({place_name: b}), {x: spot});
    assert.equal(p.action, "ambiguous");
    assert.equal(L.applyPlan({x: spot}, p), null);
    assert.equal(spot.stage, "咲き始め");
  }
});

test("same name only matches within 300m, while whitespace/fullwidth variants are accepted", () => {
  const s = seedSpot({name: "Ａ公園 東側"});
  const cand = {species: s.species, name: "A公園東側", lat: s.lat + 0.001, lng: s.lng};
  assert.equal(L.matchSpot([s], cand).kind, "match");
  assert.equal(L.matchSpot([s], {...cand, lat: s.lat + 0.004}).kind, "ambiguous");
  assert.equal(L.matchSpot([s, {...s, id:"second", lat:s.lat + 0.02}], cand).kind, "ambiguous");
});

test("new/update/history preserve evidence and popup explains provenance and location limits", () => {
  const spots = {};
  const d = analysis({}, {input: {sample:"s1", text:"synthetic", observed_at:"2026-11-20T10:00:00+09:00"}});
  const p = L.planPlot(d, spots, {newId:()=>"n"});
  L.applyPlan(spots, p);
  assert.equal(spots.n.evidence.sample, "s1");
  assert.equal(spots.n.history[0].evidence.image, "赤");
  d.input = {text:"earlier upload", observed_at:"2026-11-19T10:00:00+09:00"};
  const old = L.planPlot(d, spots);
  assert.equal(old.action, "history"); L.applyPlan(spots, old);
  assert.equal(spots.n.evidence.sample, "s1");
  assert.equal(spots.n.history[1].evidence.text, "earlier upload");
  let html = L.popupHtml(spots.n);
  for (const term of ["AI生成サンプル", "アップロード画像", "撮影日時は未確認", "撮影地点・園内区域は未確認", "正解率ではありません", "記録履歴 2 件", "gemini-test"]) assert.ok(html.includes(term), term);
  d.input.observed_at = "2026-11-21T10:00:00+09:00";
  L.applyPlan(spots, L.planPlot(d, spots));
  assert.equal(spots.n.evidence.sample, null);
  assert.equal(spots.n.history.length, 3);
});

test("evidence and history escape hostile model values; initial markers explicitly say demo", () => {
  const ev = {model:XSS, sample:XSS, image:XSS, textReason:XSS, reasoning:XSS, caution:XSS, locationSource:XSS, locationNote:XSS, analyzedAt:XSS, text:XSS, consistency:XSS, consistencyNote:XSS};
  const s = seedSpot({evidence:ev, history:[{evidence:ev, stage_label:XSS, observed_at:XSS}]});
  assert.doesNotMatch(L.popupHtml(s), RAW_TAG);
  assert.match(L.popupHtml(seedSpot()), /デモ初期データ/);
  assert.match(L.resultHtml(analysis()), /原投稿の真正性は未確認/);
});

test("popup bounds history rendering without discarding stored observations", () => {
  const s = seedSpot({history:Array.from({length:7}, (_,i)=>({stage:"見頃", evidence:{image:"image"+i}}))});
  const html = L.popupHtml(s);
  assert.match(html, /記録履歴 7 件/);
  assert.doesNotMatch(html, /image0|image1/);
  assert.match(html, /image6/);
  assert.equal(s.history.length, 7);
});


test("historical photo/text conflicts and source text remain visible after a later consistent update", () => {
  const spots = {};
  const d = analysis({consistency:"矛盾", consistency_note:"本文は満開、写真は散り始め"},
    {input:{text:"満開でした",observed_at:"2026-11-20T10:00:00+09:00"}});
  L.applyPlan(spots, L.planPlot(d, spots, {newId:()=>"n"}));
  d.result.consistency="一致"; d.result.consistency_note="一致";
  d.input.observed_at="2026-11-21T10:00:00+09:00";
  L.applyPlan(spots, L.planPlot(d, spots));
  assert.equal(spots.n.flag, "");
  const html = L.popupHtml(spots.n);
  assert.match(html, /本文は満開、写真は散り始め/);
  assert.match(html, /満開でした/);
});

// ---- 実 Gemini 連携（2026-10-22）で見つかった問題の回帰 ----
// 実出力では「北堀公園の東側／西側」がどちらも place_name「北堀公園」になり、OSM も同じ公園中心を返した。
// 区域は area_detail に分けて受け取り、地点キーに含める。
test("real-run: east/west areas of the same park stay separate even when Gemini and OSM give the same name and point", () => {
  const spots = {};
  const east = analysis({ species: "彼岸花", stage: "つぼみ", place_name: "北堀公園", area_detail: "東側の斜面", lat: 34.9415, lng: 135.7793 },
    { input: { observed_at: "2026-09-21T09:00:00+09:00", fingerprint: "a1" }, analyzed_at: "2026-09-21T10:00:00+09:00" });
  L.applyPlan(spots, L.planPlot(east, spots, { newId: () => "east" }));
  assert.equal(spots.east.area, "東側の斜面");
  const west = analysis({ species: "彼岸花", stage: "見頃", place_name: "北堀公園", area_detail: "西側の広場", lat: 34.9415, lng: 135.7793 },
    { input: { observed_at: "2026-09-21T09:30:00+09:00", fingerprint: "b2" }, analyzed_at: "2026-09-21T10:00:00+09:00" });
  const p = L.planPlot(west, spots, { newId: () => "west" });
  assert.equal(p.action, "ambiguous");
  assert.equal(spots.east.stage, "つぼみ");
  // 同じ区域の再観測は自動で統合できる
  const east2 = analysis({ species: "彼岸花", stage: "咲き始め", place_name: "北堀公園", area_detail: "東側 の斜面", lat: 34.9416, lng: 135.7794 },
    { input: { observed_at: "2026-09-22T09:00:00+09:00", fingerprint: "c3" }, analyzed_at: "2026-09-22T10:00:00+09:00" });
  assert.equal(L.planPlot(east2, spots).action, "update");
  // 区域なし（園全体）と区域ありは別扱い
  assert.notEqual(L.spotKey("北堀公園", ""), L.spotKey("北堀公園", "東側の斜面"));
});

test("real-run: glyph variants 髙/高 are the same name, but the の particle and punctuation are kept", () => {
  assert.equal(L.nameKey("髙尾山薬王院"), L.nameKey("高尾山 薬王院"));
  assert.equal(L.matchSpot([seedSpot({ name: "髙尾山薬王院" })], { species: "紅葉", lat: 35.625, lng: 139.25, name: "高尾山薬王院" }).kind, "match");
  assert.notEqual(L.nameKey("稲渕の棚田"), L.nameKey("稲渕棚田"));
});

test("timeAssessment separates post time, EXIF capture time and analysis time", () => {
  const at = (input, result = {}, analyzed = "2026-10-22T17:00:00+09:00") => L.timeAssessment({ input, result, analyzed_at: analyzed });
  assert.equal(at({ observed_at: "2026-12-25T10:00:00+09:00" }).status, "future");
  assert.equal(at({ observed_at: "2026-10-22T17:05:00+09:00" }).status, "recent"); // 10分以内の時計ずれは許容
  assert.equal(at({ observed_at: "2026-10-22T15:00:00+09:00" }, { time_reference: "過去の写真・訪問", time_note: "去年撮影" }).status, "past_photo");
  const exif = at({ observed_at: "2026-10-22T15:00:00+09:00", photo_taken_at: "2025-11-20T10:30:00+09:00" });
  assert.equal(exif.status, "past_photo"); assert.equal(exif.block, true); assert.match(exif.note, /EXIF・未検証/);
  assert.equal(at({ observed_at: "2026-10-22T15:00:00+09:00", photo_taken_at: "2026-10-22T14:00:00+09:00" }).status, "recent");
  const unk = at({ observed_at: null }); assert.equal(unk.status, "unknown"); assert.equal(unk.block, false);
  const stale = at({ observed_at: "2026-09-24T15:12:00+09:00" }); assert.equal(stale.status, "stale"); assert.match(stale.note, /28日経過/);
  for (const t of [exif, unk, stale]) assert.ok(t.analyzedAt && "postedAt" in t && "photoAt" in t);
});

test("future-dated or old-photo observations never become the current map state", () => {
  // 既存スポットに対しては履歴だけ（段階・投稿日時は変えない）
  const spots = { x: seedSpot({ observed_at: "2026-10-20T11:05:00+09:00" }) };
  const fut = analysis({}, { input: { observed_at: "2026-11-20T10:45:00+09:00", fingerprint: "f1" }, analyzed_at: "2026-10-22T17:00:00+09:00" });
  const p = L.planPlot(fut, spots);
  assert.equal(p.action, "history"); assert.match(p.cmpHtml, /未来/);
  L.applyPlan(spots, p);
  assert.equal(spots.x.stage, "咲き始め"); assert.equal(spots.x.observed_at, "2026-10-20T11:05:00+09:00");
  assert.match(spots.x.history[0].note, /未来/);
  // 掲載のない場所では新規追加しない（保留）
  const old = analysis({ place_name: "東福寺", area_detail: "通天橋", lat: 34.976, lng: 135.774, time_reference: "過去の写真・訪問", time_note: "去年の11月に撮影" },
    { input: { observed_at: "2026-10-22T15:00:00+09:00", fingerprint: "f2" }, analyzed_at: "2026-10-22T17:00:00+09:00" });
  const none = {}, q = L.planPlot(old, none, { newId: () => "n" });
  assert.equal(q.action, "hold"); assert.equal(L.applyPlan(none, q), null); assert.deepEqual(Object.keys(none), []);
  assert.match(q.cmpHtml, /過去の写真/);
  // 日時不明・古い投稿は反映できるが、現在の状況とは限らないと明示する
  const unk = analysis({}, { input: { observed_at: null, fingerprint: "f3" }, analyzed_at: "2026-10-22T17:00:00+09:00" });
  const r = L.planPlot(unk, {}, { newId: () => "u" });
  assert.equal(r.action, "new"); assert.match(r.cmpHtml, /投稿日時が不明/); assert.match(L.popupHtml(r.spot), /投稿日時が不明/);
  assert.doesNotMatch(L.popupHtml(r.spot), /不明（日本時間）/);
});

test("re-submitting the same image+text (even without a post time) changes nothing and keeps an open conflict", () => {
  const spots = { x: seedSpot({ observed_at: "2026-11-20T09:00:00+09:00", stage: "見頃" }) };
  const a = analysis({ stage: "散り始め" }, { input: { observed_at: "2026-11-20T10:45:00+09:00", fingerprint: "same" } });
  L.applyPlan(spots, L.planPlot(a, spots));
  assert.ok(spots.x.conflict);
  const again = analysis({ stage: "見頃", confidence: 0.95 }, { input: { observed_at: null, fingerprint: "same" } });
  const p = L.planPlot(again, spots);
  assert.equal(p.action, "duplicate"); assert.equal(L.applyPlan(spots, p), null);
  assert.ok(spots.x.conflict); assert.equal(spots.x.history.length, 1);
  const html = L.popupHtml(spots.x);
  assert.match(html, /内容の異なる入力 1 件・独立した投稿数ではありません/);
});

test("ambiguous matches offer human confirmation; only listed candidates can be chosen", () => {
  const spots = { kitahori: seedSpot({ id: "kitahori", name: "伏見北堀公園", species: "彼岸花", lat: 34.9315, lng: 135.7708, stage: "咲き始め" }),
    [XSS]: seedSpot({ id: XSS, name: XSS, species: "彼岸花", lat: 34.9320, lng: 135.7710 }) };
  const d = analysis({ species: "彼岸花", stage: "つぼみ", place_name: "伏見北堀公園", lat: 34.9415, lng: 135.7793 },
    { input: { observed_at: "2026-09-20T09:40:00+09:00", fingerprint: "k1" }, analyzed_at: "2026-09-20T10:00:00+09:00" });
  const p = L.planPlot(d, spots);
  assert.equal(p.action, "ambiguous");
  assert.match(p.cmpHtml, /data-confirm="spot" data-spot="kitahori"/);
  assert.match(p.cmpHtml, /data-confirm="new"/);
  assert.doesNotMatch(p.cmpHtml, RAW_TAG);
  assert.equal(L.planPlot(d, spots, { confirm: { spotId: "not-a-candidate" } }).action, "ambiguous");
  const ok = L.planPlot(d, spots, { confirm: { spotId: "kitahori" } });
  assert.equal(ok.action, "update"); assert.equal(ok.patch.evidence.matchedBy, "人が同じ場所と確認");
  L.applyPlan(spots, ok);
  assert.equal(spots.kitahori.stage, "つぼみ"); assert.match(L.popupHtml(spots.kitahori), /人が同じ場所と確認/);
  const asNew = L.planPlot(analysis({ species: "彼岸花", place_name: "伏見北堀公園", lat: 34.9415, lng: 135.7793 },
    { input: { observed_at: "2026-09-20T11:00:00+09:00", fingerprint: "k2" } }), spots, { confirm: { asNew: true }, newId: () => "n9" });
  assert.equal(asNew.action, "new"); assert.equal(asNew.spot.evidence.matchedBy, "人が別の場所と確認して追加");
  // 時期の問題がある投稿は確認ボタンを出さず保留
  const fut = analysis({ species: "彼岸花", place_name: "伏見北堀公園", lat: 34.9415, lng: 135.7793 },
    { input: { observed_at: "2026-12-20T09:40:00+09:00", fingerprint: "k3" }, analyzed_at: "2026-10-22T17:00:00+09:00" });
  const h = L.planPlot(fut, spots);
  assert.equal(h.action, "hold"); assert.doesNotMatch(h.cmpHtml, /data-confirm/);
  // 仮に確認を指定されても、現在の段階は変えず履歴にだけ残す
  const forced = L.planPlot(fut, spots, { confirm: { spotId: "kitahori" } });
  assert.equal(forced.action, "history"); L.applyPlan(spots, forced); assert.equal(spots.kitahori.stage, "つぼみ");
});

test("result and popup show capture time / time expression / area, all escaped", () => {
  const d = analysis({ area_detail: XSS, time_reference: "不明", time_note: XSS },
    { input: { observed_at: "2026-11-20T10:45:00+09:00", photo_taken_at: "2026-11-20T10:00:00+09:00", photo_time_source: XSS, fingerprint: "z" } });
  const html = L.resultHtml(d);
  assert.doesNotMatch(html, RAW_TAG);
  assert.match(html, /撮影日時<\/dt><dd>2026-11-20 10:00（日本時間・/);
  assert.match(html, /時期の表現/);
  const p = L.planPlot(d, {}, { newId: () => "q" });
  assert.doesNotMatch(p.cmpHtml + p.logHtml + L.popupHtml(p.spot), RAW_TAG);
  assert.match(L.popupHtml(p.spot), /撮影日時はEXIF（未検証）/);
});

// ---- 初期データの範囲（施設全体／園内の区域）と公園中心の問題（2026-10-22） ----
function loadSeed() {
  const ctx = { window: {} }; require("node:vm").runInNewContext(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "seed.js"), "utf8"), ctx);
  return ctx.window.SEED;
}
test("seed spots declare their scope; area spots carry an area id/label and a coordinate source", () => {
  const seed = loadSeed();
  assert.equal(seed.length, 18);
  for (const s of seed) {
    assert.ok(["site", "area"].includes(s.scope), s.id);
    assert.ok(s.coord_src, s.id);
    if (s.scope === "area") { assert.ok(s.area && s.area_id, s.id); assert.match(s.coord_src, /OpenStreetMap/); }
    else { assert.equal(s.area, ""); assert.equal(s.area_id, null); }
  }
  const t = seed.find((s) => s.id === "tofukuji");
  assert.deepEqual([t.name, t.area, t.area_id], ["東福寺", "通天橋", "tofukuji/tsutenkyo"]);
});

test("park-centre ambiguity: an area-unknown observation geocoded to the temple centre never auto-merges into an area spot", () => {
  const seed = loadSeed(), spots = {}; seed.forEach((s) => { spots[s.id] = Object.assign({ history: [] }, s); });
  const centre = { lat: 34.97717, lng: 135.77458 }; // OSM の東福寺（寺の中心）。通天橋スポットから約80m
  const mk = (area) => analysis({ place_name: "東福寺", area_detail: area, lat: centre.lat, lng: centre.lng, stage: "見頃" },
    { input: { observed_at: "2026-10-22T12:00:00+09:00", fingerprint: "pc" + area }, analyzed_at: "2026-10-22T17:00:00+09:00" });
  const none = L.planPlot(mk(""), spots);
  assert.equal(none.action, "ambiguous");
  assert.match(none.cmpHtml, /東福寺・通天橋/);
  assert.equal(spots.tofukuji.stage, "咲き始め");
  // 区域が一致すれば、位置が寺の中心でも 300m 以内なので照合できる
  assert.equal(L.planPlot(mk("通天橋"), spots).action, "update");
  // 区域つきの投稿は、施設全体スポットにも自動統合しない
  const k = analysis({ species: "彼岸花", place_name: "伏見北堀公園", area_detail: "東側の斜面", lat: 34.94151, lng: 135.77928 },
    { input: { observed_at: "2026-09-21T09:00:00+09:00", fingerprint: "ke" }, analyzed_at: "2026-09-21T10:00:00+09:00" });
  assert.equal(L.planPlot(k, spots).action, "ambiguous");
  // 区域なしの投稿は施設全体スポットに照合できる（修正後の座標＝OSM の公園中心）
  const site = analysis({ species: "彼岸花", place_name: "伏見北堀公園", area_detail: "", lat: 34.94151, lng: 135.77928 },
    { input: { observed_at: "2026-09-21T09:00:00+09:00", fingerprint: "ks" }, analyzed_at: "2026-09-21T10:00:00+09:00" });
  assert.equal(L.planPlot(site, spots).action, "update");
});

test("popup states scope and coordinate source; observation-derived areas are not presented as precise", () => {
  const seed = loadSeed();
  assert.match(L.popupHtml(seed.find((s) => s.id === "kitahori")), /施設・公園全体（園内の区域は未特定/);
  assert.match(L.popupHtml(seed.find((s) => s.id === "kitahori")), /座標の出典：OpenStreetMap way\/559352244/);
  assert.match(L.popupHtml(seed.find((s) => s.id === "irohazaka")), /区域「明智平」（区域ID irohazaka\/akechidaira）/);
  const p = L.planPlot(analysis({ place_name: "テスト公園", area_detail: "東側の斜面" }), {}, { newId: () => "o" });
  assert.equal(p.spot.scope, "observed_area");
  assert.match(L.popupHtml(p.spot), /区域の位置は未確認/);
});

test("sample cards and source labels say 合成デモデータ", () => {
  assert.match(L.sampleCardHtml({ id: "s3", image: "a.jpg", text: "t", handle: "@sample_x", posted: "2026-10-20 11:05" }), /合成デモデータ/);
  assert.match(L.sourceLabel({ sample: "s3" }), /合成デモデータ/);
  assert.doesNotMatch(L.sourceLabel({ sample: null }), /合成/);
});

test("recorded real-Gemini outputs (2026-10-22) still produce the three demo scenarios against the corrected seed", () => {
  const { rows, spots } = require("../docs/evidence/scripts/demo-simulate.js");
  const by = Object.fromEntries(rows.map((r) => [r.name, r.action]));
  assert.equal(by.demo_s3, "new");                     // (a) 根拠が十分 → 地図に反映
  assert.equal(by.demo_s6, "ambiguous");               // (b) 区域「明智平」と区域未特定の投稿 → 人の確認
  assert.equal(by["demo_s6（人が候補を確認）"], "update");
  assert.equal(by.demo_s8, "history");                 // (c) 過去の写真 → 現在の段階は変えない
  assert.equal(spots.tofukuji.stage, "咲き始め");
  assert.equal(by.edge_e_park_centre, "ambiguous");    // 公園（寺）中心の位置で区域スポットに自動統合しない
});
