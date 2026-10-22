"""server.py の回帰テスト（標準ライブラリのみ。実際の Gemini / Nominatim には接続しない）。

実行: python3 -m unittest discover -s tests -v   （または make test）
"""
import base64
import http.client
import io
import json
import math
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

SECRET_MARK = "SYNTHETIC-SECRET-MARKER-42"
DUMMY_KEY = "dummy-test-key-not-real"
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64 + b"\xff\xd9"


def make_root():
    """公開ファイルと「漏れてはいけない」合成ファイルを置いた一時ルート。"""
    root = tempfile.mkdtemp(prefix="migoro-test-")
    files = {
        "index.html": "<html>index</html>",
        "seed.js": "window.SEED=[]",
        "logic.js": "// logic",
        "README.md": "readme " + SECRET_MARK,
        "server.py": "# server " + SECRET_MARK,
        ".env": "GEMINI_API_KEY=" + SECRET_MARK,
        ".git/config": "[core] " + SECRET_MARK,
        "results/mock.json": '{"x":"' + SECRET_MARK + '"}',
        "docs/shots/a.png": "PNG",
        "samples/samples.json": json.dumps([
            {"id": "s3", "image": "samples/s3.jpg", "handle": "@a", "posted": "2026-10-20 11:05", "text": "高尾山の薬王院"},
            {"id": "s7", "image": "samples/s3.jpg", "handle": "@a", "posted": "2026-11-20 10:45", "text": "高尾山の薬王院 真っ赤"},
        ], ensure_ascii=False),
    }
    for rel, body in files.items():
        p = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(body)
    with open(os.path.join(root, "samples", "s3.jpg"), "wb") as f:
        f.write(JPEG)
    return root


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def good_raw(**over):
    raw = {"species": "紅葉", "stage": "見頃", "stage_label": "見頃", "bloom_ratio": 85, "confidence": 0.9,
           "place_name": "高尾山薬王院", "prefecture": "東京都", "municipality": "八王子市", "lat": 35.625, "lng": 139.25,
           "evidence_image": "赤い葉", "evidence_text": "真っ赤", "reasoning": "写真と本文が一致", "caution": "",
           "consistency": "一致", "consistency_note": "一致",
           "area_detail": "", "time_reference": "投稿時の様子", "time_note": ""}
    raw.update(over)
    return raw


class ServerFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = make_root()
        handler = type("TestHandler", (server.Handler,), {"root": cls.root, "log_message": lambda *a: None})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.root, ignore_errors=True)

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.putrequest(method, path, skip_accept_encoding=True)  # パスをそのまま送る（クライアント側で正規化しない）
        hdrs = dict(headers or {})
        if body is not None and "Content-Length" not in hdrs:
            hdrs["Content-Length"] = str(len(body))
        for k, v in hdrs.items():
            c.putheader(k, v)
        c.endheaders()
        if body is not None:
            c.send(body)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict(r.getheaders()), data


