"""W6 fix round 3 — concurrency: MỌI request (đọc và ghi) nằm trong một
critical section; sau ghi đĩa thành công thì swap pointer `global DB`.

Dùng ThreadPoolExecutor + Barrier để thực sự chạy song song trong test client.
"""
try:
    import pytest
    pytest.importorskip("flask", reason="flask not installed; runs in CI with requirements")
except ImportError:
    pass  # pytest absent (unittest-only venv): nothing to skip-guard

import copy
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from tests.harness import TempDbCase, fixture_db, load_app, read_db, write_db


class ConcurrencyTest(TempDbCase, unittest.TestCase):
    WORKERS = 8

    def setUp(self):
        super().setUp()
        write_db(self.data_file, fixture_db())
        self.mod = load_app(self.data_file, port=5017, case=self)
        self.mod.app.config["TESTING"] = False  # giữ error handler 500 như thật
        self._real_save = self.mod.save_db

    def _client(self):
        return self.mod.app.test_client()

    def _run_parallel(self, fn, count=None):
        """fn(i) chạy đồng thời — barrier đảm bảo thật sự overlap."""
        count = count or self.WORKERS
        barrier = threading.Barrier(count)
        results = [None] * count

        def worker(i):
            barrier.wait(timeout=30)
            results[i] = fn(i)
        with ThreadPoolExecutor(max_workers=count) as pool:
            list(pool.map(worker, range(count)))
        return results

    # ---------------------------------------------------------------- writes
    def test_concurrent_posts_create_unique_ids(self):
        def post(i):
            res = self._client().post("/api/assets", json={
                "tag": f"LP-CONC-{i}", "brand": "B", "model": "M", "serial": f"S{i}"})
            return res.status_code, res.get_json(silent=True)
        results = self._run_parallel(post)
        statuses = [s for s, _ in results]
        self.assertEqual(statuses, [201] * self.WORKERS, f"mọi POST phải 201: {results}")
        ids = [body["id"] for _, body in results]
        self.assertEqual(len(set(ids)), self.WORKERS, f"id phải unique: {ids}")
        self.assertEqual(len(set(ids)), len(ids), "id trùng -> race trong next_id")

        on_disk = [a for a in read_db(self.data_file)["assets"] if isinstance(a, dict)]
        disk_ids = [a["id"] for a in on_disk]
        self.assertEqual(len(disk_ids), len(set(disk_ids)), f"id trùng trên đĩa: {disk_ids}")
        tags = {a.get("tag") for a in on_disk}
        for i in range(self.WORKERS):
            self.assertIn(f"LP-CONC-{i}", tags)

    def test_concurrent_duplicate_tag_is_rejected_once(self):
        def post(_i):
            res = self._client().post("/api/assets", json={
                "tag": "LP-DUP", "brand": "B", "model": "M", "serial": "S"})
            return res.status_code
        statuses = self._run_parallel(post)
        self.assertEqual(statuses.count(201), 1,
                         f"trùng tag phải đúng 1 lần 201: {statuses}")
        self.assertEqual(statuses.count(409), self.WORKERS - 1)
        after = read_db(self.data_file)["assets"]
        self.assertEqual(sum(1 for a in after
                             if isinstance(a, dict) and a.get("tag") == "LP-DUP"), 1)

    def test_concurrent_patch_updates_single_row_without_duplicates(self):
        tid = next(t["id"] for t in self.mod.DB["tickets"]
                   if isinstance(t, dict) and "id" in t)
        statuses_pool = ["Open", "In Progress", "Resolved", "Closed"]

        def patch(i):
            res = self._client().patch(f"/api/tickets/{tid}/status",
                                       json={"status": statuses_pool[i % 4]})
            return res.status_code
        results = self._run_parallel(patch)
        self.assertTrue(all(s == 200 for s in results), f"mọi PATCH phải 200: {results}")

        disk_rows = [t for t in read_db(self.data_file)["tickets"]
                     if isinstance(t, dict) and t.get("id") == tid]
        self.assertEqual(len(disk_rows), 1,
                         f"ticket id={tid} phải có đúng 1 dòng: {disk_rows}")
        self.assertIn(disk_rows[0]["status"], statuses_pool)
        ram_rows = [t for t in self.mod.DB["tickets"]
                    if isinstance(t, dict) and t.get("id") == tid]
        self.assertEqual(len(ram_rows), 1, "RAM cũng phải đúng 1 dòng")

    # ---------------------------------------------------------------- reads
    def test_concurrent_reads_during_writes_never_fail_or_return_empty(self):
        errors = []
        stop = threading.Event()

        def reader():
            while not stop.is_set():
                client = self._client()
                for path, key in (("/api/assets", None), ("/api/tickets", None),
                                  ("/api/dashboard/stats", "totalAssets"),
                                  ("/api/health", "counts")):
                    res = client.get(path)
                    if res.status_code != 200:
                        errors.append((path, res.status_code, res.get_data(as_text=True)[:120]))
                        return
                    body = res.get_json(silent=True)
                    if body is None:
                        errors.append((path, "no-json", ""))
                        return
                    if key and key not in body:
                        errors.append((path, "missing-key", key))
                        return
                res = self._client().get("/api/assets/export.csv")
                if res.status_code != 200:
                    errors.append(("/api/assets/export.csv", res.status_code, ""))

        def writer(i):
            for j in range(3):
                res = self._client().post("/api/assets", json={
                    "tag": f"LP-RW-{i}-{j}", "brand": "B", "model": "M",
                    "serial": f"S{i}{j}"})
                if res.status_code != 201:
                    errors.append(("POST", res.status_code, res.get_data(as_text=True)[:120]))
                    return

        with ThreadPoolExecutor(max_workers=1 + self.WORKERS) as pool:
            readers = [pool.submit(reader) for _ in range(self.WORKERS - 1)]
            writers = [pool.submit(writer, i) for i in range(3)]
            for f in writers:
                f.result()
            stop.set()
            for f in readers:
                f.result()
        self.assertEqual(errors, [], f"reader gặp lỗi khi write: {errors[:5]}")

    def test_health_counts_stay_consistent_under_concurrent_writes(self):
        def write(i):
            res = self._client().post("/api/tickets", json={
                "title": f"concurrent {i}", "requester": "QA"})
            return res.status_code
        self._run_parallel(write)
        health = self._client().get("/api/health").get_json()
        disk = read_db(self.data_file)
        self.assertEqual(health["counts"]["tickets"], len(disk["tickets"]))
        self.assertEqual(health["counts"]["assets"], len(disk["assets"]))

    # -------------------------------------------------------------- rollback
    def test_save_failure_under_concurrency_rolls_back_and_keeps_readers_ok(self):
        before = copy.deepcopy(self.mod.DB)
        disk_before = read_db(self.data_file)
        errors = []

        def failing_write(i):
            res = self._client().post("/api/assets", json={
                "tag": f"LP-ROLLBACK-{i}", "brand": "B", "model": "M", "serial": "S"})
            return res.status_code, res.get_data(as_text=True)

        def read_during_failure():
            res = self._client().get("/api/health")
            if res.status_code != 200:
                errors.append(("health", res.status_code))

        def boom(db):
            raise OSError(28, "No space left on device", "simulated")

        # Patch MỘT LẦN cho cả phase: nếu patch/rollback từng thread thì một
        # thread có thể khôi phục save_db giữa lúc thread khác đang ghi -> false pass.
        self.mod.save_db = boom
        try:
            with ThreadPoolExecutor(max_workers=self.WORKERS) as pool:
                writes = [pool.submit(failing_write, i) for i in range(4)]
                readers = [pool.submit(read_during_failure) for _ in range(4)]
                results = [f.result() for f in writes]
                for f in readers:
                    f.result()
        finally:
            self.mod.save_db = self._real_save

        for status, body in results:
            self.assertGreaterEqual(status, 400, f"phải báo lỗi: {status}")
            self.assertNotIn("Traceback", body, "client không được thấy traceback")
            payload = json.loads(body)
            self.assertIn("error", payload)
        self.assertEqual(errors, [], f"reader phải vẫn 200 khi writer lỗi: {errors}")
        self.assertEqual(self.mod.DB, before, "RAM phải giữ pre-state khi save lỗi")
        self.assertEqual(read_db(self.data_file), disk_before, "đĩa phải không đổi")

    def test_failed_write_logs_error_without_breaking_subsequent_writes(self):
        with self.assertLogs("app", level="ERROR") as captured:
            def boom(db):
                raise OSError(28, "No space left on device", "simulated")
            self.mod.save_db = boom
            try:
                res = self._client().post("/api/assets", json={
                    "tag": "LP-LOG", "brand": "B", "model": "M", "serial": "S"})
            finally:
                self.mod.save_db = self._real_save
        self.assertEqual(res.status_code, 500)
        self.assertTrue(any("save assets" in line for line in captured.output),
                        f"phải log lỗi có ngữ cảnh: {captured.output}")
        res = self._client().post("/api/assets", json={
            "tag": "LP-AFTER-LOG", "brand": "B", "model": "M", "serial": "S"})
        self.assertEqual(res.status_code, 201, "ghi lại sau lỗi phải thành công")


if __name__ == "__main__":
    unittest.main(verbosity=2)
