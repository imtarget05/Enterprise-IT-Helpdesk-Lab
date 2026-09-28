"""W6 Task 9.3 — HTTP smoke: boot Flask subprocess (random port, temp data),
mutate qua HTTP, restart process, dữ liệu còn nguyên + collection mở rộng giữ
đủ; không đụng internal-portal/data/db.json của Node.
"""
try:
    import pytest
    pytest.importorskip("flask", reason="flask not installed; runs in CI with requirements")
except ImportError:
    pass  # pytest absent (unittest-only venv): nothing to skip-guard

import json
import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

from tests.harness import (DEFAULT_NODE_COLLECTIONS, NODE_DB, PORTAL_DIR,
                           SCHEMA_VERSION, TempDbCase, fixture_db, read_db,
                           write_db)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class HttpIsolatedSmokeTest(TempDbCase, unittest.TestCase):
    def _boot(self, data_file, port, proc):
        env = {k: v for k, v in os.environ.items() if k != "DATA_FILE"}
        env["DATA_FILE"] = str(data_file)
        env["PORT"] = str(port)
        p = subprocess.Popen([sys.executable, "app.py"], cwd=str(PORTAL_DIR),
                             env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True)
        proc.append(p)
        deadline = time.time() + 30
        while time.time() < deadline:
            if p.poll() is not None:
                self.fail(f"Flask exit sớm rc={p.returncode}: {p.stderr.read()}")
            try:
                with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/api/health", timeout=2) as res:
                    if res.status == 200:
                        return json.loads(res.read().decode())
            except (urllib.error.URLError, OSError):
                time.sleep(0.2)
        self.fail("Flask không boot được trong 30s")

    def _req(self, port, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}", data=data, method=method,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read().decode() or "{}")

    def test_http_mutation_survives_restart_without_losing_collections(self):
        procs = []
        def _shutdown():
            for proc in procs:
                if proc.poll() is None:
                    proc.terminate()
                try:
                    proc.wait(timeout=10)
                except Exception:
                    pass
                for stream in (proc.stdout, proc.stderr):
                    if stream and not stream.closed:
                        stream.close()
        self.addCleanup(_shutdown)
        write_db(self.data_file, fixture_db(extra={"customVendorCollection": [{"id": 55}]}))
        port = free_port()

        health = self._boot(self.data_file, port, procs)
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["framework"], "Flask")

        status, asset = self._req(port, "POST", "/api/assets", {
            "tag": "LP-HTTP-777", "brand": "Asus", "model": "ExpertBook",
            "serial": "SN-777", "dept": "IT Support",
        })
        self.assertEqual(status, 201)
        status, ticket = self._req(port, "POST", "/api/tickets", {
            "title": "HTTP smoke ticket", "requester": "QA W6", "priority": "High",
        })
        self.assertEqual(status, 201)
        status, updated = self._req(port, "PATCH",
                                    f"/api/tickets/{ticket['id']}/status",
                                    {"status": "Resolved"})
        self.assertEqual(status, 200)
        self.assertEqual(updated["status"], "Resolved")

        procs[0].terminate()
        procs[0].wait(timeout=15)

        self._boot(self.data_file, port, procs)
        status, assets = self._req(port, "GET", "/api/assets")
        self.assertEqual(status, 200)
        self.assertIn("LP-HTTP-777", [a.get("tag") for a in assets])

        status, tickets = self._req(port, "GET", "/api/tickets")
        self.assertEqual(status, 200)
        self.assertIn(ticket["id"], [t.get("id") for t in tickets])
        self.assertEqual(next(t for t in tickets if t["id"] == ticket["id"])["status"],
                         "Resolved")

        after = read_db(self.data_file)
        self.assertEqual(after["schemaVersion"], SCHEMA_VERSION)
        for key in DEFAULT_NODE_COLLECTIONS:
            self.assertIn(key, after, f"collection {key} mất sau HTTP smoke")
        self.assertEqual(after["customVendorCollection"], [{"id": 55}])
        leftovers = [p.name for p in self.data_file.parent.iterdir()
                     if p.name.startswith("db.json.tmp-")]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