# ---- 1. 静的ファイル -----------------------------------------------------------
class StaticFileTests(ServerFixture):
    DENIED = ["/server.py", "/%73erver.py", "/.env", "/%2eenv", "/%2Eenv", "/.env?x=1", "/.git/config",
              "/%2egit/config", "/%2Egit/%63onfig", "/foo/../results/mock.json", "/results/mock.json",
              "/results/", "/samples/../.env", "/samples/%2e%2e/server.py", "/%2e%2e/%2e%2e/etc/passwd",
              "//.env", "/./.env", "/index.html/../.env", "/%252eenv", "/README.md", "/samples/",
              "/samples/s3.jpg/..%2f..%2fserver.py", "/docs/shots/../../server.py", "/samples\\..\\server.py",
              "/%00.env", "/%ff", "/.git/", "/tests/test_server.py"]
    ALLOWED = ["/", "/index.html", "/index.html?v=2", "/seed.js", "/logic.js", "/samples/samples.json",
               "/samples/s3.jpg", "/docs/shots/a.png", "/foo/../index.html", "/%69ndex.html"]

    def test_denied_get_and_head(self):
        for method in ("GET", "HEAD"):
            for path in self.DENIED:
                with self.subTest(method=method, path=path):
                    st, hdrs, body = self.req(method, path)
                    self.assertEqual(st, 404, f"{method} {path} -> {st}")
                    self.assertNotIn(SECRET_MARK.encode(), body)

    def test_head_does_not_leak_length_of_secret(self):
        st, hdrs, body = self.req("HEAD", "/.env")
        self.assertEqual(st, 404)
        self.assertEqual(body, b"")
        st2, hdrs2, _ = self.req("HEAD", "/no-such-file")
        self.assertEqual(hdrs["Content-Length"], hdrs2["Content-Length"])

    def test_allowed_get_and_head(self):
        for path in self.ALLOWED:
            with self.subTest(path=path):
                st, hdrs, body = self.req("GET", path)
                self.assertEqual(st, 200, path)
                st2, hdrs2, body2 = self.req("HEAD", path)
                self.assertEqual(st2, 200)
                self.assertEqual(body2, b"")
                self.assertEqual(hdrs2["Content-Length"], str(len(body)))
                self.assertEqual(hdrs.get("X-Content-Type-Options"), "nosniff")

    def test_resolve_static_unit(self):
        self.assertIsNone(server.resolve_static("/%2eenv", self.root))
        self.assertIsNone(server.resolve_static("/foo/../results/mock.json", self.root))
        self.assertTrue(server.resolve_static("/samples/s3.jpg?x", self.root).endswith("s3.jpg"))

    def test_symlink_outside_root_is_denied(self):
        outside = tempfile.mkdtemp()
        try:
            with open(os.path.join(outside, "x.png"), "w") as f:
                f.write(SECRET_MARK)
            link = os.path.join(self.root, "docs", "shots", "evil.png")
            os.symlink(os.path.join(outside, "x.png"), link)
            self.assertIsNone(server.resolve_static("/docs/shots/evil.png", self.root))
        finally:
            shutil.rmtree(outside, ignore_errors=True)
            try:
                os.unlink(link)
            except OSError:
                pass

    def _link(self, rel, target_rel):
        link = os.path.join(self.root, *rel.split("/"))
        os.symlink(os.path.join(self.root, *target_rel.split("/")), link)
        self.addCleanup(lambda: os.path.lexists(link) and os.unlink(link))
        return link

    def test_symlink_inside_root_to_protected_files_is_denied(self):
        """R4: 許可パス上のシンボリックリンクがルート内の .env / results / server.py / .git を指していても配信しない。"""
        cases = {"samples/link.jpg": ".env", "samples/res.png": "results/mock.json", "docs/shots/src.png": "server.py",
                 "docs/shots/git.png": ".git/config", "samples/alias.jpg": "samples/s3.jpg"}
        for rel, target in cases.items():
            self._link(rel, target)
        for rel in cases:
            for method in ("GET", "HEAD"):
                with self.subTest(path=rel, method=method):
                    st, _, body = self.req(method, "/" + rel)
                    self.assertEqual(st, 404)
                    self.assertNotIn(SECRET_MARK.encode(), body)
                    self.assertIsNone(server.resolve_static("/" + rel, self.root))

    def test_symlinked_directory_is_denied(self):
        """ディレクトリ部分がリンク（docs/shots → results）でも拒否する。"""
        shots = os.path.join(self.root, "docs", "shots")
        moved = shots + ".real"
        os.rename(shots, moved)
        os.symlink(os.path.join(self.root, "results"), shots)
        try:
            with open(os.path.join(self.root, "results", "leak.png"), "w") as f:
                f.write(SECRET_MARK)
            st, _, body = self.req("GET", "/docs/shots/leak.png")
            self.assertEqual(st, 404)
            self.assertNotIn(SECRET_MARK.encode(), body)
        finally:
            os.unlink(shots)
            os.rename(moved, shots)
            os.unlink(os.path.join(self.root, "results", "leak.png"))

    def test_status_endpoint_never_contains_key(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": DUMMY_KEY}):
            st, _, body = self.req("GET", "/api/status")
        self.assertEqual(st, 200)
        d = json.loads(body)
        self.assertEqual(d["gemini_api_key"], "set")
        self.assertNotIn(DUMMY_KEY, body.decode())
        self.assertGreater(d["client_timeout_s"], d["gemini_budget_s"])


# ---- 入力検証（HTTP） ----------------------------------------------------------
class PostValidationTests(ServerFixture):
    def post(self, body, headers=None):
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(headers or {})
        st, _, data = self.req("POST", "/api/analyze", body, hdrs)
        return st, json.loads(data)

    def test_bad_requests_are_400(self):
        cases = [b"not json", b"[]", b"[1,2]", b'"str"', b"{}", b'{"sample": 1}', b'{"sample": "nope"}',
                 b'{"image_b64": "!!!"}', b'{"image_b64": "QUJD", "mime": "text/html"}',
                 b'{"image_b64": "QUJD", "observed_at": "yesterday"}', b"\xff\xfe",
                 # R7: 文字列以外の mime／その他フィールド
                 b'{"image_b64": "QUJD", "mime": {"type": "image/jpeg"}}', b'{"image_b64": "QUJD", "mime": ["image/jpeg"]}',
                 b'{"image_b64": "QUJD", "mime": 1}', b'{"image_b64": "QUJD", "mime": true}',
                 b'{"image_b64": {"a": 1}}', b'{"image_b64": ["QUJD"]}', b'{"sample": {"id": "s3"}}', b'{"sample": ["s3"]}',
                 b'{"image_b64": "QUJD", "text": {"a": 1}}', b'{"image_b64": "QUJD", "text": ["x"]}',
                 b'{"image_b64": "QUJD", "observed_at": {"a": 1}}', b'{"image_b64": "QUJD", "observed_at": ["2026-10-01T10:00"]}',
                 b'{"image_b64": "QUJD", "observed_at": "2026-02-30T10:00"}']
        with mock.patch.object(server, "call_gemini", side_effect=AssertionError("must not call Gemini")):
            for body in cases:
                with self.subTest(body=body):
                    st, d = self.post(body)
                    self.assertEqual(st, 400, d)
                    self.assertTrue(d["error"])
                    self.assertTrue(d["error_code"])

    def test_non_string_mime_is_bad_mime(self):
        for mime in ('{"type": "image/jpeg"}', '["image/jpeg"]', "1", "true", '"text/html"'):
            with self.subTest(mime=mime):
                st, d = self.post(('{"image_b64": "QUJD", "mime": %s}' % mime).encode())
                self.assertEqual((st, d["error_code"]), (400, "bad_mime"))

    def test_unknown_sample_message(self):
        st, d = self.post(b'{"sample": "s999"}')
        self.assertEqual((st, d["error_code"]), (400, "unknown_sample"))
        self.assertIn("s999", d["error"])

    def test_too_large(self):
        st, d = self.post(b"{}", {"Content-Length": str(server.MAX_BODY + 1)})
        self.assertEqual(st, 413)

    def test_upstream_error_is_passed_with_code(self):
        err = server.ApiError(502, "gemini_auth", "Gemini API の認証・権限エラー（HTTP 401）")
        with mock.patch.object(server, "call_gemini", side_effect=err):
            st, d = self.post(b'{"sample": "s3"}')
        self.assertEqual((st, d["error_code"]), (502, "gemini_auth"))

    def test_success_roundtrip(self):
        with mock.patch.object(server, "call_gemini", return_value=(good_raw(), {"model": "m", "latency_s": 1.0})), \
                mock.patch.object(server, "geocode", return_value=None):
            st, d = self.post(b'{"sample": "s7"}')
        self.assertEqual(st, 200)
        self.assertEqual(d["input"]["observed_at"], "2026-11-20T10:45:00+09:00")
        self.assertEqual(d["location"]["lat"], 35.625)


# ---- 5. モデル出力の検証 -------------------------------------------------------
class ValidateResultTests(unittest.TestCase):
    def test_good(self):
        out, issues, warns = server.validate_result(good_raw())
        self.assertEqual((issues, warns), ([], []))
        self.assertEqual(out["bloom_ratio"], 85)

    def test_bad_coordinates_are_dropped(self):
        for lat, lng in [(95, 999), (float("nan"), 139), (35, float("inf")), ("35.6", 139.7), (True, 139),
                         (None, None), (0, 0), (40.7, -74.0), (-35.6, 139.7)]:
            with self.subTest(lat=lat, lng=lng):
                out, issues, warns = server.validate_result(good_raw(lat=lat, lng=lng))
                self.assertEqual(issues, [])
                self.assertIsNone(out["lat"])
                self.assertIsNone(out["lng"])
                self.assertTrue(warns)

    def test_missing_lat_lng(self):
        raw = good_raw()
        del raw["lat"], raw["lng"]
        out, issues, warns = server.validate_result(raw)
        self.assertIsNone(out["lat"])

    def test_critical_issues(self):
        bad = [dict(confidence=1.5), dict(confidence=-0.1), dict(confidence="0.9"), dict(confidence=float("nan")),
               dict(confidence=None), dict(bloom_ratio=120), dict(bloom_ratio=-1), dict(bloom_ratio="80"),
               dict(bloom_ratio=float("inf")), dict(stage="満開"), dict(stage=None), dict(consistency="不明"),
               dict(species=""), dict(species=None), dict(species=123), dict(reasoning=["x"])]
        for over in bad:
            with self.subTest(over=over):
                out, issues, warns = server.validate_result(good_raw(**over))
                self.assertTrue(issues, over)

    def test_not_object(self):
        for raw in ([], "x", None, 1):
            with self.assertRaises(server.ApiError):
                server.validate_result(raw)

    def test_strings_trimmed_and_limited(self):
        out, _, _ = server.validate_result(good_raw(reasoning="a\x00b" + "x" * 1000))
        self.assertTrue(out["reasoning"].startswith("ab"))
        self.assertLessEqual(len(out["reasoning"]), server.TEXT_LIMITS["reasoning"])


# ---- analyze（観測日時・位置・保存） ------------------------------------------
class AnalyzeTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.meta = {"model": "test-model", "latency_s": 0.1}

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_analyze(self, payload, raw, geo=None):
        with mock.patch.object(server, "call_gemini", return_value=(raw, self.meta)), \
                mock.patch.object(server, "geocode", return_value=geo) as g:
            out = server.analyze(payload, self.root)
        return out, g

    def test_sample_carries_observed_at(self):
        out, _ = self.run_analyze({"sample": "s3"}, good_raw())
        self.assertEqual(out["input"]["observed_at"], "2026-10-20T11:05:00+09:00")
        self.assertEqual(out["observed_at"], out["input"]["observed_at"])
        self.assertEqual(out["input"]["sample"], "s3")

    def test_upload_observed_at(self):
        b64 = base64.b64encode(JPEG).decode()
        out, _ = self.run_analyze({"image_b64": b64, "observed_at": "2026-10-21T14:05"}, good_raw())
        self.assertEqual(out["input"]["observed_at"], "2026-10-21T14:05:00+09:00")
        out, _ = self.run_analyze({"image_b64": b64, "observed_at": "2026-10-21T05:05:00Z"}, good_raw())
        self.assertEqual(out["input"]["observed_at"], "2026-10-21T14:05:00+09:00")
        out, _ = self.run_analyze({"image_b64": b64}, good_raw())
        self.assertIsNone(out["input"]["observed_at"])

    def test_unknown_sample(self):
        with self.assertRaises(server.ApiError) as cm:
            server.parse_payload({"sample": "zzz"}, self.root)
        self.assertEqual(cm.exception.status, 400)

    def test_invalid_location_no_map_update(self):
        out, _ = self.run_analyze({"sample": "s3"}, good_raw(lat=95, lng=999), geo=None)
        self.assertIsNone(out["location"])
        self.assertTrue(out["validation"]["ok"])
        self.assertFalse(out["validation"]["locatable"])

    def test_geocode_outside_japan_rejected(self):
        out, _ = self.run_analyze({"sample": "s3"}, good_raw(lat=None, lng=None),
                                  geo={"lat": 48.85, "lng": 2.35, "source": "OSM Nominatim", "query": "x"})
        self.assertIsNone(out["location"])

    def test_geocode_used_when_gemini_coords_invalid(self):
        geo = {"lat": 35.62, "lng": 139.24, "source": "OSM Nominatim", "query": "高尾山薬王院 八王子市 東京都"}
        out, _ = self.run_analyze({"sample": "s3"}, good_raw(lat=95, lng=999), geo=geo)
        self.assertEqual(out["location"]["lat"], 35.62)

    def test_critical_issue_skips_geocode(self):
        out, g = self.run_analyze({"sample": "s3"}, good_raw(confidence=7))
        g.assert_not_called()
        self.assertFalse(out["validation"]["ok"])
        self.assertIsNone(out["location"])

    def test_result_saved(self):
        out, _ = self.run_analyze({"sample": "s3"}, good_raw())
        files = os.listdir(os.path.join(self.root, "results"))
        self.assertEqual(len([f for f in files if f.startswith("s3-")]), 1)


# ---- 7. 結果ファイル名の一意性 -------------------------------------------------
class SaveResultTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def files(self):
        return sorted(os.listdir(os.path.join(self.root, "results")))

    def test_same_second_does_not_overwrite(self):
        fixed = datetime(2026, 10, 22, 9, 0, 0, tzinfo=server.JST)
        with mock.patch.object(server, "now_jst", return_value=fixed), \
                mock.patch.object(server.time, "time_ns", return_value=1):
            server.save_result({"n": 1}, "upload", self.root)
            server.save_result({"n": 2}, "upload", self.root)
        fs = self.files()
        self.assertEqual(len(fs), 2)
        contents = sorted(read_json(os.path.join(self.root, "results", f))["n"] for f in fs)
        self.assertEqual(contents, [1, 2])

    def test_name_collision_retries_without_overwrite(self):
        U = type("U", (), {"__init__": lambda self, h: setattr(self, "hex", h)})
        seq = [U("a" * 32), U("a" * 32), U("b" * 32)]
        with mock.patch.object(server.time, "time_ns", return_value=1), \
                mock.patch.object(server, "now_jst", return_value=datetime(2026, 1, 1, tzinfo=server.JST)), \
                mock.patch.object(server.uuid, "uuid4", side_effect=seq):
            server.save_result({"n": 1}, "upload", self.root)
            server.save_result({"n": 2}, "upload", self.root)
        fs = self.files()
        self.assertEqual(len(fs), 2)
        self.assertTrue(any("bbbbbbbb" in f for f in fs))

    def test_concurrent_writes(self):
        ths = [threading.Thread(target=server.save_result, args=({"n": i}, "s1", self.root)) for i in range(30)]
        [t.start() for t in ths]
        [t.join() for t in ths]
        fs = self.files()
        self.assertEqual(len(fs), 30)
        self.assertFalse([f for f in fs if f.startswith(".tmp-")])
        ns = sorted(read_json(os.path.join(self.root, "results", f))["n"] for f in fs)
        self.assertEqual(ns, list(range(30)))


# ---- 8. タイムゾーン -----------------------------------------------------------
class TimezoneTests(unittest.TestCase):
    def test_iso_jst_independent_of_host_tz(self):
        old = os.environ.get("TZ")
        try:
            for tz in ("UTC", "America/New_York", "Asia/Tokyo"):
                os.environ["TZ"] = tz
                if hasattr(time, "tzset"):
                    time.tzset()
                s = server.iso_jst()
                self.assertTrue(s.endswith("+09:00"), s)
                dt = datetime.fromisoformat(s)
                self.assertLess(abs((dt - datetime.now(timezone.utc)).total_seconds()), 5)
        finally:
            if old is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old
            if hasattr(time, "tzset"):
                time.tzset()

    def test_parse_observed(self):
        self.assertEqual(server.parse_observed("2026-11-20 10:45"), "2026-11-20T10:45:00+09:00")
        self.assertEqual(server.parse_observed("2026-11-20T01:45:00+00:00"), "2026-11-20T10:45:00+09:00")
        self.assertIsNone(server.parse_observed(""))
        self.assertIsNone(server.parse_observed(None))
        self.assertEqual(server.parse_observed("2028-02-29T10:00"), "2028-02-29T10:00:00+09:00")
        self.assertEqual(server.parse_observed("2026-11-20T01:45:00Z"), "2026-11-20T10:45:00+09:00")
        for bad in ("昨日", "2026-13-01", 123, "2026-02-30T10:00", "2026-02-29 10:00", "2026-11-20", "20261120T1000",
                    "2026-11-20T24:00", "2026-11-20T10:00+25:00", {"a": 1}, ["2026-10-01T10:00"]):
            with self.assertRaises((ValueError, TypeError)):
                server.parse_observed(bad)


# ---- 9. Gemini のリトライ ------------------------------------------------------
class FakeClock:
    def __init__(self):
        self.t = 1000.0
        self.sleeps = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


def http_error(code, msg="err", retry_after=None):
    hdrs = http.client.HTTPMessage()
    if retry_after is not None:
        hdrs["Retry-After"] = str(retry_after)
    body = json.dumps({"error": {"code": code, "message": msg}}).encode()
    return urllib.error.HTTPError("https://example.invalid", code, msg, hdrs, io.BytesIO(body))


def ok_response(raw=None, model_version="gemini-test"):
    data = {"candidates": [{"content": {"parts": [{"text": json.dumps(raw or good_raw(), ensure_ascii=False)}]}}],
            "modelVersion": model_version, "usageMetadata": {"totalTokenCount": 10}}
    return io.BytesIO(json.dumps(data).encode())


class GeminiRetryTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.patches = [mock.patch.dict(os.environ, {"GEMINI_API_KEY": DUMMY_KEY}),
                        mock.patch.object(server, "_clock", self.clock.now),
                        mock.patch.object(server, "_sleep", self.clock.sleep),
                        mock.patch.object(server, "MODELS", ["m1", "m2", "m3"]),
                        mock.patch("sys.stderr", io.StringIO())]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def run_with(self, responses, budget=None):
        calls = []

        def fake(req, timeout=None):
            calls.append((req.full_url, timeout))
            r = responses[min(len(calls), len(responses)) - 1]
            if callable(r):
                r = r()
            if isinstance(r, BaseException):
                raise r
            return r
        with mock.patch.object(server.urllib.request, "urlopen", side_effect=fake):
            try:
                return server.call_gemini("QUJD", "image/jpeg", "t", budget_s=budget), calls, None
            except server.ApiError as e:
                self.assertNotIn(DUMMY_KEY, e.message)
                return None, calls, e

    def test_401_and_403_fail_fast(self):
        for code in (401, 403):
            with self.subTest(code=code):
                res, calls, err = self.run_with([lambda: http_error(code)])
                self.assertEqual(len(calls), 1)
                self.assertEqual(err.code, "gemini_auth")
                self.assertIn(str(code), err.message)
                self.assertEqual(self.clock.sleeps, [])

    def test_400_invalid_key_is_auth_error(self):
        res, calls, err = self.run_with([lambda: http_error(400, "API key not valid. Please pass a valid API key.")])
        self.assertEqual((len(calls), err.code), (1, "gemini_auth"))

    def test_400_other_fails_fast(self):
        res, calls, err = self.run_with([lambda: http_error(400, "Unable to process input image")])
        self.assertEqual((len(calls), err.code), (1, "gemini_bad_request"))

    def test_404_moves_to_next_model_without_retry(self):
        res, calls, err = self.run_with([lambda: http_error(404), lambda: ok_response()])
        self.assertIsNone(err)
        self.assertEqual(len(calls), 2)
        self.assertIn("/m1:", calls[0][0])
        self.assertIn("/m2:", calls[1][0])
        self.assertEqual(res[1]["requested_model"], "m2")

    def test_429_backoff_then_success(self):
        res, calls, err = self.run_with([lambda: http_error(429, retry_after=3), lambda: ok_response()])
        self.assertIsNone(err)
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(self.clock.sleeps), 1)
        self.assertGreaterEqual(self.clock.sleeps[0], 3)

    def test_429_always_rate_limited_message(self):
        res, calls, err = self.run_with([lambda: http_error(429)])
        self.assertEqual(err.code, "gemini_rate_limited")
        self.assertEqual(err.status, 503)
        self.assertEqual(len(calls), 6)

    def test_503_always_bounded(self):
        res, calls, err = self.run_with([lambda: http_error(503)])
        self.assertEqual(err.code, "gemini_unavailable")
        self.assertEqual(len(calls), 6)  # 3 モデル × 2 回
        self.assertLessEqual(sum(self.clock.sleeps), server.GEMINI_BUDGET_S)

    def test_timeout_then_success(self):
        res, calls, err = self.run_with([lambda: socket.timeout("timed out"), lambda: ok_response()])
        self.assertIsNone(err)
        self.assertEqual(len(calls), 2)

    def test_urlerror_retried(self):
        res, calls, err = self.run_with([lambda: urllib.error.URLError("down"), lambda: ok_response()])
        self.assertIsNone(err)

    def test_no_candidates_and_invalid_json_go_to_next_model(self):
        empty = lambda: io.BytesIO(json.dumps({"promptFeedback": {"blockReason": "SAFETY"}}).encode())
        bad = lambda: io.BytesIO(json.dumps({"candidates": [{"content": {"parts": [{"text": "{not json"}]}}]}).encode())
        res, calls, err = self.run_with([empty, bad, lambda: ok_response()])
        self.assertIsNone(err)
        self.assertEqual(len(calls), 3)
        res, calls, err = self.run_with([empty])
        self.assertEqual(err.code, "gemini_failed")
        self.assertEqual(len(calls), 3)

    def test_overall_budget(self):
        def slow():
            self.clock.t += 50
            return http_error(503)
        res, calls, err = self.run_with([slow], budget=120)
        self.assertEqual(err.code, "gemini_timeout")
        self.assertLessEqual(len(calls), 3)
        for _, t in calls:
            self.assertLessEqual(t, server.GEMINI_REQ_TIMEOUT_S)

    def test_key_echoed_by_upstream_is_never_returned_or_logged(self):
        """R6: 外部 APIエラー本文が現在のキーを含んでも、クライアントへのメッセージとログに出さない。"""
        echo = f"API key not valid: {DUMMY_KEY} (key={DUMMY_KEY}) AIzaSyFAKEFAKEFAKEFAKEFAKE"
        scenarios = [[lambda: http_error(401, echo)], [lambda: http_error(403, echo)], [lambda: http_error(400, echo)],
                     [lambda: http_error(400, "bad image " + DUMMY_KEY)], [lambda: http_error(429, echo)],
                     [lambda: http_error(503, echo)], [lambda: http_error(500, echo)], [lambda: http_error(404, echo)],
                     [lambda: http_error(418, echo)]]
        for responses in scenarios:
            log = io.StringIO()
            with mock.patch("sys.stderr", log):
                res, calls, err = self.run_with(responses)
            self.assertIsNotNone(err)
            self.assertNotIn(DUMMY_KEY, err.message)
            self.assertNotIn("AIzaSyFAKE", err.message)
            self.assertNotIn("API key not valid", err.message)  # 外部 APIの本文自体を転送しない
            self.assertNotIn(DUMMY_KEY, log.getvalue())
            self.assertNotIn("AIzaSyFAKE", log.getvalue())

    def test_key_not_in_success_meta_after_fallback(self):
        res, calls, err = self.run_with([lambda: http_error(429, "quota for " + DUMMY_KEY), lambda: ok_response()])
        self.assertIsNone(err)
        self.assertNotIn(DUMMY_KEY, json.dumps(res[1]))
        self.assertNotIn("quota for", json.dumps(res[1]))

    def test_redact(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": DUMMY_KEY}):
            out = server.redact(f"x {DUMMY_KEY} y key=abc&z=1 AIzaSyABCDEFGHIJKLMNOP")
        self.assertNotIn(DUMMY_KEY, out)
        self.assertNotIn("abc", out)
        self.assertNotIn("AIzaSyABCDEFGHIJKLMNOP", out)

    def test_missing_key(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            with self.assertRaises(server.ApiError) as cm:
                server.call_gemini("QUJD", "image/jpeg", "t")
        self.assertEqual(cm.exception.code, "gemini_key_missing")

    def test_client_timeout_covers_server_budget(self):
        self.assertGreater(server.CLIENT_TIMEOUT_S, server.GEMINI_BUDGET_S + server.GEOCODE_BUDGET_S)


# ---- Nominatim：レート制限とキャッシュ ----------------------------------------
class GeocodeTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        server._geo_cache.clear()
        server._geo_state["last"] = None
        self.patches = [mock.patch.object(server, "_clock", self.clock.now),
                        mock.patch.object(server, "_sleep", self.clock.sleep),
                        mock.patch("sys.stderr", io.StringIO())]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        server._geo_cache.clear()
        server._geo_state["last"] = None

    def test_cache_and_rate_limit(self):
        calls = []

        def fake(req, timeout=None):
            calls.append((req.full_url, self.clock.t))
            return io.BytesIO(json.dumps([{"lat": "35.62", "lon": "139.24"}]).encode())
        with mock.patch.object(server.urllib.request, "urlopen", side_effect=fake):
            a = server.geocode("高尾山", "八王子市", "東京都")
            b = server.geocode("高尾山", "八王子市", "東京都")
            c = server.geocode("東福寺", "京都市", "京都府")
        self.assertEqual(a, b)
        self.assertEqual(len(calls), 2)  # 2 回目はキャッシュ
        self.assertGreaterEqual(calls[1][1] - calls[0][1], 1.0)  # 1 秒以上空ける
        self.assertTrue(c)

    def test_empty_result_falls_back_and_outside_japan_rejected(self):
        responses = [[], [{"lat": "48.85", "lon": "2.35"}], [{"lat": "35.0", "lon": "135.7"}]]
        with mock.patch.object(server.urllib.request, "urlopen",
                               side_effect=[io.BytesIO(json.dumps(r).encode()) for r in responses]):
            g = server.geocode("A", "B", "C")
        self.assertEqual((g["lat"], g["lng"]), (35.0, 135.7))
        self.assertTrue(all(t >= 1.0 for t in self.clock.sleeps))

    def test_errors_not_cached(self):
        n = []

        def boom(req, timeout=None):
            n.append(1)
            raise urllib.error.URLError("down")
        with mock.patch.object(server.urllib.request, "urlopen", side_effect=boom):
            server.geocode("A", "", "")
            server.geocode("A", "", "")
        self.assertEqual(len(n), 2)

    def test_lock_wait_is_bounded_by_deadline(self):
        """R3: 別スレッドがロックを予算より長く持っていても、geocode は残り時間で諦めて返る。"""
        real_clock = server.time.monotonic
        urlopen = mock.MagicMock(side_effect=AssertionError("must not call network"))
        result = {}

        def worker():
            t0 = real_clock()
            result["value"] = server.geocode("高尾山", "八王子市", "東京都", budget_s=0.2)
            result["elapsed"] = real_clock() - t0
        with mock.patch.object(server, "_clock", real_clock), mock.patch.object(server, "_sleep", time.sleep), \
                mock.patch.object(server.urllib.request, "urlopen", urlopen):
            self.assertTrue(server._geo_lock.acquire())
            try:
                th = threading.Thread(target=worker, daemon=True)
                th.start()
                th.join(timeout=2.0)
                still_blocked = th.is_alive()
            finally:
                server._geo_lock.release()  # 予算（0.2 秒）よりずっと長く保持した後に解放
            th.join(timeout=2.0)
        self.assertFalse(still_blocked, "geocode がロック解放まで待ち続けた")
        self.assertIsNone(result["value"])
        self.assertLess(result["elapsed"], 1.0)
        urlopen.assert_not_called()

    def test_expired_deadline_does_not_wait_for_lock(self):
        real_clock = server.time.monotonic
        with mock.patch.object(server, "_clock", real_clock):
            self.assertTrue(server._geo_lock.acquire())
            try:
                t0 = real_clock()
                self.assertIsNone(server._nominatim("q", real_clock() - 1))
                self.assertLess(real_clock() - t0, 0.1)
            finally:
                server._geo_lock.release()

    def test_thread_safety_spacing(self):
        stamps = []
        real_clock = server.time.monotonic

        def fake(req, timeout=None):
            stamps.append(real_clock())
            return io.BytesIO(b"[]")
        with mock.patch.object(server, "_clock", real_clock), mock.patch.object(server, "_sleep", time.sleep), \
                mock.patch.object(server, "GEO_MIN_INTERVAL_S", 0.05), \
                mock.patch.object(server.urllib.request, "urlopen", side_effect=fake):
            ths = [threading.Thread(target=server._nominatim, args=(f"q{i}", real_clock() + 30)) for i in range(5)]
            [t.start() for t in ths]
            [t.join() for t in ths]
        stamps.sort()
        self.assertEqual(len(stamps), 5)
        self.assertTrue(all(b - a >= 0.045 for a, b in zip(stamps, stamps[1:])), stamps)


if __name__ == "__main__":
    unittest.main()


# ---- 6. 実 Gemini 連携で見つかった問題の回帰（時刻・区域・重複・EXIF） ------------------
def jpeg_with_exif(dt=b"2025:11:20 10:30:00", offset=None, le=True):
    """DateTimeOriginal（と任意で OffsetTimeOriginal）だけを持つ最小の EXIF 付き JPEG。"""
    import struct
    bo = "<" if le else ">"
    entries = [(0x9003, 2, 20, dt + b"\x00")]
    if offset:
        entries.append((0x9011, 2, 7, offset + b"\x00"))
    exif_ifd_off = 8 + 2 + 12 + 4
    data_off = exif_ifd_off + 2 + 12 * len(entries) + 4
    ifd0 = struct.pack(bo + "H", 1) + struct.pack(bo + "HHII", 0x8769, 4, 1, exif_ifd_off) + struct.pack(bo + "I", 0)
    ex, blob = struct.pack(bo + "H", len(entries)), b""
    for tag, typ, cnt, val in entries:
        ex += struct.pack(bo + "HHII", tag, typ, cnt, data_off + len(blob))
        blob += val
    ex += struct.pack(bo + "I", 0)
    tiff = (b"II*\x00" if le else b"MM\x00*") + struct.pack(bo + "I", 8) + ifd0 + ex + blob
    app1 = b"Exif\x00\x00" + tiff
    return b"\xff\xd8" + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + b"\xff\xd9"


class RealRunRegressionTests(unittest.TestCase):
    meta = {"model": "m", "latency_s": 0.1}

    @classmethod
    def setUpClass(cls):
        cls.root = make_root()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def run_analyze(self, payload, raw, geo=None):
        with mock.patch.object(server, "call_gemini", return_value=(raw, self.meta)), \
                mock.patch.object(server, "geocode", return_value=geo):
            return server.analyze(payload, self.root)

    def test_schema_requires_area_and_time_reference(self):
        for k in ("area_detail", "time_reference", "time_note"):
            self.assertIn(k, server.SCHEMA["required"])
        self.assertEqual(server.SCHEMA["properties"]["time_reference"]["enum"], server.TIME_REFS)

    def test_time_reference_is_kept_or_defaults_to_unknown(self):
        out, issues, _ = server.validate_result(good_raw(time_reference="過去の写真・訪問", area_detail="東側の斜面"))
        self.assertEqual((out["time_reference"], out["area_detail"], issues), ("過去の写真・訪問", "東側の斜面", []))
        out, issues, warns = server.validate_result(good_raw(time_reference="今"))
        self.assertEqual(out["time_reference"], "不明")
        self.assertEqual(issues, [])
        self.assertTrue(any("time_reference" in w for w in warns))

    def test_zero_zero_means_no_estimate(self):
        # 実 Gemini は場所を読めない投稿で lat/lng=0,0 を返した。範囲外ではなく「推定なし」として扱う
        out, issues, warns = server.validate_result(good_raw(lat=0, lng=0, place_name=""))
        self.assertIsNone(out["lat"])
        self.assertTrue(any("推定できません" in w for w in warns))
        self.assertFalse(any("範囲外" in w for w in warns))

    def test_future_upload_date_rejected_before_gemini(self):
        b64 = base64.b64encode(JPEG).decode()
        now = datetime(2026, 10, 22, 17, 0, tzinfo=server.JST)
        with mock.patch.object(server, "now_jst", return_value=now), \
                mock.patch.object(server, "call_gemini", side_effect=AssertionError("must not call Gemini")):
            with self.assertRaises(server.ApiError) as cm:
                server.parse_payload({"image_b64": b64, "observed_at": "2026-12-25T10:00"}, self.root)
            self.assertEqual((cm.exception.status, cm.exception.code), (400, "future_observed_at"))
            # 端末の時計のずれ程度（10 分以内）は許す
            self.assertEqual(server.parse_payload({"image_b64": b64, "observed_at": "2026-10-22T17:05"}, self.root)[4],
                             "2026-10-22T17:05:00+09:00")

    def test_sample_future_date_is_kept_for_frontend_to_flag(self):
        now = datetime(2026, 10, 22, 17, 0, tzinfo=server.JST)
        with mock.patch.object(server, "now_jst", return_value=now):
            out = self.run_analyze({"sample": "s7"}, good_raw())
        self.assertEqual(out["input"]["observed_at"], "2026-11-20T10:45:00+09:00")
        self.assertTrue(out["analyzed_at"].startswith("2026-10-22T17:00"))

    def test_exif_capture_time(self):
        self.assertEqual(server.exif_taken_at(jpeg_with_exif()), {"at": "2025-11-20T10:30:00+09:00", "tz_assumed": True})
        self.assertEqual(server.exif_taken_at(jpeg_with_exif(offset=b"+00:00", le=False)),
                         {"at": "2025-11-20T19:30:00+09:00", "tz_assumed": False})
        for bad in (JPEG, b"", b"GIF89a", jpeg_with_exif(dt=b"2025:13:40 99:99:99"), jpeg_with_exif()[:30], b"\xff\xd8\xff\xe1\x00\x01"):
            with self.subTest(bad=bad[:12]):
                self.assertIsNone(server.exif_taken_at(bad))

    def test_upload_reports_photo_time_and_fingerprint(self):
        img = jpeg_with_exif()
        b64 = base64.b64encode(img).decode()
        out = self.run_analyze({"image_b64": b64, "text": "東福寺", "observed_at": "2026-10-22T15:00"}, good_raw())
        self.assertEqual(out["input"]["photo_taken_at"], "2025-11-20T10:30:00+09:00")
        self.assertIn("未検証", out["input"]["photo_time_source"])
        again = self.run_analyze({"image_b64": b64, "text": "東福寺", "observed_at": "2026-10-22T15:30"}, good_raw())
        other = self.run_analyze({"image_b64": b64, "text": "東福寺 通天橋", "observed_at": "2026-10-22T15:00"}, good_raw())
        self.assertEqual(out["input"]["fingerprint"], again["input"]["fingerprint"])
        self.assertNotEqual(out["input"]["fingerprint"], other["input"]["fingerprint"])
        self.assertRegex(out["input"]["fingerprint"], r"^[0-9a-f]{16}$")
        plain = self.run_analyze({"image_b64": base64.b64encode(JPEG).decode()}, good_raw())
        self.assertIsNone(plain["input"]["photo_taken_at"])


# ---- 7. デモ用データと異常系データの区分（2026-10-22 の方針） ---------------------------------
class DemoAndEdgeDataTests(unittest.TestCase):
    REQUIRED_EDGE_KINDS = {"future_date", "old_photo", "missing_date", "area_confusion", "park_centre",
                           "contradiction", "no_place", "duplicate"}

    @classmethod
    def setUpClass(cls):
        cls.demo = server.load_samples(server.ROOT)
        with open(os.path.join(server.ROOT, "samples", "edge", "cases.json"), encoding="utf-8") as f:
            cls.edge = json.load(f)["cases"]

    def test_every_demo_sample_is_labelled_synthetic_and_not_future_dated(self):
        now = server.now_jst()
        for s in self.demo:
            with self.subTest(s=s["id"]):
                self.assertIs(s.get("synthetic"), True)
                self.assertEqual(s.get("label"), "合成デモデータ")
                self.assertTrue(s["handle"].startswith("@sample_"))
                self.assertFalse(server.is_future(server.parse_observed(s["posted"]), now))
                self.assertTrue(os.path.isfile(os.path.join(server.ROOT, s["image"])))
                self.assertIsNotNone(server.resolve_static("/" + s["image"]))

    def test_demo_has_the_three_scenarios(self):
        self.assertEqual(sorted(s["scenario"] for s in self.demo if s.get("scenario")), ["a", "b", "c"])

    def test_edge_cases_keep_every_anomaly_kind_and_stay_out_of_the_demo(self):
        kinds = {c["kind"] for c in self.edge}
        self.assertTrue(self.REQUIRED_EDGE_KINDS <= kinds, self.REQUIRED_EDGE_KINDS - kinds)
        demo_ids = {s["id"] for s in self.demo}
        for c in self.edge:
            with self.subTest(c=c["id"]):
                self.assertNotIn(c["id"], demo_ids)
                self.assertTrue(os.path.isfile(os.path.join(server.ROOT, c["image"])))
                self.assertTrue(c["expect"])
        # 旧デモの未来日付サンプルは消さずに異常系として残す
        self.assertEqual({c["id"]: c["observed_at"] for c in self.edge if c["id"] in ("s5_future", "s7_future")},
                         {"s5_future": "2026-11-22T10:20", "s7_future": "2026-11-20T10:45"})

    def test_edge_material_and_sample_readme_are_not_served(self):
        for p in ("/samples/edge/cases.json", "/samples/edge/s7_momiji_takao_peak.jpg", "/samples/README.md",
                  "/samples/edge%2Fs7_momiji_takao_peak.jpg"):
            with self.subTest(p=p):
                self.assertIsNone(server.resolve_static(p))

    def test_sample_results_are_marked_synthetic(self):
        root = make_root()
        try:
            with mock.patch.object(server, "call_gemini", return_value=(good_raw(), {"model": "m"})), \
                    mock.patch.object(server, "geocode", return_value=None):
                self.assertIs(server.analyze({"sample": "s3"}, root)["input"]["synthetic"], True)
                up = server.analyze({"image_b64": base64.b64encode(JPEG).decode()}, root)
            self.assertIs(up["input"]["synthetic"], False)
        finally:
            shutil.rmtree(root, ignore_errors=True)
