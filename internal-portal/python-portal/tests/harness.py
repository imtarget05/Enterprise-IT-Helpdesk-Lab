"""Shared harness cho W6 isolation tests.

Quy tắc bắt buộc:
  - DATA_FILE/PORT phải được set TRƯỚC khi import app (app.py đọc env ở
    module scope và fail-fast nếu trỏ vào Node data path).
  - Mọi test dùng tempdir riêng; không bao giờ chạm internal-portal/data/db.json
    (Node store thật) ngoài test guard fail-fast chỉ đọc.
"""
import copy
import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

PORTAL_DIR = Path(__file__).resolve().parent.parent
NODE_DB = (PORTAL_DIR.parent / "data" / "db.json").resolve()
DEFAULT_NODE_COLLECTIONS = [
    "assets", "tickets", "licenses", "ticketEvents", "problems", "changes",
    "accessRequests", "monitoringChecks", "monitoringHistory", "auditEvents",
    "notifications",
]
SCHEMA_VERSION = 2
CANONICAL = list(DEFAULT_NODE_COLLECTIONS)


def fixture_db(extra=None):
    """11 collection chuẩn của Node + schemaVersion 2 + key lạ."""
    db = {
        "version": 1,
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": "2026-09-23T13:46:38.852Z",
    }
    for i, key in enumerate(DEFAULT_NODE_COLLECTIONS, start=1):
        db[key] = [{"id": i, "marker": f"{key}-seed", "status": "Open"}]
    if extra:
        db.update(copy.deepcopy(extra))
    return db


def write_db(path, db):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(db, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def read_db(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_app(data_file=None, port=5099, seed=None, case=None):
    """Import lại app.py với env mới -> trả module đã cấu hình đúng DATA_FILE.

    data_file=None -> không set DATA_FILE (dùng default của app.py).
    case=<unittest.TestCase> -> restore DATA_FILE/PORT về giá trị cũ khi test xong
    (không để env trỏ vào tempdir đã bị xoá cho test chạy sau).
    """
    if str(PORTAL_DIR) not in sys.path:
        sys.path.insert(0, str(PORTAL_DIR))
    if case is not None:
        previous = {k: os.environ.get(k) for k in ("DATA_FILE", "PORT")}

        def _restore_env():
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        case.addCleanup(_restore_env)
    if data_file is not None:
        os.environ["DATA_FILE"] = str(data_file)
    else:
        os.environ.pop("DATA_FILE", None)
    os.environ["PORT"] = str(port)
    if seed is not None and data_file is not None:
        write_db(data_file, seed)
    sys.modules.pop("app", None)
    return importlib.import_module("app")


class TempDbCase:
    """Mixin: mỗi test có tempdir + module app import lại từ đầu."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="w6-flask-")
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = Path(self._tmp.name)
        self.data_file = self.tmpdir / "data" / "db.json"
