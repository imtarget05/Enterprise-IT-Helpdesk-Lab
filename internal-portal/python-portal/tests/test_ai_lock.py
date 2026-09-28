"""W6 fix round 4 — AI route KHÔNG được giữ global DB lock khi gọi provider.

Provider (OpenAI/Ollama/RAG) có thể chạy vài giây; nếu giữ lock suốt lúc đó thì
mọi request khác (kể cả `GET /api/health`) bị chặn. Test dùng Event để chặn
provider một cách deterministic — không gọi network thật.
"""
import ast
import inspect
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from tests.harness import TempDbCase, fixture_db, load_app, read_db, write_db

# Route được phép gọi provider bên ngoài (ngoài RLock DB).
EXTERNAL_ROUTES = {"ai_analyze", "ai_stat"}
# Route nào chắc chắn phải đọc/ghi DB (phải nằm trong critical section).
DB_ROUTES = {
    "health", "stats", "list_assets", "create_asset", "list_tickets",
    "create_ticket", "update_ticket", "ai_analyze", "export_assets",
}


def _lock_spans(fn_node):
    """Các khối `with _DB_LOCK:` (lineno, end_lineno) trong function node."""
    spans = []
    for node in ast.walk(fn_node):
        if isinstance(node, ast.With):
            if any("_DB_LOCK" in ast.dump(item.context_expr) for item in node.items):
                spans.append((node.lineno, node.end_lineno))
    return spans


def _call_lines(fn_node, func_name):
    return [n.lineno for n in ast.walk(fn_node)
            if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id == func_name]


class AiLockTest(TempDbCase, unittest.TestCase):
    def setUp(self):
        try:
            import pytest
            pytest.importorskip("flask", reason="flask not installed; runs in CI with requirements")
        except ImportError:
            pass  # pytest absent (unittest-only venv): nothing to skip-guard
        super().setUp()
        write_db(self.data_file, fixture_db())
        self.mod = load_app(self.data_file, port=5003, case=self)
        self._real_analyze = self.mod.analyze_ticket
        self.addCleanup(setattr, self.mod, "analyze_ticket", self._real_analyze)

    def test_health_responds_while_ai_provider_is_blocked(self):
        started = threading.Event()
        release = threading.Event()
        calls = []

        def blocking_analyze(ticket):
            calls.append(dict(ticket) if isinstance(ticket, dict) else ticket)
            started.set()
            if not release.wait(timeout=30):
                raise AssertionError("provider không được release trong 30s")
            return {"engine": "test", "mode": "fallback", "summary": "OK"}

        self.mod.analyze_ticket = blocking_analyze
        result = {}

        def ai_request():
            client = self.mod.app.test_client()
            res = client.post("/api/ai/analyze", json={
                "ticketId": next(t["id"] for t in self.mod.DB["tickets"]
                                 if isinstance(t, dict) and "id" in t)})
            result["status"] = res.status_code
            result["body"] = res.get_json(silent=True)
            result["raw"] = res.get_data(as_text=True)

        with ThreadPoolExecutor(max_workers=2) as pool:
            ai_future = pool.submit(ai_request)
            self.assertTrue(started.wait(timeout=30),
                            "provider chưa vào trạng thái blocked")
            # Trong lúc provider bị chặn: mọi request khác phải trả lời được.
            health_status = self.mod.app.test_client().get("/api/health").status_code
            list_status = self.mod.app.test_client().get("/api/assets").status_code
            write_status = self.mod.app.test_client().post("/api/assets", json={
                "tag": "LP-AI-WRITE", "brand": "B", "model": "M",
                "serial": "S"}).status_code
            self.assertEqual(health_status, 200,
                             "GET /api/health bị chặn bởi AI request (giữ global lock)")
            self.assertEqual(list_status, 200, "GET /api/assets bị chặn")
            self.assertEqual(write_status, 201, "POST /api/assets bị chặn")
            release.set()
            ai_future.result(timeout=30)

        self.assertEqual(result["status"], 200, result["raw"][:200])
        self.assertEqual(calls and calls[0].get("id"), calls[0].get("id"))
        self.assertEqual(result["body"]["engine"], "test")
        self.assertEqual(result["body"]["summary"], "OK")
        self.assertNotIn("Traceback", result["raw"])

    def test_ai_receives_snapshot_copy_not_live_db_object(self):
        seen = {}

        def capture(ticket):
            seen["ticket"] = ticket
            return {"engine": "test"}

        self.mod.analyze_ticket = capture
        tid = next(t["id"] for t in self.mod.DB["tickets"]
                   if isinstance(t, dict) and "id" in t)
        before = [t for t in self.mod.DB["tickets"]
                  if isinstance(t, dict) and t.get("id") == tid][0]
        res = self.mod.app.test_client().post("/api/ai/analyze", json={"ticketId": tid})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True)[:200])
        self.assertEqual(res.get_json()["ticketId"], tid)
        self.assertIsNot(seen["ticket"], before,
                         "phải truyền BẢN SAO, không phải object sống trong DB")
        # Sửa object đã truyền đi không được đổi DB
        seen["ticket"]["status"] = "HACKED"
        after = [t for t in self.mod.DB["tickets"]
                 if isinstance(t, dict) and t.get("id") == tid][0]
        self.assertNotEqual(after.get("status"), "HACKED", "DB bị mutate ngoài ý muốn")

    def test_ai_analysis_does_not_write_to_disk(self):
        self.mod.analyze_ticket = lambda ticket: {"engine": "test"}
        before = read_db(self.data_file)
        res = self.mod.app.test_client().post("/api/ai/analyze", json={
            "title": "Printer offline", "requester": "QA", "priority": "High"})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True)[:200])
        self.assertEqual(read_db(self.data_file), before,
                         "AI không được ghi vào data file")

    def test_ai_by_title_still_works_without_db_read(self):
        self.mod.analyze_ticket = lambda ticket: {"engine": "test", "seen": ticket["title"]}
        res = self.mod.app.test_client().post("/api/ai/analyze", json={
            "title": "Máy in offline", "requester": "QA"})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True)[:200])
        self.assertEqual(res.get_json()["seen"], "Máy in offline")
        self.assertIsNone(res.get_json()["ticketId"])


