"""W6 RED→GREEN: Flask isolated + preserve extended collections (QA plan Task 9.1).

Chạy: DATA_FILE=<tmp> PORT=<port> python3 -m unittest discover -s . -p 'test_*.py' -v
Yêu cầu Flask + flask-cors trong environment (venv QA).
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PORTAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PORTAL_DIR))


class FlaskIsolationTest(unittest.TestCase):
    def test_default_data_file_is_isolated_from_node(self):
        # Đọc default từ source (không bị nhiễm DATA_FILE của run hiện tại).
        import re

        source = (PORTAL_DIR / "app.py").read_text(encoding="utf-8")
        self.assertIn('_DEFAULT_DATA_FILE = (BASE_DIR / "data" / "db.json")', source)
        self.assertIn("NODE_DATA_FILE", source)
        self.assertIn("shared concurrent JSON là unsupported", source)

    def test_pointing_at_node_db_fails_fast_without_writing(self):
        node_db = str((PORTAL_DIR.parent / "data" / "db.json").resolve())
        before = Path(node_db).read_bytes() if Path(node_db).exists() else None
        proc = subprocess.run(
            [sys.executable, "-c", "import app"],
            cwd=str(PORTAL_DIR),
            env={**os.environ, "DATA_FILE": node_db},
            capture_output=True, text=True, timeout=30,
        )
        self.assertNotEqual(proc.returncode, 0, "phải fail-fast khi trỏ vào Node data")
        self.assertIn("unsupported", (proc.stdout + proc.stderr).lower())
        if before is not None:
            self.assertEqual(Path(node_db).read_bytes(), before, "không được ghi Node DB")

    def test_load_save_preserves_extended_collections(self):
        import app as flask_app

        with tempfile.TemporaryDirectory() as tmp:
            data_file = Path(tmp) / "db.json"
            fixture = {
                "assets": [{"id": 1, "tag": "T1", "brand": "B", "model": "M", "serial": "S1"}],
                "tickets": [],
                "licenses": [],
                "problems": [{"id": 9}],
                "changes": [{"id": 8}],
                "auditEvents": [{"id": 7}],
                "monitoringChecks": [{"id": 6}],
                "customCollection": [{"id": 5}],
            }
            data_file.write_text(json.dumps(fixture), encoding="utf-8")
            old = flask_app.DATA_FILE
            flask_app.DATA_FILE = data_file
            try:
                db = flask_app.load_db()
                flask_app.save_db(db)
                after = json.loads(data_file.read_text(encoding="utf-8"))
            finally:
                flask_app.DATA_FILE = old
            for key in ("problems", "changes", "auditEvents", "monitoringChecks", "customCollection"):
                self.assertEqual(after.get(key), fixture[key], f"giữ collection {key}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
