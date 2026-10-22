#!/usr/bin/env python3
"""みんなの"見頃"マップ — demo backend (Python stdlib only).

- GEMINI_API_KEY は環境変数から読むだけ。値を表示・ログ出力しない。
- 無料枠のみ想定（課金設定なし）。ローカル (127.0.0.1) でのみ起動。
- 静的ファイルは許可リストに載った公開リソースだけを配信する（.env / .git / results / server.py などは配信しない）。
"""
import base64
import binascii
import hashlib
import json
import math
import os
import posixpath
import re
import socket
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:  # Python 3.9+。Windows など tzdata が無い環境では固定 +09:00（日本は夏時間なし）
    from zoneinfo import ZoneInfo
    JST = ZoneInfo("Asia/Tokyo")
except Exception:  # noqa
    JST = timezone(timedelta(hours=9), "JST")

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8765"))
MODELS = [m for m in [os.environ.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-lite-latest"] if m]
MODELS = list(dict.fromkeys(MODELS))
API = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"
STAGES = ["つぼみ", "咲き始め", "見頃", "散り始め", "終わり"]
CONSISTENCY = ["一致", "一部不一致", "矛盾"]
TIME_REFS = ["投稿時の様子", "過去の写真・訪問", "不明"]
FUTURE_TOLERANCE_S = 10 * 60   # 端末の時計のずれとして許す未来側の幅

# ---- 時間予算（フロントの中断・shoot.js の待ち時間と揃える） -----------------
GEMINI_BUDGET_S = float(os.environ.get("GEMINI_BUDGET_S", "120"))   # Gemini 呼び出し全体の上限
GEMINI_REQ_TIMEOUT_S = 60.0                                        # 1 リクエストの上限
GEMINI_ATTEMPTS_PER_MODEL = 2
GEOCODE_BUDGET_S = 25.0                                            # 位置照合全体の上限
CLIENT_TIMEOUT_S = int(GEMINI_BUDGET_S + GEOCODE_BUDGET_S + 15)     # フロントはこの秒数で中断
MAX_BODY = 12 * 1024 * 1024

# 日本の範囲（ざっくりした bbox。沖ノ鳥島〜択捉・与那国〜南鳥島）
JAPAN_BBOX = (20.0, 46.5, 122.0, 154.5)  # lat_min, lat_max, lng_min, lng_max

PROMPT = """あなたは日本の季節の花・紅葉の「見頃」を判定する専門家です。
SNSの現地投稿（写真＋本文）を読み、次をJSONで返してください。
- species: 対象（例: 彼岸花, 紅葉, 桜, コスモス）。写真から判断し、本文と矛盾する場合は写真を優先。
- stage: 次の5段階のいずれか: つぼみ / 咲き始め / 見頃 / 散り始め / 終わり
  （紅葉の場合: 青葉→つぼみ, 色づき始め→咲き始め, 見頃→見頃, 落葉始め→散り始め, 落葉→終わり と対応させる）
- stage_label: その種に自然な日本語の段階名（例: 色づき始め）
- bloom_ratio: 写真から推定した開花率・色づき率（0〜100の整数）
- confidence: 判定の確信度（0.0〜1.0）
- place_name: 本文から読み取れる施設・スポット名（できるだけ正式名称）。園内の区域や方角はここに入れない
- area_detail: 本文が示す園内・施設内の区域（例: 東側の斜面, 通天橋, 北口）。本文に書かれていなければ空文字。推測しない
- prefecture: 都道府県名
- municipality: 市区町村名
- lat, lng: そのスポットの推定緯度経度（わかる範囲で）。推定できない場合は 0, 0
- evidence_image: 写真から読み取った根拠（日本語、40字以内）
- evidence_text: 本文から読み取った根拠（日本語、40字以内）
- reasoning: 総合判断の理由（日本語、80字以内）
- caution: 注意点（例: 写真は一部のみ、場所により差）。なければ空文字
- consistency: 写真と本文の整合性: 一致 / 一部不一致 / 矛盾（例: 本文は「見頃」だが写真は落葉が進んでいる→矛盾）
- consistency_note: 整合性の判断理由（日本語、40字以内）
- time_reference: 写真が投稿時点の現地の様子か: 投稿時の様子 / 過去の写真・訪問 / 不明
  （本文に「去年」「先週」「以前」など過去の撮影・訪問を示す表現があれば 過去の写真・訪問。手がかりがなければ 不明）
- time_note: time_reference の根拠（日本語、40字以内）。なければ空文字
個人情報（人物・ナンバー等）には触れないこと。"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "species": {"type": "STRING"},
        "stage": {"type": "STRING", "enum": STAGES},
        "stage_label": {"type": "STRING"},
        "bloom_ratio": {"type": "INTEGER"},
        "confidence": {"type": "NUMBER"},
        "place_name": {"type": "STRING"},
        "prefecture": {"type": "STRING"},
        "municipality": {"type": "STRING"},
        "lat": {"type": "NUMBER"},
        "lng": {"type": "NUMBER"},
        "evidence_image": {"type": "STRING"},
        "evidence_text": {"type": "STRING"},
        "reasoning": {"type": "STRING"},
        "caution": {"type": "STRING"},
        "consistency": {"type": "STRING", "enum": CONSISTENCY},
        "consistency_note": {"type": "STRING"},
        "area_detail": {"type": "STRING"},
        "time_reference": {"type": "STRING", "enum": TIME_REFS},
        "time_note": {"type": "STRING"},
    },
    "required": ["species", "stage", "stage_label", "bloom_ratio", "confidence", "place_name",
                 "prefecture", "municipality", "lat", "lng", "evidence_image", "evidence_text", "reasoning", "caution",
                 "consistency", "consistency_note", "area_detail", "time_reference", "time_note"],
}

# テストで差し替えられるようにモジュール変数にしておく
_clock = time.monotonic
_sleep = time.sleep


class ApiError(Exception):
    """クライアントに返すエラー。message はキー等の秘密を含まない日本語。"""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def now_jst():
    return datetime.now(JST)


def iso_jst(dt=None):
    return (dt or now_jst()).astimezone(JST).isoformat(timespec="seconds")


def key_status():
    return "set" if os.environ.get("GEMINI_API_KEY") else "missing"


def status():
    return {"gemini_api_key": key_status(), "models": MODELS, "gemini_budget_s": GEMINI_BUDGET_S,
            "client_timeout_s": CLIENT_TIMEOUT_S}


# ---- 観測日時 -----------------------------------------------------------------
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|z|[+-]\d{2}:\d{2})?$")


def parse_observed(value):
    """投稿日時（観測日時）を Asia/Tokyo の ISO 8601（オフセット付き）にする。
    タイムゾーンなしの値は日本時間とみなす。None/空 → None。不正 → ValueError。"""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("observed_at")
    v = value.strip()
    if not _ISO_RE.match(v):  # 形式を厳密に（存在しない日付は fromisoformat が ValueError）
        raise ValueError("observed_at")
    if v.endswith(("Z", "z")):
        v = v[:-1] + "+00:00"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=JST)
    return dt.astimezone(JST).isoformat(timespec="seconds")


def is_future(observed_iso, now=None):
    """投稿日時が分析時点より（許容幅を超えて）未来か。"""
    if not observed_iso:
        return False
    now = now or now_jst()
    return datetime.fromisoformat(observed_iso) > now + timedelta(seconds=FUTURE_TOLERANCE_S)


# ---- 写真の撮影日時（EXIF DateTimeOriginal。端末の時計に依存し、真正性は未検証） ----
_EXIF_DT = re.compile(r"^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$")
_EXIF_OFF = re.compile(r"^[+-]\d{2}:\d{2}$")


def _tiff_ascii(t, le, typ, cnt, val_off):
    if typ != 2 or cnt <= 0 or cnt > 64:
        return None
    if cnt <= 4:
        raw = val_off.to_bytes(4, "little" if le else "big")[:cnt]
    else:
        if val_off + cnt > len(t):
            return None
        raw = t[val_off:val_off + cnt]
    return raw.split(b"\x00", 1)[0].decode("ascii", errors="ignore").strip()


def _tiff_ifd(t, le, off):
    """IFD の (tag -> (type, count, value/offset)) を返す。範囲外は空。"""
    bo = "little" if le else "big"
    if off < 8 or off + 2 > len(t):
        return {}
    n = int.from_bytes(t[off:off + 2], bo)
    if n > 512 or off + 2 + n * 12 > len(t):
        return {}
    out = {}
    for i in range(n):
        e = t[off + 2 + i * 12: off + 14 + i * 12]
        out[int.from_bytes(e[0:2], bo)] = (int.from_bytes(e[2:4], bo), int.from_bytes(e[4:8], bo), int.from_bytes(e[8:12], bo))
    return out


def exif_taken_at(img):
    """JPEG の EXIF から撮影日時を取り出す。無い・壊れている場合は None。
    返り値: {"at": 日本時間 ISO, "tz_assumed": オフセット情報が無く日本時間とみなしたか}"""
    try:
        if not isinstance(img, (bytes, bytearray)) or img[:2] != b"\xff\xd8":
            return None
        i, n = 2, min(len(img), 2 * 1024 * 1024)
        while i + 4 <= n:
            if img[i] != 0xFF:
                return None
            m = img[i + 1]
            if m in (0xD9, 0xDA):
                return None
            seg = int.from_bytes(img[i + 2:i + 4], "big")
            if seg < 2:
                return None
            if m == 0xE1 and img[i + 4:i + 10] == b"Exif\x00\x00":
                t = bytes(img[i + 10:i + 2 + seg])
                if t[:2] not in (b"II", b"MM"):
                    return None
                le = t[:2] == b"II"
                bo = "little" if le else "big"
                ifd0 = _tiff_ifd(t, le, int.from_bytes(t[4:8], bo))
                if 0x8769 not in ifd0:
                    return None
                ex = _tiff_ifd(t, le, ifd0[0x8769][2])
                if 0x9003 not in ex:
                    return None
                dt = _tiff_ascii(t, le, *ex[0x9003])
                mm = _EXIF_DT.match(dt or "")
                if not mm:
                    return None
                y, mo, d, hh, mi, ss = map(int, mm.groups())
                if y < 1990:
                    return None
                off = _tiff_ascii(t, le, *ex[0x9011]) if 0x9011 in ex else None
                if off and _EXIF_OFF.match(off):
                    sign = 1 if off[0] == "+" else -1
                    tz = timezone(sign * timedelta(hours=int(off[1:3]), minutes=int(off[4:6])))
                    assumed = False
                else:
                    tz, assumed = JST, True
                at = datetime(y, mo, d, hh, mi, ss, tzinfo=tz)
                return {"at": at.astimezone(JST).isoformat(timespec="seconds"), "tz_assumed": assumed}
            i += 2 + seg
    except (ValueError, IndexError, OverflowError):
        return None
    return None


def input_fingerprint(img, text):
    """同じ画像＋同じ本文の再投入を見分けるための識別子（独立した投稿であることの証明ではない）。"""
    h = hashlib.sha256()
    h.update(bytes(img))
    h.update(b"\x00")
    h.update((text or "").encode("utf-8"))
    return h.hexdigest()[:16]


# ---- モデル出力の検証 ----------------------------------------------------------
TEXT_LIMITS = {"species": 40, "stage_label": 20, "place_name": 80, "prefecture": 20, "municipality": 40,
               "evidence_image": 120, "evidence_text": 120, "reasoning": 240, "caution": 160,
               "consistency_note": 120, "area_detail": 60, "time_note": 120}
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def in_japan(lat, lng):
    lat, lng = _num(lat), _num(lng)
    if lat is None or lng is None:
        return False
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return False
    a, b, c, d = JAPAN_BBOX
    return a <= lat <= b and c <= lng <= d


def validate_result(raw):
    """Gemini の構造化出力をアプリ側で検証・正規化する。
    返り値: (clean, issues, warnings)
      issues   … 判定そのものが信用できない問題（あれば地図を更新しない）
      warnings … Gemini 推定座標の問題など（OSM で位置が取れれば続行できる）"""
    if not isinstance(raw, dict):
        raise ApiError(502, "bad_model_output", "Gemini の出力が JSON オブジェクトではありません")
    issues, warnings, out = [], [], {}
    for k, lim in TEXT_LIMITS.items():
        v = raw.get(k)
        if v is None:
            v = ""
        if not isinstance(v, str):
            issues.append(f"{k}: 文字列ではありません")
            v = ""
        out[k] = _CTRL.sub("", v).strip()[:lim]
    if not out["species"]:
        issues.append("species: 空です")
    stage = raw.get("stage")
    out["stage"] = stage if stage in STAGES else None
    if out["stage"] is None:
        issues.append("stage: 5 段階のいずれでもありません")
    cons = raw.get("consistency")
    out["consistency"] = cons if cons in CONSISTENCY else None
    if out["consistency"] is None:
        issues.append("consistency: 一致 / 一部不一致 / 矛盾 のいずれでもありません")
    br = _num(raw.get("bloom_ratio"))
    if br is None or not 0 <= br <= 100:
        issues.append("bloom_ratio: 0〜100 の数値ではありません")
        out["bloom_ratio"] = None
    else:
        out["bloom_ratio"] = int(round(br))
    conf = _num(raw.get("confidence"))
    if conf is None or not 0 <= conf <= 1:
        issues.append("confidence: 0〜1 の数値ではありません")
        out["confidence"] = None
    else:
        out["confidence"] = conf
    tref = raw.get("time_reference")
    if tref in TIME_REFS:
        out["time_reference"] = tref
    else:  # 時期の手がかりは補助情報。欠けても判定は止めず「不明」として扱う
        out["time_reference"] = "不明"
        warnings.append("time_reference: 値が無いか不正のため「不明」として扱います")
    lat, lng = _num(raw.get("lat")), _num(raw.get("lng"))
    if lat == 0 and lng == 0:  # プロンプトで「推定できない場合は 0, 0」と指定している
        warnings.append("lat/lng: Gemini は位置を推定できませんでした")
        out["lat"] = out["lng"] = None
    elif lat is None or lng is None:
        warnings.append("lat/lng: 有限の数値ではありません")
        out["lat"] = out["lng"] = None
    elif not in_japan(lat, lng):
        warnings.append(f"lat/lng: 日本の範囲外です（{lat}, {lng}）")
        out["lat"] = out["lng"] = None
    else:
        out["lat"], out["lng"] = lat, lng
    return out, issues, warnings


# ---- Gemini 呼び出し（エラー種別ごとのリトライ） ------------------------------
TRANSIENT_HTTP = {408, 429, 500, 502, 503, 504}


def redact(text):
    """外部 APIのメッセージ等から、現在の API キーやキーらしき文字列を伏せる。"""
    s = str(text)
    key = os.environ.get("GEMINI_API_KEY") or ""
    if len(key) >= 6:
        s = s.replace(key, "[REDACTED]")
    s = re.sub(r"AIza[0-9A-Za-z_\-]{10,}", "[REDACTED]", s)
    s = re.sub(r"(?i)(key=)[^&\s\"']+", r"\1[REDACTED]", s)
    return s


def _http_detail(e):
    """サーバーログ用の外部 APIエラー本文（機密情報を伏せた内容）。クライアントには返さない。"""
    try:
        raw = e.read()[:2000].decode("utf-8", errors="ignore")
    except Exception:  # noqa
        return ""
    try:
        msg = json.loads(raw).get("error", {}).get("message", "")
    except Exception:  # noqa
        msg = raw
    return redact(re.sub(r"\s+", " ", str(msg))[:200])


def _backoff(attempt, retry_after=None):
    d = min(2.0 * (2 ** attempt), 8.0)
    try:
        if retry_after is not None:
            d = max(d, min(float(retry_after), 10.0))
    except ValueError:
        pass
    return d


def call_gemini(image_b64, mime, text, budget_s=None):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise ApiError(503, "gemini_key_missing", "GEMINI_API_KEY: missing（環境変数に API キーを設定してください）")
    budget = GEMINI_BUDGET_S if budget_s is None else budget_s
    deadline = _clock() + budget
    body = json.dumps({
        "contents": [{"role": "user", "parts": [
            {"text": PROMPT},
            {"inline_data": {"mime_type": mime, "data": image_b64}},
            {"text": "【投稿本文】\n" + (text or "（本文なし）")},
        ]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.2},
    }).encode()
    failures = []  # (kind, summary)
    for model in MODELS:
        for attempt in range(GEMINI_ATTEMPTS_PER_MODEL):
            remaining = deadline - _clock()
            if remaining < 2:
                raise ApiError(504, "gemini_timeout",
                               f"Gemini の応答待ちが時間予算（{int(budget)} 秒）を超えました。" + _summary(failures))
            req = urllib.request.Request(API.format(model), data=body,
                                         headers={"Content-Type": "application/json", "x-goog-api-key": key})
            t0 = _clock()
            try:
                with urllib.request.urlopen(req, timeout=min(GEMINI_REQ_TIMEOUT_S, remaining)) as r:
                    data = json.load(r)
            except urllib.error.HTTPError as e:
                code, detail = e.code, _http_detail(e)
                print(f"[gemini] {model}: HTTP {code} {detail}", file=sys.stderr)  # 詳細はサーバーログのみ（機密情報を伏せた内容）
                # クライアントへは固定の分類メッセージだけを返す（外部 APIの本文は転送しない）
                if code in (401, 403) or (code == 400 and re.search(r"API[_ ]?key", detail, re.I)):
                    raise ApiError(502, "gemini_auth",
                                   f"Gemini API の認証・権限エラー（HTTP {code}）。API キーとその権限を確認してください。")
                if code == 400:
                    raise ApiError(502, "gemini_bad_request",
                                   "Gemini API がリクエストを受け付けませんでした（HTTP 400）。画像形式やサイズを確認してください。")
                if code == 404:
                    failures.append(("model", f"{model}: HTTP 404（モデルが利用できません）"))
                    print("[gemini] next model:", failures[-1][1], file=sys.stderr)
                    break  # 同じモデルは再試行しない
                if code in TRANSIENT_HTTP:
                    failures.append(("rate" if code == 429 else "transient", f"{model}: HTTP {code}"))
                    print("[gemini] retry:", failures[-1][1], file=sys.stderr)
                    if attempt + 1 < GEMINI_ATTEMPTS_PER_MODEL:
                        _wait(_backoff(attempt, e.headers.get("Retry-After") if e.headers else None), deadline)
                    continue
                failures.append(("other", f"{model}: HTTP {code}"))
                break
            except (socket.timeout, TimeoutError, urllib.error.URLError, ConnectionError) as e:
                failures.append(("transient", f"{model}: {type(e).__name__}（タイムアウト／通信エラー）"))
                print("[gemini] retry:", failures[-1][1], file=sys.stderr)
                if attempt + 1 < GEMINI_ATTEMPTS_PER_MODEL:
                    _wait(_backoff(attempt), deadline)
                continue
            except ValueError:
                failures.append(("output", f"{model}: 応答が JSON ではありません"))
                break
            try:
                parts = data["candidates"][0]["content"]["parts"]
                txt = "".join(p.get("text", "") for p in parts)
                out = json.loads(txt)
            except (KeyError, IndexError, TypeError, AttributeError, ValueError):
                reason = ""
                if isinstance(data, dict):
                    reason = str((data.get("promptFeedback") or {}).get("blockReason") or "")
                if reason not in ("", "SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"):
                    reason = "BLOCKED"
                failures.append(("output", f"{model}: 候補なし／JSON 解析失敗 {reason}".strip()))
                print("[gemini] next model:", failures[-1][1], file=sys.stderr)
                break  # 出力不良は別モデルで試す
            meta = data.get("usageMetadata", {}) if isinstance(data, dict) else {}
            return out, {"model": data.get("modelVersion", model), "requested_model": model,
                         "latency_s": round(_clock() - t0, 2), "tokens": meta.get("totalTokenCount"),
                         "fallbacks": [f for _, f in failures]}
    kinds = {k for k, _ in failures}
    if kinds == {"rate"}:
        raise ApiError(503, "gemini_rate_limited",
                       "Gemini 無料枠のレート制限（HTTP 429）に達しました。しばらく待ってから再試行してください。" + _summary(failures))
    if kinds and kinds <= {"rate", "transient"}:
        raise ApiError(503, "gemini_unavailable", "Gemini が混雑中、または通信できませんでした。" + _summary(failures))
    raise ApiError(502, "gemini_failed", "Gemini から有効な判定を得られませんでした。" + _summary(failures))


def _summary(failures):
    return ("（" + " / ".join(f for _, f in failures[-4:]) + "）") if failures else ""


def _wait(seconds, deadline):
    seconds = min(seconds, max(0.0, deadline - _clock() - 2))
    if seconds > 0:
        _sleep(seconds)


# ---- ジオコーディング（Nominatim：1 秒 1 回まで＋キャッシュ） ----------------
NOMINATIM = "https://nominatim.openstreetmap.org/search?"
GEO_MIN_INTERVAL_S = 1.1
GEO_CACHE_MAX = 256
_geo_lock = threading.Lock()
_geo_state = {"last": None}
_geo_cache = OrderedDict()


def _nominatim(q, deadline):
    # プロセス内で直列化し、前回から GEO_MIN_INTERVAL_S 以上空ける。
    # ロック待ちも全体の deadline に含める（残り時間を超えて待たない）。
    remaining = deadline - _clock()
    if remaining <= 0 or not _geo_lock.acquire(timeout=remaining):
        print("[geocode] skipped: 時間予算内にロックを取得できませんでした", file=sys.stderr)
        return None
    try:
        return _nominatim_locked(q, deadline)
    finally:
        _geo_lock.release()


def _nominatim_locked(q, deadline):
    if q in _geo_cache:
        _geo_cache.move_to_end(q)
        return _geo_cache[q]
    last = _geo_state["last"]
    if last is not None:
        wait = last + GEO_MIN_INTERVAL_S - _clock()
        if wait > 0:
            if _clock() + wait > deadline:
                return None
            _sleep(wait)
    if deadline - _clock() < 1:
        return None
    _geo_state["last"] = _clock()
    url = NOMINATIM + urllib.parse.urlencode(
        {"q": q, "format": "json", "limit": 1, "countrycodes": "jp", "accept-language": "ja"})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "migoro-map-demo/0.2"})
        with urllib.request.urlopen(req, timeout=min(10.0, max(1.0, deadline - _clock()))) as r:
            res = json.load(r)
    except Exception as e:  # noqa  失敗はキャッシュしない
        print("[geocode]", type(e).__name__, file=sys.stderr)
        return None
    hit = None
    try:
        if res:
            lat, lng = float(res[0]["lat"]), float(res[0]["lon"])
            if in_japan(lat, lng):
                hit = {"lat": lat, "lng": lng, "source": "OSM Nominatim", "query": q}
    except (KeyError, IndexError, TypeError, ValueError):
        hit = None
    _geo_cache[q] = hit
    while len(_geo_cache) > GEO_CACHE_MAX:
        _geo_cache.popitem(last=False)
    return hit


def geocode(place, muni, pref, budget_s=GEOCODE_BUDGET_S):
    """無料・キー不要の OSM Nominatim（低頻度のデモ用途）。失敗時は None。"""
    deadline = _clock() + budget_s
    seen = set()
    for q in [f"{place} {muni} {pref}", f"{place} {pref}", f"{muni} {pref}"]:
        q = " ".join(q.split())
        if not q or q in seen:
            continue
        seen.add(q)
        hit = _nominatim(q, deadline)
        if hit:
            return dict(hit)
        if deadline - _clock() < 1:
            break
    return None


# ---- リクエスト検証 ------------------------------------------------------------
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
MAX_TEXT = 2000


def load_samples(root=None):
    with open(os.path.join(root or ROOT, "samples", "samples.json"), encoding="utf-8") as f:
        return json.load(f)


def parse_payload(payload, root=None):
    root = root or ROOT
    if not isinstance(payload, dict):
        raise ApiError(400, "bad_request", "リクエストは JSON オブジェクトで送ってください")
    if payload.get("sample") is not None:
        sid = payload["sample"]
        if not isinstance(sid, str):
            raise ApiError(400, "bad_sample", "sample は文字列で指定してください")
        s = next((x for x in load_samples(root) if x.get("id") == sid), None)
        if s is None:
            raise ApiError(400, "unknown_sample", f"不明なサンプル ID です：{sid[:40]}")
        with open(os.path.join(root, s["image"]), "rb") as f:
            img = f.read()
        try:
            observed = parse_observed(s.get("posted"))
        except ValueError:
            observed = None
        return base64.b64encode(img).decode(), "image/jpeg", s.get("text", ""), sid, observed
    b64 = payload.get("image_b64")
    if not isinstance(b64, str) or not b64:
        raise ApiError(400, "missing_input", "sample か image_b64 のどちらかを指定してください")
    try:
        if not base64.b64decode(b64, validate=True):
            raise ValueError
    except (binascii.Error, ValueError):
        raise ApiError(400, "bad_image", "image_b64 が正しい Base64 ではありません")
    mime = payload.get("mime")
    if mime is None or mime == "":
        mime = "image/jpeg"
    if not isinstance(mime, str) or mime not in ALLOWED_MIME:
        raise ApiError(400, "bad_mime", "未対応の画像形式です（JPEG / PNG / WebP / HEIC の MIME 文字列で指定してください）")
    text = payload.get("text") or ""
    if not isinstance(text, str):
        raise ApiError(400, "bad_text", "text は文字列で指定してください")
    try:
        observed = parse_observed(payload.get("observed_at"))
    except (ValueError, TypeError):
        raise ApiError(400, "bad_observed_at", "observed_at は ISO 8601 形式（例: 2026-10-21T14:05）で指定してください")
    if is_future(observed):
        raise ApiError(400, "future_observed_at", "投稿日時が現在より未来です。日時を確認してください（日本時間）")
    return b64, mime, text[:MAX_TEXT], None, observed


# ---- 結果保存（一意な名前・排他的作成・原子的書き込み） ------------------------
def save_result(out, name, root=None):
    d = os.path.join(root or ROOT, "results")
    os.makedirs(d, exist_ok=True)
    data = json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=d)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        for _ in range(5):
            final = os.path.join(d, f"{name}-{now_jst().strftime('%Y%m%dT%H%M%S')}-{time.time_ns()}-{uuid.uuid4().hex[:8]}.json")
            try:
                os.link(tmp, final)  # 既存なら FileExistsError（上書きしない）
                return final
            except FileExistsError:
                continue
            except OSError:  # ハードリンク非対応の FS：排他的作成で書く
                fd2 = os.open(final, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd2, "wb") as f:
                    f.write(data)
                return final
        raise ApiError(500, "save_failed", "結果ファイルの保存に失敗しました")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


# ---- 分析 ----------------------------------------------------------------------
def analyze(payload, root=None):
    return analyze_parsed(parse_payload(payload, root), root)


def analyze_parsed(parsed, root=None):
    """検証済みの入力 (image_b64, mime, text, sample_id, observed) を分析する。
    異常系の検証スクリプトが、サンプル扱い（未来日時も受け付けて画面側で保留）で入力を渡すためにも使う。"""
    image_b64, mime, text, sample_id, observed = parsed
    img = base64.b64decode(image_b64)
    taken = exif_taken_at(img)
    raw, meta = call_gemini(image_b64, mime, text)
    result, issues, warnings = validate_result(raw)
    gem_ll = {"lat": result["lat"], "lng": result["lng"], "source": "Gemini 推定"} if result["lat"] is not None else None
    geo = None
    if not issues:
        geo = geocode(result["place_name"], result["municipality"], result["prefecture"])
    if geo and gem_ll:
        d = abs(geo["lat"] - gem_ll["lat"]) + abs(geo["lng"] - gem_ll["lng"])
        place_hit = bool(result["place_name"]) and geo["query"].startswith(result["place_name"])
        if not place_hit and d < 0.3:
            # OSMは市区町村までしか当たらず、Geminiの推定が同じ市区町村内 → より細かいGemini推定を採用
            geo = dict(gem_ll, source="Gemini 推定（OSMで市区町村を照合済み）")
        elif d > 1.5:
            geo["note"] = "OSMとGeminiの推定が離れているためOSMを採用"
    location = None if issues else (geo or gem_ll)
    if location is not None and not in_japan(location.get("lat"), location.get("lng")):
        warnings.append("location: 日本の範囲外です")
        location = None
    if location is None and not issues:
        warnings.append("location: 位置を特定できませんでした（地図は更新しません）")
    out = {"result": result, "meta": meta, "location": location, "gemini_location": gem_ll,
           "validation": {"ok": not issues, "issues": issues, "warnings": warnings, "locatable": location is not None},
           "input": {"text": text, "sample": sample_id, "observed_at": observed, "synthetic": bool(sample_id),
                     "photo_taken_at": taken["at"] if taken else None,
                     "photo_time_source": ("EXIF（未検証・時差情報なしのため日本時間とみなす）" if taken["tz_assumed"] else "EXIF（未検証）")
                     if taken else None,
                     "fingerprint": input_fingerprint(img, text)},
           "observed_at": observed,
           "analyzed_at": iso_jst()}
    save_result(out, sample_id or "upload", root)
    return out


# ---- 静的ファイル（許可リスト方式） --------------------------------------------
STATIC_EXACT = {"/": "index.html", "/index.html": "index.html", "/seed.js": "seed.js", "/logic.js": "logic.js",
                "/samples/samples.json": "samples/samples.json"}
STATIC_PATTERNS = [re.compile(r"^/samples/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$"),
                   re.compile(r"^/docs/shots/[A-Za-z0-9_-]+\.png$")]
CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".png": "image/png", ".webp": "image/webp"}


def resolve_static(raw_path, root=None):
    """URL パスを、許可された公開ファイルの絶対パスに解決する。許可外は None。
    クエリ／フラグメントを除き、パーセントデコード → 正規化してから判定する。"""
    root = os.path.realpath(root or ROOT)
    path = raw_path.split("?", 1)[0].split("#", 1)[0]
    try:
        path = urllib.parse.unquote(path, errors="strict")
    except UnicodeDecodeError:
        return None
    path = unicodedata.normalize("NFC", path)
    if not path.startswith("/") or any(c in path for c in ("\\", "\x00", "%")):
        return None
    norm = posixpath.normpath(re.sub(r"/+", "/", path))
    if any(seg.startswith(".") for seg in norm.split("/") if seg):
        return None  # ドットファイル・.git・.. を拒否
    rel = STATIC_EXACT.get(norm)
    if rel is None and any(p.match(norm) for p in STATIC_PATTERNS):
        rel = norm.lstrip("/")
    if rel is None:
        return None
    # シンボリックリンクは配信しない（リンク先がルート内の .env / results でも漏れないように）
    cur = root
    for part in rel.split("/"):
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            return None
    full = os.path.realpath(os.path.join(root, *rel.split("/")))
    if os.path.commonpath([root, full]) != root or not os.path.isfile(full):
        return None
    # 解決後の実体にも同じ公開許可リストを再適用する
    # （実体のパスが許可リストで選ばれたパスそのものと一致する場合だけ配信）
    if os.path.relpath(full, root).replace(os.sep, "/") != rel:
        return None
    return full


class Handler(BaseHTTPRequestHandler):
    root = ROOT
    server_version = "MigoroMap/0.2"
    sys_version = ""

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] " + (fmt % args) + "\n")

    def _send(self, code, body, ctype, head=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _json(self, code, obj, head=False):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8", head)

    def _get_or_head(self, head):
        if self.path.split("?", 1)[0] == "/api/status":
            return self._json(200, status(), head)
        full = resolve_static(self.path, self.root)
        if not full:
            return self._json(404, {"error": "not found"}, head)
        with open(full, "rb") as f:
            body = f.read()
        self._send(200, body, CTYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream"), head)

    def do_GET(self):
        self._get_or_head(False)

    def do_HEAD(self):
        self._get_or_head(True)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/analyze":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", ""))
            if n < 0:
                raise ValueError
        except ValueError:
            self.close_connection = True
            return self._json(400, {"error": "Content-Length が不正です", "error_code": "bad_length"})
        if n > MAX_BODY:
            self.close_connection = True
            return self._json(413, {"error": "画像が大きすぎます（12MB まで）", "error_code": "too_large"})
        try:
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "リクエスト本文が JSON ではありません", "error_code": "bad_json"})
        try:
            return self._json(200, analyze(payload, self.root))
        except ApiError as e:
            return self._json(e.status, {"error": e.message, "error_code": e.code})
        except Exception as e:  # noqa
            print("[analyze] internal error:", type(e).__name__, file=sys.stderr)
            return self._json(500, {"error": f"サーバー内部エラー（{type(e).__name__}）", "error_code": "internal"})


H = Handler  # 互換用

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--cli":
        # 例: python3 server.py --cli s3 s6 s8
        for sid in sys.argv[2:]:
            r = analyze({"sample": sid})
            print(sid, json.dumps({k: r[k] for k in ("result", "meta", "location", "validation", "observed_at")}, ensure_ascii=False))
        sys.exit(0)
    print(f"GEMINI_API_KEY: {key_status()}  models: {MODELS}")
    print(f"http://127.0.0.1:{PORT}/")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