# --- Hook detector -------------------------------------------------------
# Fixture: synthetic module dùng ĐÚNG 3 kiểu hook mà Flask cho phép.
HOOK_FIXTURE_SOURCE = """
import threading
from flask import Flask

app = Flask(__name__)
_DB_LOCK = threading.RLock()


@app.before_request
def _hold_lock():
    _DB_LOCK.acquire()


def _release(response):
    _DB_LOCK.release()
    return response


app.after_request(_release)


@app.teardown_request
def _release_on_teardown(exc):
    _DB_LOCK.release()
"""

CLEAN_FIXTURE_SOURCE = """
import threading
from flask import Flask

app = Flask(__name__)
_DB_LOCK = threading.RLock()


@app.route("/api/health")
def health():
    with _DB_LOCK:
        return {"ok": True}


@app.errorhandler(500)
def _boom(exc):
    return {"error": "boom"}, 500
"""


# Mọi API hook cấp request của Flask (`Flask` và `Blueprint`), kể cả bản
# cũ `before_first_request` và `teardown_appcontext` (chạy theo app context).
REQUEST_HOOK_NAMES = frozenset({
    "before_request", "after_request", "teardown_request",
    "before_first_request", "teardown_appcontext",
})


def _request_hooks(tree):
    """Danh sách `(tên hook, dòng)` đăng ký ở cấp request trong `tree`.

    Bắt CẢ HAI dạng đăng ký:
      - decorator:  `@app.before_request` / `@bp.after_request` (ast.Attribute)
      - gọi trực tiếp: `app.teardown_request(fn)` (ast.Call với func Attribute)
    và quét TOÀN BỘ cây (không chỉ top-level) nên hook lồng trong factory/blueprint
    vẫn bị thấy. Fail-closed: bất kỳ attribute nào tên trùng hook đều bị flag,
    không đoán receiver có phải Flask hay không.
    """
    found = set()
    for node in ast.walk(tree):
        attr = None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attr = node.func
        elif isinstance(node, ast.Attribute):
            attr = node
        if attr is not None and attr.attr in REQUEST_HOOK_NAMES:
            found.add((attr.attr, attr.lineno))
    return sorted(found)


