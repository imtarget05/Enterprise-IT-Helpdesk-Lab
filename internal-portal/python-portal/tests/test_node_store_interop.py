"""W6 Task 9.3 — Python write -> Node store load: không migration backup, không mất collection.

Chỉ dùng TEMP data dir (Node createStore({dataDir})) — không chạm
internal-portal/data/db.json thật.
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

INTERNAL_PORTAL = PORTAL_DIR.parent
NODE_LOAD_SCRIPT = r"""
const path = require('node:path');
const { createStore, COLLECTIONS, SCHEMA_VERSION } = require(path.join(process.argv[1], 'src', 'store.js'));
(async () => {
  const store = createStore({ dataDir: process.argv[2] });
  await store.load();
  await store.flush();
  const fs = require('node:fs');
  const files = fs.readdirSync(process.argv[2]);
  process.stdout.write(JSON.stringify({
    collections: COLLECTIONS,
    schemaVersion: SCHEMA_VERSION,
    summary: store.summary(),
    ids: Object.fromEntries(COLLECTIONS.map((k) => [k, (store.data[k] || []).map((r) => r.id)])),
    migrationBackup: store.migrationBackup || null,
    files,
  }));
})().catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });
"""


class NodeStoreInteropTest(TempDbCase, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.node_before = NODE_DB.read_bytes() if NODE_DB.exists() else None

    def _run_node_load(self, data_dir):
        proc = subprocess.run(
            ["node", "-e", NODE_LOAD_SCRIPT, str(INTERNAL_PORTAL), str(data_dir)],
            cwd=str(INTERNAL_PORTAL), capture_output=True, text=True, timeout=120,
            env={k: v for k, v in os.environ.items() if k != "DATA_FILE"},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_python_write_does_not_trigger_node_migration_backup(self):
        write_db(self.data_file, fixture_db())
        mod = load_app(self.data_file, port=5096, case=self)
        mod.app.test_client().post("/api/tickets", json={
            "title": "Interop check", "requester": "QA W6", "priority": "Low",
        })
        after_python = read_db(self.data_file)
        self.assertEqual(after_python["schemaVersion"], SCHEMA_VERSION,
                         "python save_db phải giữ schemaVersion để Node không coi là migration")

        result = self._run_node_load(self.data_file.parent)
        self.assertIsNone(result["migrationBackup"],
                          f"Node tạo migration backup sau khi Python ghi: {result['migrationBackup']}")
        self.assertNotIn("migrationBackup", " ".join(result["files"]))
        baks = [f for f in result["files"] if ".bak" in f or "migration" in f]
        self.assertEqual(baks, [], f"không được sinh file backup: {baks}")
        self.assertEqual(result["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(sorted(result["collections"]), sorted(DEFAULT_NODE_COLLECTIONS))

        after_node = read_db(self.data_file)
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertEqual([r.get("id") for r in after_node[key]],
                             result["ids"][key], f"Node load/persist làm đổi collection {key}")
        self.assertIn("Interop check", [t.get("title") for t in after_node["tickets"]])

    def test_node_bootstrap_on_fresh_python_file_keeps_every_collection(self):
        """File Flask tạo lần đầu phải đủ schemaVersion 2 + 11 collection, và
        Node không được sinh migration backup (tighten theo IMP-2)."""
        fresh_dir = self.tmpdir / "fresh"
        fresh = fresh_dir / "db.json"
        write_db(self.data_file, fixture_db())
        mod = load_app(self.data_file, port=5095, case=self)
        mod.DATA_FILE = fresh
        try:
            mod.save_db(mod.load_db())
        finally:
            mod.DATA_FILE = self.data_file

        self.assertTrue(fresh.exists())
        created = read_db(fresh)
        self.assertEqual(created["schemaVersion"], SCHEMA_VERSION,
                         "file Flask tạo mới phải có schemaVersion 2 ngay từ đầu")
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertIn(key, created, f"file mới thiếu collection {key}")
            self.assertIsInstance(created[key], list)

        result = self._run_node_load(fresh_dir)
        self.assertIsNone(result["migrationBackup"],
                          f"file do Flask tạo không được khiến Node tạo .bak: "
                          f"{result['migrationBackup']}")
        self.assertEqual([f for f in result["files"] if ".bak" in f or "migration" in f], [])
        self.assertEqual(sorted(result["collections"]), sorted(DEFAULT_NODE_COLLECTIONS))
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertIn(key, result["ids"], f"collection {key} không được Node nạp")
        self.assertGreaterEqual(len(result["ids"]["assets"]), 1)

        after_node = read_db(fresh)
        self.assertEqual(after_node["schemaVersion"], SCHEMA_VERSION)
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertIn(key, after_node)

    def test_legacy_file_without_schema_version_is_upgraded_by_flask(self):
        """File cũ (chỉ có `version: 1`) -> Flask nâng `schemaVersion` lên 2,
        nên Node load() KHÔNG coi là migration và không sinh `.bak`."""
        legacy = self.tmpdir / "legacy" / "db.json"
        write_db(legacy, {"version": 1, "assets": [], "tickets": [], "licenses": []})
        mod = load_app(legacy, port=5094, case=self)
        mod.save_db(mod.load_db())

        upgraded = read_db(legacy)
        self.assertEqual(upgraded["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(
            [p.name for p in legacy.parent.iterdir()
             if ".bak" in p.name or "migration" in p.name or ".corrupt-" in p.name],
            [], "Flask không được tự sinh file backup/migration")

        result = self._run_node_load(legacy.parent)
        self.assertIsNone(result["migrationBackup"],
                          f"file đã nâng schemaVersion nên Node không migration: "
                          f"{result['migrationBackup']}")
        self.assertEqual(sorted(result["collections"]), sorted(DEFAULT_NODE_COLLECTIONS))
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertIn(key, result["ids"])

    def tearDown(self):
        if self.node_before is not None:
            self.assertEqual(NODE_DB.read_bytes(), self.node_before,
                             "Node db.json thật bị thay đổi bởi test interop")


if __name__ == "__main__":
    unittest.main(verbosity=2)
