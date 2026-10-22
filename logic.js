// みんなの"見頃"マップ — フロントエンドの純粋ロジック（DOM / Leaflet に依存しない）。
// ブラウザでは window.MigoroLogic、Node では require("./logic.js") で使う（tests/frontend.test.js）。
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MigoroLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const STAGES = ["つぼみ", "咲き始め", "見頃", "散り始め", "終わり"];
  const CONSISTENCY = ["一致", "一部不一致", "矛盾"];
  const STAGE = { "つぼみ": "#8aa05a", "咲き始め": "#e09a3a", "見頃": "#c41e3a", "散り始め": "#9a7d80", "終わり": "#5e5354" };
  const MOMIJI = { "つぼみ": "青葉", "咲き始め": "色づき始め", "見頃": "見頃", "散り始め": "落葉始め", "終わり": "落葉" };
  const HOLD_BELOW = 0.6;          // 確信度がこれ未満なら地図は更新せず「保留（要確認）」
  const MATCH_RADIUS_KM = 4;       // 同種・この距離以内を照合候補にする
  const AUTO_MATCH_RADIUS_KM = 0.3; // 自動統合の上限。測位精度を保証する値ではない
  const JAPAN_BBOX = [20.0, 46.5, 122.0, 154.5];
  const JST_OFFSET_MS = 9 * 3600 * 1000;
  const FUTURE_TOLERANCE_MS = 10 * 60 * 1000; // 端末の時計のずれとして許す幅
  const STALE_DAYS = 3;                         // これより古い投稿は「現在の状況とは限らない」と明示
  const PHOTO_GAP_DAYS = 2;                     // 撮影日時（EXIF）が投稿よりこれ以上前なら過去の写真として扱う
  // 表記ゆれの異体字だけを統一する（意味が変わる置換はしない）。実 Gemini は「髙尾山」「高尾山」を混在させた
  const VARIANTS = { "髙": "高", "﨑": "崎", "濵": "浜", "邊": "辺", "邉": "辺", "𠮷": "吉" };

  // ---- エスケープ ----
  function escapeHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"'`]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c]);
  }
  const e = escapeHtml;
  function stageColor(st) { return Object.prototype.hasOwnProperty.call(STAGE, st) ? STAGE[st] : "#999"; }

  function norm(sp) {
    sp = typeof sp === "string" ? sp : "";
    if (/紅葉|もみじ|モミジ|楓|カエデ/.test(sp)) return "紅葉";
    if (/彼岸花|曼珠沙華|ヒガンバナ/.test(sp)) return "彼岸花";
    if (/桜|サクラ/.test(sp)) return "桜";
    return sp;
  }
  function lab(s) {
    s = s || {};
    return norm(s.species) === "紅葉" ? (MOMIJI[s.stage] || s.stage_label || s.stage || "") : (s.stage_label || s.stage || "");
  }

  // ---- 数値・位置の検証（サーバー検証の二重防御） ----
  function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
  function inJapan(lat, lng) {
    return isNum(lat) && isNum(lng) && lat >= JAPAN_BBOX[0] && lat <= JAPAN_BBOX[1] && lng >= JAPAN_BBOX[2] && lng <= JAPAN_BBOX[3];
  }
  function pct(conf) { return isNum(conf) && conf >= 0 && conf <= 1 ? Math.round(conf * 100) : null; }
  function validateAnalysis(d) {
    if (!d || typeof d !== "object" || !d.result || typeof d.result !== "object") return { ok: false, issues: ["判定結果が空です"], location: null };
    const x = d.result, issues = [];
    if (typeof x.species !== "string" || !x.species.trim()) issues.push("種類が不明");
    if (!STAGES.includes(x.stage)) issues.push("段階が不正");
    if (pct(x.confidence) === null) issues.push("確信度が 0〜1 ではない");
    if (!(isNum(x.bloom_ratio) && x.bloom_ratio >= 0 && x.bloom_ratio <= 100)) issues.push("開花率が 0〜100 ではない");
    if (!CONSISTENCY.includes(x.consistency)) issues.push("整合性の値が不正");
    if (d.validation && d.validation.ok === false) {
      const srv = Array.isArray(d.validation.issues) ? d.validation.issues.map(String).filter(Boolean) : [];
      srv.forEach((m) => { if (!issues.includes(m)) issues.push(m); });
      if (!srv.length && !issues.length) issues.push("サーバー側の検証で不正と判定されました");
    }
    const loc = d.location;
    const location = loc && inJapan(loc.lat, loc.lng) ? loc : null;
    return { ok: issues.length === 0, issues, location };
  }

  // ---- 距離・名称の類似度・照合 ----
  function km(a, b, c, d) {
    const R = 6371, r = (x) => x * Math.PI / 180, dl = r(c - a), dn = r(d - b);
    const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function normName(s) {
    return String(s || "").normalize("NFKC").toLowerCase()
      .replace(/[\s\u3000・･·,、。.\/／()（）「」『』\[\]【】〔〕<>＜＞~〜\-－―の]/g, "");
  }
  function bigrams(s) { const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2)); return a; }
  function lcsLen(a, b) {
    let best = 0; const dp = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let prev = 0;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
        if (dp[j] > best) best = dp[j];
        prev = tmp;
      }
    }
    return best;
  }
  function nameSimilarity(a, b) {
    a = normName(a); b = normName(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const [sh, lo] = a.length <= b.length ? [a, b] : [b, a];
    if (sh.length >= 2 && lo.includes(sh)) return 0.9;
    const A = bigrams(a), B = bigrams(b).slice();
    let common = 0;
    A.forEach((g) => { const i = B.indexOf(g); if (i >= 0) { common++; B.splice(i, 1); } });
    const dice = A.length + bigrams(b).length ? (2 * common) / (A.length + bigrams(b).length) : 0;
    const l = lcsLen(a, b);
    const lcsRatio = l >= 3 ? l / sh.length : 0;
    return Math.max(dice, lcsRatio * 0.9);
  }
  // 表記の空白・全半角・異体字だけを正規化する。「の」や句読点は地点の意味を変え得るため保持。
  function nameKey(s) {
    return String(s || "").normalize("NFKC").toLowerCase().replace(/[\s\u3000]/g, "")
      .replace(/[髙﨑濵邊邉]|\u{20BB7}/gu, (c) => VARIANTS[c] || c);
  }
  function spotKey(name, area) { const a = nameKey(area); return nameKey(name) + (a ? "｜" + a : ""); }
  // 種類＋完全一致の地点名＋300m以内だけ自動照合。近隣4kmは確認候補であり同一地点とは限らない。
  function matchSpot(spots, cand, opt) {
    opt = opt || {};
    const radius = MATCH_RADIUS_KM;
    const sp = norm(cand.species), near = [];
    // 同じ公園の「東側」「西側」、園全体と一部区域を、似た名前だからという理由で統合しない。
    const cKey = spotKey(cand.name, cand.area);
    (spots || []).forEach((s) => {
      if (!inJapan(s.lat, s.lng) || norm(s.species) !== sp) return;
      const k = km(s.lat, s.lng, cand.lat, cand.lng);
      if (k <= radius) near.push({ spot: s, km: k, sim: nameSimilarity(s.name, cand.name) });
    });
    if (!near.length) return { kind: "none" };
    // 園内の区域（area_detail）も地点の一部。「北堀公園・東側」と「北堀公園・西側」は別地点
    // 区域未特定の投稿は、区域スポット（scope "area"）には名前が同じでも自動統合しない（二重の安全策）
    const strong = near.filter((n) => normName(cand.name) && spotKey(n.spot.name, n.spot.area) === cKey &&
      (nameKey(cand.area) || n.spot.scope !== "area"));
    if (strong.length > 1) return { kind: "ambiguous", reason: "multiple", candidates: strong };
    if (!strong.length || strong[0].km > AUTO_MATCH_RADIUS_KM)
      return { kind: "ambiguous", reason: "scope_unconfirmed", candidates: near.sort((p, q) => p.km - q.km) };
    return { kind: "match", spot: strong[0].spot, km: strong[0].km, sim: strong[0].sim };
  }

  // ---- 観測日時 ----
  // 厳密な ISO 8601（YYYY-MM-DD[T ]HH:MM[:SS[.fff]][Z|±HH:MM]）。存在しない日付（2/30 等）は NaN。オフセットなしは日本時間。
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|z|[+-]\d{2}:\d{2})?$/;
  function parseTime(iso) {
    if (typeof iso !== "string") return NaN;
    const m = ISO_RE.exec(iso.trim());
    if (!m) return NaN;
    const y = +m[1], mo = +m[2], d = +m[3], H = +m[4], M = +m[5], S = +(m[6] || 0), tz = m[7];
    if (y < 1970 || mo < 1 || mo > 12 || H > 23 || M > 59 || S > 59) return NaN;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d < 1 || d > dim) return NaN;
    let off = 9 * 60;
    if (tz === "Z" || tz === "z") off = 0;
    else if (tz) {
      const oh = +tz.slice(1, 3), om = +tz.slice(4, 6);
      if (oh > 23 || om > 59) return NaN;
      off = (tz[0] === "-" ? -1 : 1) * (oh * 60 + om);
    }
    return Date.UTC(y, mo - 1, d, H, M, S) - off * 60000;
  }
  function sameInstant(a, b) { const x = parseTime(a), y = parseTime(b); return Number.isFinite(x) && x === y; }
  function fmtTime(iso) {
    const t = typeof iso === "number" ? iso : parseTime(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t + JST_OFFSET_MS), p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
  function jstDay(t) { return Math.floor((t + JST_OFFSET_MS) / 86400000); }
  // 既存スポットの観測日時と新しい観測日時から、上書きしてよいかを決める
  function decideObservation(existingAt, newAt, sameStage) {
    const ex = parseTime(existingAt), nw = parseTime(newAt);
    const exKnown = Number.isFinite(ex), nwKnown = Number.isFinite(nw);
    if (!exKnown) return { action: "update", conflict: false };
    if (!nwKnown) return { action: "history", reason: `投稿日時が不明のため、掲載中の観測（${fmtTime(ex)}）は上書きしません` };
    if (nw < ex) return { action: "history", reason: `この投稿（${fmtTime(nw)}）は掲載中の観測（${fmtTime(ex)}）より古いため、履歴として記録します` };
    if (!sameStage && jstDay(nw) === jstDay(ex)) return { action: "update", conflict: true, reason: "同じ日の観測で段階が食い違っています" };
    return { action: "update", conflict: false };
  }

  // 投稿日時・撮影日時（EXIF）・分析日時・本文の時期表現から、「現在の現地の状況」として扱ってよいかを判断する。
  // block=true なら地図の現在の段階は変えない（既存スポットには履歴としてだけ残す）。
  function timeAssessment(d, opt) {
    d = d || {}; opt = opt || {};
    const input = d.input || {}, x = d.result || {};
    const postedAt = input.observed_at || d.observed_at || null, photoAt = input.photo_taken_at || null;
    const analyzedAt = d.analyzed_at || null;
    const ref = Number.isFinite(parseTime(analyzedAt)) ? parseTime(analyzedAt) : (isNum(opt.now) ? opt.now : Date.now());
    const pt = parseTime(postedAt), ph = parseTime(photoAt), day = 86400000;
    const base = { postedAt, photoAt, analyzedAt };
    if (Number.isFinite(pt) && pt > ref + FUTURE_TOLERANCE_MS)
      return Object.assign(base, { status: "future", block: true,
        note: `投稿日時（${fmtTime(pt)}）が分析日時より未来です（サンプルの架空日時など）。現在の現地の状況としては扱いません` });
    if (x.time_reference === "過去の写真・訪問")
      return Object.assign(base, { status: "past_photo", block: true,
        note: `本文が過去の写真・訪問を示しています${x.time_note ? "（" + String(x.time_note).replace(/[。．.]+$/, "") + "）" : ""}。現在の現地の状況としては扱いません` });
    if (Number.isFinite(ph) && (Number.isFinite(pt) ? pt : ref) - ph > PHOTO_GAP_DAYS * day)
      return Object.assign(base, { status: "past_photo", block: true,
        note: `撮影日時（EXIF・未検証：${fmtTime(ph)}）が${Number.isFinite(pt) ? "投稿" : "分析"}より${Math.floor(((Number.isFinite(pt) ? pt : ref) - ph) / day)}日前です。現在の現地の状況としては扱いません` });
    if (!Number.isFinite(pt))
      return Object.assign(base, { status: "unknown", block: false, note: "投稿日時が不明のため、いつの状況か確認できません" });
    const age = Math.floor((ref - pt) / day);
    if (age >= STALE_DAYS)
      return Object.assign(base, { status: "stale", block: false, note: `分析時点で投稿から${age}日経過。現在の状況とは限りません` });
    return Object.assign(base, { status: "recent", block: false, note: "" });
  }

  // ---- HTML テンプレート（動的値はすべて escapeHtml） ----
  function chipHtml(st, l) { return `<span class="chip" style="background:${stageColor(st)}">${e(l)}</span>`; }
  function sourceLabel(ev) {
    if (!ev) return "デモ初期データ（現地の現在の状況ではありません）";
    return ev.sample ? "合成デモデータ（AI生成サンプル画像・架空の投稿。実在の投稿ではありません）" : "アップロード画像・入力本文（原投稿URL未確認）";
  }
  function evidenceSnapshot(d, opt) {
    const x = d.result || {}, input = d.input || {}, loc = d.location || {};
    return { model: (d.meta && d.meta.model) || "不明", sample: input.sample || null, text: input.text || "", image: x.evidence_image || "",
      textReason: x.evidence_text || "", reasoning: x.reasoning || "", caution: x.caution || "",
      consistency: x.consistency || "不明", consistencyNote: x.consistency_note || "",
      confidence: x.confidence, locationSource: loc.source || "不明", locationNote: loc.note || "",
      analyzedAt: d.analyzed_at || null, area: x.area_detail || "", fingerprint: input.fingerprint || null,
      photoAt: input.photo_taken_at || null, photoSource: input.photo_time_source || "",
      timeReference: x.time_reference || "不明", timeNote: x.time_note || "",
      timeAssessment: timeAssessment(d).note, matchedBy: (opt && opt.matchedBy) || "" };
  }
  function evidenceHtml(ev) {
    if (!ev) return `<p>${e(sourceLabel(ev))}</p>`;
    const conf = pct(ev.confidence);
    return `<p><b>資料：</b>${e(sourceLabel(ev))}${ev.sample ? `（${e(ev.sample)}）` : ""}</p>` +
      `<p><b>写真の根拠：</b>${e(ev.image || "記録なし")}</p><p><b>本文の根拠：</b>${e(ev.textReason || "記録なし")}</p>` +
      `<p><b>AIの判断理由：</b>${e(ev.reasoning || "記録なし")}</p>` +
      `<p><b>写真と本文：</b>${e(ev.consistency || "不明")} ${e(ev.consistencyNote || "")}</p>` +
      `<details><summary>判定した本文</summary><p>${e(ev.text || "（本文なし）")}</p></details>` +
      `<p>判定モデル：${e(ev.model || "不明")}</p>` +
      `<p>AI自己申告の確信度：${conf === null ? "不明" : conf + "%"}（正解率ではありません）</p>` +
      `<p>位置：${e(ev.locationSource)}。地点名に対応する推定位置で、撮影地点・園内区域は未確認。${e(ev.locationNote)}</p>` +
      (ev.area ? `<p>本文が示す区域：${e(ev.area)}</p>` : "") +
      (ev.matchedBy ? `<p>地図への対応付け：${e(ev.matchedBy)}</p>` : "") +
      `<p>撮影日時：${ev.photoAt ? e(fmtTime(ev.photoAt) || "不明") + "（日本時間・" + e(ev.photoSource || "未検証") + "）" : "不明（EXIFなし・未確認）"}</p>` +
      `<p>本文の時期表現：${e(ev.timeReference || "不明")}${ev.timeNote ? "（" + e(ev.timeNote) + "）" : ""}</p>` +
      (ev.timeAssessment ? `<p>🕘 ${e(ev.timeAssessment)}</p>` : "") +
      (ev.caution ? `<p>⚠ ${e(ev.caution)}</p>` : "") +
      (ev.analyzedAt ? `<p>分析日時：${e(fmtTime(ev.analyzedAt) || "不明")}（日本時間）</p>` : "");
  }
  // スポットの範囲（施設全体か園内の区域か）と、地図上の座標が何を表すか
  function scopeHtml(s) {
    if (s.scope === "area" && s.area)
      return `範囲：区域「${e(s.area)}」${s.area_id ? `（区域ID ${e(s.area_id)}）` : ""}`;
    if (s.area)
      return `範囲：本文が示す区域「${e(s.area)}」。地図上の位置は施設名から推定した代表点で、区域の位置は未確認`;
    return "範囲：施設・公園全体（園内の区域は未特定。地図上の位置は代表点）";
  }
  function popupHtml(s) {
    const obs = fmtTime(s.observed_at) || "不明";
    const history = Array.isArray(s.history) ? s.history : [];
    const recent = history.slice(-5).reverse().map((h) => `<li>${fmtTime(h.observed_at) ? e(fmtTime(h.observed_at)) + "（日本時間）" : "投稿日時不明"}・${e(lab({species:s.species, ...h}))}` +
      (h.note ? `<br><small>${e(h.note)}</small>` : "") + evidenceHtml(h.evidence) + `</li>`).join("");
    const fps = new Set(history.map((h) => h.evidence && h.evidence.fingerprint).filter(Boolean));
    return `<b>${e(s.name)}${s.area ? "・" + e(s.area) : ""}</b><br>${e(s.place)}<br><small>${scopeHtml(s)}</small>` +
      (s.coord_src ? `<br><small>座標の出典：${e(s.coord_src)}</small>` : "") + `<br>${e(s.species)}：<b style="color:${stageColor(s.stage)}">${e(lab(s))}</b>` +
      (s.flag ? `<br><span style="color:#b36200">⚠ 要確認：${e(s.flag)}</span>` : "") +
      `<br>投稿日時：${obs === "不明" ? "不明" : e(obs) + "（日本時間）"}<br><small>投稿日時は撮影日時ではありません。${s.evidence && s.evidence.photoAt ? "撮影日時はEXIF（未検証）の値を下に表示。" : "撮影日時は未確認。"}投稿日時だけでは現在の見頃を保証できません。</small>` +
      (s.timeNote ? `<br><small>🕘 ${e(s.timeNote)}</small>` : "") +
      evidenceHtml(s.evidence) +
      (recent ? `<details><summary>記録履歴 ${history.length} 件（内容の異なる入力 ${fps.size} 件・独立した投稿数ではありません／直近の登録5件まで表示）</summary><ol>${recent}</ol></details>` : "");
  }
  function sampleCardHtml(s) {
    return `<button class="post" data-id="${e(s.id)}"><span class="synth">合成デモデータ</span><img src="${e(s.image)}" alt="AI生成のサンプル画像"><div class="t">${e(s.text)}</div><div class="h">${e(s.handle)} · ${e(s.posted)}</div></button>`;
  }
  function resultHtml(d) {
    const x = d.result || {}, meta = d.meta || {}, v = validateAnalysis(d), c = stageColor(x.stage);
    const ratio = isNum(x.bloom_ratio) && x.bloom_ratio >= 0 && x.bloom_ratio <= 100 ? Math.round(x.bloom_ratio) : null;
    const conf = pct(x.confidence);
    const obs = (d.input && d.input.observed_at) || d.observed_at, input = d.input || {}, ta = timeAssessment(d);
    const warn = !v.ok ? `<div class="warnbox">⚠ 要確認：Gemini の出力に不正な値があるため地図は更新しません（${e(v.issues.join(" / "))}）</div>`
      : !v.location ? `<div class="warnbox">⚠ 要確認：位置を特定できないため地図は更新しません</div>` : "";
    const cons = x.consistency === "一致" ? "ok" : x.consistency === "矛盾" ? "ng" : "part";
    return `<div class="rh"><span class="gem">✦ ${e(meta.model || "Gemini")}</span><span>${e(isNum(meta.latency_s) ? meta.latency_s : "—")}s · 構造化JSON出力</span></div>
  <div class="rb reveal">${warn}<div class="evidence-note">${e(sourceLabel(evidenceSnapshot(d)))}。撮影日時・原投稿の真正性は未確認。地点名に対応する推定位置で、園内の範囲は未確認。AI確信度は正解率ではありません。</div>
    <div class="big"><span class="species">${e(x.species || "—")}</span><span class="stage" style="background:${c}">${e(lab(x) || "—")}</span></div>
    <dl class="kv">
      <dt>投稿日時</dt><dd>${obs ? e(fmtTime(obs)) + "（日本時間）" : "不明"}${ta.note ? `<div class="tnote">🕘 ${e(ta.note)}</div>` : ""}</dd>
      <dt>撮影日時</dt><dd>${input.photo_taken_at ? e(fmtTime(input.photo_taken_at)) + "（日本時間・" + e(input.photo_time_source || "未検証") + "）" : "不明（EXIFなし・未確認）"}</dd>
      <dt>時期の表現</dt><dd>${e(x.time_reference || "不明")}${x.time_note ? " " + e(x.time_note) : ""}</dd>${d.input && !d.input.sample ? `
      <dt>判定した本文</dt><dd>${e(d.input.text || "（本文なし）")}</dd>` : ""}
      <dt>開花率（推定）</dt><dd>${ratio === null ? "—" : ratio + "%"}<div class="bar"><i id="br" data-w="${ratio || 0}" style="background:${c}"></i></div></dd>
      <dt>AI確信度</dt><dd>${conf === null ? "—" : conf + "%"}<div class="bar"><i id="cf" data-w="${conf || 0}" style="background:#4285f4"></i></div></dd>
      <dt>推定場所</dt><dd>${e(x.place_name)}（${e(x.prefecture)} ${e(x.municipality)}）${x.area_detail ? `<br>区域：${e(x.area_detail)}` : ""}</dd>
      <dt>写真の根拠</dt><dd>${e(x.evidence_image || "—")}</dd>
      <dt>本文の根拠</dt><dd>${e(x.evidence_text || "—")}</dd>
      <dt>写真と本文</dt><dd><span class="cons ${cons}">${e(x.consistency || "—")}</span> ${e(x.consistency_note)}</dd>
    </dl>
    <div class="why"><b>Gemini の判断理由</b>${e(x.reasoning)}${x.caution ? `<br><span style="color:#8a5a12">⚠ ${e(x.caution)}</span>` : ""}</div>
    <div class="cmp" id="cmp"></div>
    <details><summary>Gemini の出力（JSON）</summary><pre>${e(JSON.stringify(x, null, 2))}</pre></details>
  </div>`;
  }
  function staleHtml(reason) { return `<div class="rb stale"><div class="warnbox">⚠ ${e(reason || "投稿の本文・日時が変更されたため、前の判定結果は破棄しました。もう一度「Gemini で読み解く」を押してください。")}</div></div>`; }
  function errorHtml(msg) { return `<div class="rb err" style="color:#b00">エラー：${e(msg)}</div>`; }

  // ---- 地図への反映計画（副作用なし。index.html が Leaflet に適用する） ----
  function planPlot(d, spots, opt) {
    opt = opt || {};
    const list = Array.isArray(spots) ? spots : Object.values(spots || {});
    const v = validateAnalysis(d), x = (d && d.result) || {};
    const sp = norm(x.species), conf = pct(x.confidence);
    const observedAt = (d && d.input && d.input.observed_at) || (d && d.observed_at) || null;
    const head = `<b class="t">地図との自動照合</b>`;
    const newLab = lab({ species: sp, stage: x.stage, stage_label: x.stage_label });
    const place = x.place_name || "（場所不明）";
    if (!v.ok) {
      return { action: "invalid", cmpHtml: head + `<div class="dec flag">⚠ 要確認：Gemini の出力に不正な値があるため地図は更新しません（${e(v.issues.join(" / "))}）</div>`,
        logHtml: `<b>要確認</b> ${e(place)}：出力が不正（${e(v.issues.join(" / "))}）` };
    }
    if (!v.location) {
      return { action: "unlocatable", cmpHtml: head + `<div class="dec flag">⚠ 要確認：位置を特定できない（または日本の範囲外）ため地図は更新しません</div>`,
        logHtml: `<b>要確認</b> ${e(place)}：位置を特定できません` };
    }
    const loc = v.location, input = (d && d.input) || {}, ta = timeAssessment(d, opt);
    const fp = input.fingerprint || null;
    // 同じ画像＋同じ本文の再投入は、投稿日時の有無にかかわらず何も変えない（未解決の要確認も維持）
    const dupSpot = fp ? list.find((s) => (s.history || []).some((h) => h.evidence && h.evidence.fingerprint === fp)) : null;
    if (dupSpot) {
      return { action: "duplicate", spotId: dupSpot.id,
        cmpHtml: head + `<div class="dec hold">＝ 同じ画像・本文はすでに「${e(dupSpot.name)}」に記録済みのため地図は変更しません${dupSpot.flag ? "（要確認は維持）" : ""}</div>`,
        logHtml: `<b>重複</b> ${e(dupSpot.name)}：同じ画像・本文の再投入` };
    }
    let m = matchSpot(list, { species: sp, lat: loc.lat, lng: loc.lng, name: x.place_name, area: x.area_detail });
    let matchedBy = m.kind === "match" ? "自動（種類・地点名・区域が一致し300m以内）" : "";
    // 要確認の候補を人が選んだ場合だけ、その候補に統合する（候補外の ID は無視）
    const cf = opt.confirm;
    if (cf && m.kind === "ambiguous") {
      const c = cf.spotId != null ? m.candidates.find((c) => c.spot.id === cf.spotId) : null;
      if (c) { m = { kind: "match", spot: c.spot, km: c.km, sim: c.sim, manual: true }; matchedBy = "人が同じ場所と確認"; }
      else if (cf.asNew) { m = { kind: "none", manual: true }; matchedBy = "人が別の場所と確認して追加"; }
    }
    if (x.confidence < HOLD_BELOW) {
      const hit = m.kind === "match" ? m.spot : null;
      return { action: "hold", cmpHtml: head + `<div class="row">${hit ? `掲載中 ${chipHtml(hit.stage, lab(hit))}（${e(hit.name)}）` : "掲載なし"} → Gemini ${chipHtml(x.stage, newLab)}</div>` +
        `<div class="dec hold">⏸ 保留：確信度 ${conf}% のため地図は更新せず、要確認リストへ</div>`,
        logHtml: `<b>保留</b> ${e(place)}：確信度 ${conf}%（要確認）` };
    }
    const timeHold = () => ({ action: "hold", reason: "time",
      cmpHtml: head + `<div class="row">Gemini ${chipHtml(x.stage, newLab)}「${e(place)}」</div><div class="dec hold">🕘 保留：${e(ta.note)}（地図は更新しません）</div>`,
      logHtml: `<b>保留</b> ${e(place)}：${e(ta.note)}` });
    if (m.kind === "ambiguous") {
      if (ta.block) return timeHold();
      const top = m.candidates.slice(0, 3);
      const dn = (sp) => sp.name + (sp.area ? "・" + sp.area : "（施設全体）");
      const names = top.map((c) => `${e(dn(c.spot))}（${c.km.toFixed(1)}km）`).join("、");
      const buttons = `<div class="confirm-row">` + top.map((c) =>
        `<button type="button" class="confirm" data-confirm="spot" data-spot="${e(c.spot.id)}">「${e(dn(c.spot))}」と同じ場所として反映</button>`).join("") +
        `<button type="button" class="confirm" data-confirm="new">別の場所として追加</button></div>`;
      return { action: "ambiguous", candidates: top.map((c) => ({ id: c.spot.id, name: c.spot.name, km: c.km })),
        cmpHtml: head + `<div class="row">近くの同種スポット：${names} → Gemini ${chipHtml(x.stage, newLab)}「${e(place)}${x.area_detail ? "・" + e(x.area_detail) : ""}」</div>` +
        `<div class="dec flag">⚠ 要確認：地点名・範囲・距離を確認できないため自動では統合せず、地図は更新しません（近隣でも別の咲き方をする可能性があります）。同じ場所かどうかを人が確認してください</div>` + buttons,
        logHtml: `<b>要確認</b> ${e(place)}${x.area_detail ? "・" + e(x.area_detail) : ""}：近くの「${e(dn(m.candidates[0].spot))}」と同一か不明` };
    }
    const flag = x.consistency === "矛盾" ? `本文と写真が矛盾（${x.consistency_note || "本文の表現と写真の状態が食い違う"}）→ 写真の判定を優先` : "";
    const src = `Gemini 判定（${(d.meta && d.meta.model) || "Gemini"}・確信度${conf}%）・位置：${loc.source || "—"}`;
    const evidence = evidenceSnapshot(d, { matchedBy: matchedBy || "新規（4km以内に同種の掲載なし）" });
    const info = { evidence, species: sp, stage: x.stage, stage_label: x.stage_label, flag, src, observed_at: observedAt, timeNote: ta.note };
    const obsTxt = observedAt ? fmtTime(observedAt) : "";
    const tnote = ta.note && !ta.block ? `<div class="tnote">🕘 ${e(ta.note)}</div>` : "";
    if (m.kind === "match") {
      const s = m.spot, prevLab = lab(s), same = s.stage === x.stage;
      const where = `<div style="font-size:11px;color:#6d5c60">照合先：${e(s.name)}（${m.km.toFixed(1)}km・${e(matchedBy)}）・掲載中の観測：${s.observed_at ? e(fmtTime(s.observed_at)) : "日時不明"}・${e(s.src)}</div>`;
      const row = `<div class="row">掲載中 ${chipHtml(s.stage, prevLab)} → Gemini ${chipHtml(x.stage, newLab)} <span style="color:#6d5c60">確信度 ${conf}%・投稿 ${obsTxt ? e(obsTxt) : "日時不明"}</span></div>`;
      const histEntry = { evidence, observed_at: observedAt, stage: x.stage, stage_label: x.stage_label, src };
      // 同じ観測（同じ投稿日時・同じ段階）の重複は何も変えない（未解決の要確認も維持）
      if (observedAt && (s.history || []).some((h) => sameInstant(h.observed_at, observedAt) && h.stage === x.stage)) {
        return { action: "duplicate", spotId: s.id,
          cmpHtml: head + row + where + `<div class="dec hold">＝ 同じ観測（${e(obsTxt)}・${e(newLab)}）の重複のため地図は変更しません${s.flag ? "（要確認は維持）" : ""}</div>`,
          logHtml: `<b>重複</b> ${e(s.name)}：${e(newLab)}（投稿 ${e(obsTxt)}）は記録済み` };
      }
      // 未来の日時・過去の写真は現在の段階を上書きせず、履歴としてだけ残す
      const ob = ta.block ? { action: "history", reason: ta.note } : decideObservation(s.observed_at, observedAt, same);
      if (ob.action === "history") {
        return { action: "history", spotId: s.id, history: Object.assign(histEntry, { note: ob.reason }),
          cmpHtml: head + row + where + `<div class="dec hold">🕘 ${e(ob.reason)}（地図の段階は変更しません）</div>`,
          logHtml: `<b>履歴</b> ${e(s.name)}：${e(newLab)}（投稿 ${obsTxt ? e(obsTxt) : "日時不明"}）は${ta.block ? "現在の状況として扱えないため" : "掲載中より新しくないため"}上書きせず` };
      }
      // 同日の段階の食い違い（conflict）は、写真と本文の整合性（consFlag）とは別に記録し、
      // 後日（JST で翌日以降）の観測が来るまで解除しない
      const t = parseTime(observedAt), day = Number.isFinite(t) ? jstDay(t) : null;
      let conflict = null, kept = false;
      if (ob.conflict) conflict = { reason: ob.reason, day };
      else if (s.conflict && !(day !== null && day > s.conflict.day)) { conflict = s.conflict; kept = true; }
      const patch = Object.assign({}, info, { consFlag: flag, conflict });
      patch.flag = [flag, conflict && conflict.reason].filter(Boolean).join("／");
      const why = ob.conflict ? e(ob.reason) + "。" : kept ? "同じ日の段階の食い違いが未解決のため要確認を維持。" : "";
      const dec = patch.flag ? `<div class="dec flag">⚠ ${why}${flag ? "写真を優先して反映し、" : "反映し、"}要確認フラグを付与</div>`
        : `<div class="dec upd">${same ? (obsTxt ? `✓ 掲載情報と一致（確認日時を ${e(obsTxt)} に更新）` : "✓ 掲載情報と一致") : "↻ 掲載情報を更新"}${s.conflict && !conflict ? "（後日の観測により要確認を解除）" : ""}</div>`;
      return { action: "update", spotId: s.id, patch, history: histEntry, cmpHtml: head + row + where + dec + tnote,
        logHtml: `<b>${patch.flag ? "更新（要確認）" : "更新"}</b> ${e(s.name)}：${e(prevLab)} → <b style="color:${stageColor(x.stage)}">${e(newLab)}</b>（確信度${conf}%）${patch.flag ? "<br>⚠ " + e(patch.flag) : ""}` };
    }
    if (ta.block) return timeHold();
    const id = opt.newId ? opt.newId() : "g" + Date.now();
    const spot = Object.assign({ id, name: place, area: x.area_detail || "", scope: x.area_detail ? "observed_area" : "site", place: `${x.prefecture || ""} ${x.municipality || ""}`.trim(), lat: loc.lat, lng: loc.lng, history: [] }, info, { consFlag: flag, conflict: null });
    const dec = flag ? `<div class="dec flag">⚠ 新規追加（要確認フラグ付き）</div>` : `<div class="dec new">＋ ${m.manual ? "人が別の場所と確認 → 新しいスポットとして追加" : "掲載なし → 新しいスポットとして追加"}</div>`;
    return { action: "new", spot, history: { evidence, observed_at: observedAt, stage: x.stage, stage_label: x.stage_label, src },
      cmpHtml: head + `<div class="row">${m.manual ? "近くの候補とは別の場所" : `掲載なし（同種・${MATCH_RADIUS_KM}km以内）`} → Gemini ${chipHtml(x.stage, newLab)} <span style="color:#6d5c60">確信度 ${conf}%</span></div>` + dec + tnote,
      logHtml: `<b>新規</b> ${e(sp)}・${e(spot.name)}${spot.area ? "・" + e(spot.area) : ""}（${e(x.prefecture)}）：<b style="color:${stageColor(x.stage)}">${e(newLab)}</b>（確信度${conf}%）` };
  }

  // 反映計画をスポット表に適用する（Leaflet 以外の状態変更はすべてここ）。変更したスポットを返す。
  function applyPlan(spots, p) {
    if (!p) return null;
    if (p.action === "update" || p.action === "history") {
      const s = spots[p.spotId]; if (!s) return null;
      (s.history || (s.history = [])).push(p.history);
      if (p.action === "update") Object.assign(s, p.patch);
      return s;
    }
    if (p.action === "new") { const s = p.spot; s.history = [p.history]; spots[s.id] = s; return s; }
    return null;
  }

  // ---- 競合対策 ----
  // 分析リクエスト：同時に 1 件だけ。新しい選択や再実行で古いリクエストは中断され、その応答は捨てる。
  class RequestGate {
    constructor() { this.seq = 0; this.cur = null; }
    start(timeoutMs) {
      this.cancel();
      const id = ++this.seq, ctl = new AbortController(), st = { id, ctl, timedOut: false, timer: null };
      if (timeoutMs > 0) st.timer = setTimeout(() => { st.timedOut = true; ctl.abort(); }, timeoutMs);
      this.cur = st;
      return { id, signal: ctl.signal };
    }
    isCurrent(id) { return !!this.cur && this.cur.id === id; }
    timedOut(id) { return this.isCurrent(id) && this.cur.timedOut; }
    get busy() { return !!this.cur; }
    cancel() { if (this.cur) { clearTimeout(this.cur.timer); this.cur.ctl.abort(); this.cur = null; } }
    finish(id) { if (!this.isCurrent(id)) return false; clearTimeout(this.cur.timer); this.cur = null; return true; }
  }
  // 入力の選択（サンプル／アップロード）の版数。FileReader の完了時に最新かを確認する。
  class SelectionTracker {
    constructor() { this.v = 0; }
    next() { return ++this.v; }
    isCurrent(v) { return v === this.v; }
  }

  return { STAGES, CONSISTENCY, STAGE, MOMIJI, HOLD_BELOW, JAPAN_BBOX, escapeHtml, stageColor, norm, lab, isNum, inJapan, pct,
    validateAnalysis, km, normName, nameKey, spotKey, nameSimilarity, matchSpot, timeAssessment, parseTime, sameInstant, fmtTime, decideObservation,
    sourceLabel, evidenceSnapshot, evidenceHtml, chipHtml, popupHtml, sampleCardHtml, resultHtml, errorHtml, staleHtml, planPlot, applyPlan, RequestGate, SelectionTracker };
});