class RouteLockAuditTest(unittest.TestCase):
    """Audit tĩnh: route nào giữ global lock, route nào gọi provider ngoài lock."""

    @classmethod
    def setUpClass(cls):
        cls.mod = None
        import importlib
        import os
        import sys
        from tests.harness import PORTAL_DIR

        tmp = os.environ.get("DATA_FILE")
        cls.source_path = PORTAL_DIR / "app.py"
        cls.source = cls.source_path.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)

    def _route_functions(self):
        out = {}
        for node in self.tree.body:
            if not isinstance(node, ast.FunctionDef):
                continue
            for dec in node.decorator_list:
                if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) \
                        and isinstance(dec.func.value, ast.Name) \
                        and dec.func.value.id == "app":
                    out[node.name] = node
        return out

    def test_analyze_ticket_call_is_outside_db_lock(self):
        routes = self._route_functions()
        self.assertIn("ai_analyze", routes)
        fn = routes["ai_analyze"]
        spans = _lock_spans(fn)
        self.assertTrue(spans, "ai_analyze vẫn phải copy ticket dưới lock")
        call_lines = _call_lines(fn, "analyze_ticket")
        self.assertTrue(call_lines, "route phải gọi analyze_ticket")
        for line in call_lines:
            for start, end in spans:
                self.assertFalse(start <= line <= end,
                                 f"analyze_ticket() tại dòng {line} nằm TRONG khối "
                                 f"lock {start}-{end} (chặn mọi request khác)")

    def test_db_touching_routes_hold_the_lock(self):
        for name in DB_ROUTES:
            routes = self._route_functions()
            self.assertIn(name, routes, f"không tìm thấy route {name}")
            self.assertTrue(_lock_spans(routes[name]),
                            f"route {name} đọc/ghi DB mà không dùng _DB_LOCK")

    def test_detector_flags_all_three_flask_hooks(self):
        """RED mutation: detector phải bắt được cả 3 hook (kể cả dạng
        `app.after_request(fn)` gọi trực tiếp, không phải decorator)."""
        found = _request_hooks(ast.parse(HOOK_FIXTURE_SOURCE))
        self.assertEqual(
            sorted({name for name, _line in found}),
            ["after_request", "before_request", "teardown_request"],
            f"detector bỏ sót hook: {found}")

    def test_detector_ignores_clean_module(self):
        self.assertEqual(_request_hooks(ast.parse(CLEAN_FIXTURE_SOURCE)), [],
                         "detector báo nhầm route/errorhandler là hook")

    def test_no_request_scoped_global_lock_hook(self):
        """Không được có before/after/teardown request hook giữ lock toàn thời
        gian request — sẽ kéo cả provider call vào critical section."""
        hooks = _request_hooks(self.tree)
        self.assertEqual(hooks, [],
                         f"còn hook giữ lock ở cấp request: {hooks}")

    def test_external_routes_are_explicitly_documented(self):
        routes = self._route_functions()
        doc = ast.get_docstring(routes["ai_analyze"]) or ""
        self.assertIn("EXTERNAL", doc,
                      "route AI phải ghi rõ là external I/O (không giữ lock)")
        self.assertIn("_DB_LOCK", doc, "docstring phải nói rõ copy dưới lock rồi thả")


if __name__ == "__main__":
    unittest.main(verbosity=2)
