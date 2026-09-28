"""W6 Task 9.1/9.2 — RED→GREEN: Flask alternate isolated + data preservation.

Chạy (cwd python-portal):
  DATA_FILE=<tmp> PORT=<port> python3 -m unittest discover -s . -p 'test_*.py' -v
"""
try:
    import pytest
    pytest.importorskip("flask", reason="flask not installed; runs in CI with requirements")
except ImportError:
    pass  # pytest absent (unittest-only venv): nothing to skip-guard

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from tests.harness import (DEFAULT_NODE_COLLECTIONS, NODE_DB, PORTAL_DIR,
                           SCHEMA_VERSION, TempDbCase, fixture_db, load_app,
                           read_db, write_db)


class FlaskMutationPreservationTest(TempDbCase, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.db = fixture_db(extra={"customVendorCollection": [{"id": 77}],
                                    "settings": {"locale": "vi"}})
        write_db(self.data_file, self.db)
        self.app_mod = load_app(self.data_file, port=5099, case=self)
        self.client = self.app_mod.app.test_client()

    def test_create_asset_preserves_all_collections_and_schema_version(self):
        res = self.client.post("/api/assets", json={
            "tag": "LP-NEW-900", "brand": "HP", "model": "EliteBook",
            "serial": "SN-900", "dept": "IT Support",
        })
        self.assertEqual(res.status_code, 201, res.get_data(as_text=True))
        after = read_db(self.data_file)
        self.assertEqual(after["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(after["version"], 1)
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertIn(key, after, f"collection {key} bị mất sau POST /api/assets")
            if key != "assets":
                self.assertEqual(after[key], self.db[key], f"collection {key} bị đổi")
        self.assertEqual(after["customVendorCollection"], [{"id": 77}])
        self.assertEqual(after["settings"], {"locale": "vi"})
        self.assertEqual(len(after["assets"]), len(self.db["assets"]) + 1)

    def test_create_ticket_and_status_update_preserve_all_collections(self):
        res = self.client.post("/api/tickets", json={
            "title": "Printer offline", "requester": "Nguyen Thi Mai",
            "priority": "High", "category": "Network",
        })
        self.assertEqual(res.status_code, 201, res.get_data(as_text=True))
        tid = res.get_json()["id"]
        res = self.client.patch(f"/api/tickets/{tid}/status", json={"status": "In Progress"})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))

        after = read_db(self.data_file)
        self.assertEqual(after["schemaVersion"], SCHEMA_VERSION)
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertIn(key, after, f"collection {key} bị mất sau POST/PATCH ticket")
            if key != "tickets":
                self.assertEqual(after[key], self.db[key], f"collection {key} bị đổi")
        self.assertEqual(after["customVendorCollection"], [{"id": 77}])
        self.assertEqual(len(after["tickets"]), len(self.db["tickets"]) + 1)
        statuses = {t["id"]: t.get("status") for t in after["tickets"]}
        self.assertEqual(statuses.get(tid), "In Progress")

    def test_external_rows_added_after_startup_are_not_lost(self):
        """Process khác (Node/editor) ghi thêm row sau khi Flask đã load DB."""
        external = read_db(self.data_file)
        external["problems"].append({"id": 9001, "marker": "external-problem"})
        external["notifications"].append({"id": 9002, "marker": "external-notification"})
        external["assets"].append({"id": 9003, "tag": "EXT-001", "brand": "Dell",
                                   "model": "OptiPlex", "serial": "EXT-SN",
                                   "status": "Active"})
        external["customVendorCollection"].append({"id": 9004})
        write_db(self.data_file, external)

        res = self.client.post("/api/assets", json={
            "tag": "LP-FLASK-901", "brand": "Lenovo", "model": "T14",
            "serial": "SN-901",
        })
        self.assertEqual(res.status_code, 201, res.get_data(as_text=True))

        after = read_db(self.data_file)
        self.assertIn({"id": 9001, "marker": "external-problem"}, after["problems"])
        self.assertIn({"id": 9002, "marker": "external-notification"}, after["notifications"])
        self.assertIn(9004, [r.get("id") for r in after["customVendorCollection"]])
        self.assertIn(9003, [r.get("id") for r in after["assets"]],
                      "row do process ngoài ghi vào assets bị mất khi Flask write")
        self.assertIn("LP-FLASK-901", [a.get("tag") for a in after["assets"]])
        self.assertEqual(after["schemaVersion"], SCHEMA_VERSION)

    def test_save_db_is_atomic_and_leaves_no_temp_files(self):
        self.client.post("/api/tickets", json={"title": "Atomic", "requester": "QA"})
        leftovers = sorted(p.name for p in self.data_file.parent.iterdir()
                           if p.name.startswith("db.json.tmp-"))
        self.assertEqual(leftovers, [], f"còn temp file sau atomic write: {leftovers}")
        json.loads(self.data_file.read_text(encoding="utf-8"))  # parse được = không dở dang

    def test_load_save_roundtrip_preserves_unknown_collections(self):
        mod = self.app_mod
        db = mod.load_db()
        mod.save_db(db)
        after = read_db(self.data_file)
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertEqual(after.get(key), self.db[key], f"load+save mất {key}")
        self.assertEqual(after["customVendorCollection"], [{"id": 77}])
        self.assertEqual(after["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(after["version"], 1)


class FlaskIsolationConfigTest(TempDbCase, unittest.TestCase):
    def test_data_file_env_override_is_respected(self):
        write_db(self.data_file, fixture_db())
        mod = load_app(self.data_file, port=5311, case=self)
        self.assertEqual(Path(mod.DATA_FILE).resolve(), self.data_file.resolve())
        self.assertEqual(mod.PORT, 5311)

    def test_default_data_file_is_not_node_db(self):
        mod = load_app(None, port=5098, seed=None, case=self)
        default_path = Path(mod.DATA_FILE).resolve()
        self.assertNotEqual(default_path, NODE_DB, "default DATA_FILE không được trỏ vào Node data")
        self.assertEqual(default_path.parent.parent, PORTAL_DIR.resolve())
        self.assertFalse(str(default_path).startswith(str(NODE_DB.parent) + "/")
                         and default_path != NODE_DB)

    def test_pointing_at_node_db_fails_fast_without_writing(self):
        before = NODE_DB.read_bytes() if NODE_DB.exists() else None
        before_mtime = NODE_DB.stat().st_mtime_ns if NODE_DB.exists() else None
        env = {k: v for k, v in os.environ.items() if k != "DATA_FILE"}
        proc = subprocess.run(
            [sys.executable, "-c", "import app"],
            cwd=str(PORTAL_DIR), env={**env, "DATA_FILE": str(NODE_DB)},
            capture_output=True, text=True, timeout=60,
        )
        self.assertNotEqual(proc.returncode, 0, "phải fail-fast khi DATA_FILE trỏ vào Node db")
        output = (proc.stdout + proc.stderr).lower()
        self.assertIn("unsupported", output)
        self.assertIn("data/db.json", output.replace("\\", "/"))
        if before is not None:
            self.assertEqual(NODE_DB.read_bytes(), before, "không được ghi vào Node db")
            self.assertEqual(NODE_DB.stat().st_mtime_ns, before_mtime)
        self.assertEqual(
            sorted(p.name for p in NODE_DB.parent.iterdir() if p.name.endswith(".tmp-")),
            [], "không được để lại temp file cạnh Node db")

    def test_guard_error_path_does_not_require_existing_file(self):
        mod = load_app(self.data_file, port=5097, case=self)
        self.assertTrue(hasattr(mod, "NODE_DATA_FILE"))
        self.assertNotEqual(mod.DATA_FILE, mod.NODE_DATA_FILE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
