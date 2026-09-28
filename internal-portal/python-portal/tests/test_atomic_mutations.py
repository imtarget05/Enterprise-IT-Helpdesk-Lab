"""W6 fix round 2 — row identity an toàn + atomic in-memory/disk.

1) Row không phải dict (legacy scalar) trong collection trên đĩa không được
   làm route 500, không được mất, và phải giữ thứ tự.
2) Mutating route chỉ commit vào `app.DB` SAU khi `save_db` thành công: save lỗi
   -> HTTP lỗi, RAM không đổi, retry tạo đúng một row (không nhân bản).
"""
try:
    import pytest
    pytest.importorskip("flask", reason="flask not installed; runs in CI with requirements")
except ImportError:
    pass  # pytest absent (unittest-only venv): nothing to skip-guard

import copy
import csv
import io
import unittest

from tests.harness import TempDbCase, fixture_db, load_app, read_db, write_db

ASSET_FIELDS = ("id", "tag", "type", "brand", "model", "serial",
                "assignedTo", "dept", "status", "ip")


class NonDictRowTest(TempDbCase, unittest.TestCase):
    def _mod(self, assets=None, tickets=None):
        seed = fixture_db()
        if assets is not None:
            seed["assets"] = assets
        if tickets is not None:
            seed["tickets"] = tickets
        write_db(self.data_file, seed)
        mod = load_app(self.data_file, port=5049, case=self)
        self.client = mod.app.test_client()
        return mod

    def test_post_asset_with_scalar_rows_returns_201_and_keeps_scalars(self):
        mod = self._mod(assets=["legacy-scalar-a", {"id": 1, "tag": "T1"}, 42, None])
        res = self.client.post("/api/assets", json={
            "tag": "LP-ROUND2-1", "brand": "HP", "model": "M", "serial": "S"})
        self.assertEqual(res.status_code, 201,
                         f"scalar rows không được làm route lỗi: {res.status_code} "
                         f"{res.get_data(as_text=True)[:200]}")
        self.assertNotIn("Traceback", res.get_data(as_text=True))
        after = read_db(self.data_file)["assets"]
        self.assertEqual(after[:4], ["legacy-scalar-a", {"id": 1, "tag": "T1"}, 42, None],
                         f"phải giữ nguyên thứ tự row scalar: {after[:4]}")
        self.assertEqual(after[4]["tag"], "LP-ROUND2-1")

    def test_post_ticket_with_scalar_rows_returns_201(self):
        mod = self._mod(tickets=["legacy-ticket-scalar", {"id": 1, "title": "T"}])
        res = self.client.post("/api/tickets", json={
            "title": "Round2 ticket", "requester": "QA"})
        self.assertEqual(res.status_code, 201, res.get_data(as_text=True)[:200])
        after = read_db(self.data_file)["tickets"]
        self.assertEqual(after[:2], ["legacy-ticket-scalar", {"id": 1, "title": "T"}])
        self.assertEqual(after[2]["title"], "Round2 ticket")

    def test_patch_status_with_scalar_rows_returns_200(self):
        mod = self._mod(tickets=["scalar", {"id": 1005, "title": "Target", "status": "Open"}])
        res = self.client.patch("/api/tickets/1005/status", json={"status": "Resolved"})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True)[:200])
        after = read_db(self.data_file)["tickets"]
        self.assertEqual(after[0], "scalar")
        self.assertEqual(after[1]["status"], "Resolved")

    def test_merge_rows_ignores_incoming_non_dict_rows(self):
        """Contract vòng 3: Flask chỉ quản lý dict row. Row non-dict trong base
        được giữ nguyên; row non-dict trong incoming bị bỏ qua (không insert)."""
        mod = load_app(self.data_file, port=5048, case=self)
        merged = mod._merge_rows(
            ["a", {"id": 1, "v": "base"}, "b"],
            ["a", {"id": 1, "v": "flask"}, "c", {"id": 2, "v": "new"}],
        )
        self.assertEqual(merged, ["a", {"id": 1, "v": "flask"}, "b", {"id": 2, "v": "new"}])

    def test_repeated_saves_do_not_duplicate_scalar_rows(self):
        mod = self._mod(assets=["scalar-x", {"id": 1, "tag": "T1"}])
        for _ in range(3):
            mod.save_db(mod.DB)
        after = read_db(self.data_file)["assets"]
        self.assertEqual(after, ["scalar-x", {"id": 1, "tag": "T1"}],
                         f"lưp lại nhiều lần không được nhân bản row: {after}")

    def test_export_csv_with_scalar_rows_returns_200_and_valid_csv(self):
        self._mod(assets=["scalar-asset", {"id": 1, "tag": "T1", "serial": "S1"}])
        res = self.client.get("/api/assets/export.csv")
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True)[:200])
        rows = list(csv.reader(io.StringIO(res.get_data(as_text=True))))
        self.assertEqual(rows[0], list(ASSET_FIELDS))
        self.assertEqual(len(rows), 3, f"phải có header + 2 dòng dữ liệu: {rows}")
        self.assertEqual(rows[1][0], "scalar-asset")


class AtomicInMemoryTest(TempDbCase, unittest.TestCase):
    def setUp(self):
        super().setUp()
        write_db(self.data_file, fixture_db())
        self.mod = load_app(self.data_file, port=5047, case=self)
        self.client = self.mod.app.test_client()
        self._real_save = self.mod.save_db

    def _break_save(self):
        def boom(db):
            raise OSError(28, "No space left on device", str(self.data_file))
        self.mod.save_db = boom
        self.addCleanup(setattr, self.mod, "save_db", self._real_save)

    def _assert_no_traceback(self, res):
        body = res.get_data(as_text=True)
        self.assertNotIn("Traceback", body)
        self.assertNotIn("AttributeError", body)
        self.assertGreaterEqual(res.status_code, 400)
        self.assertIn("error", res.get_json(silent=True) or {})

    def test_failed_save_on_post_asset_leaves_ram_unchanged_then_retry_adds_one_row(self):
        before = copy.deepcopy(self.mod.DB)
        before_ref = self.mod.DB
        self._break_save()
        res = self.client.post("/api/assets", json={
            "tag": "LP-ATOMIC-1", "brand": "B", "model": "M", "serial": "S"})
        self._assert_no_traceback(res)
        self.assertEqual(self.mod.DB, before, "RAM phải giữ nguyên khi save lỗi")
        self.assertIs(self.mod.DB, before_ref,
                      "save lỗi -> pointer DB không được đổi (vẫn là object cũ)")

        setattr(self.mod, "save_db", self._real_save)
        res = self.client.post("/api/assets", json={
            "tag": "LP-ATOMIC-1", "brand": "B", "model": "M", "serial": "S"})
        self.assertEqual(res.status_code, 201, res.get_data(as_text=True)[:200])
        tags = [a.get("tag") for a in self.mod.DB["assets"] if isinstance(a, dict)]
        self.assertEqual(tags.count("LP-ATOMIC-1"), 1, "retry phải tạo đúng một row")
        on_disk = [a.get("tag") for a in read_db(self.data_file)["assets"]
                   if isinstance(a, dict)]
        self.assertEqual(on_disk.count("LP-ATOMIC-1"), 1)

    def test_failed_save_on_post_ticket_leaves_ram_unchanged_then_retry_adds_one_row(self):
        before = copy.deepcopy(self.mod.DB)
        self._break_save()
        res = self.client.post("/api/tickets", json={
            "title": "Atomic ticket", "requester": "QA"})
        self._assert_no_traceback(res)
        self.assertEqual(self.mod.DB, before)

        setattr(self.mod, "save_db", self._real_save)
        res = self.client.post("/api/tickets", json={"title": "Atomic ticket",
                                                     "requester": "QA"})
        self.assertEqual(res.status_code, 201, res.get_data(as_text=True)[:200])
        titles = [t.get("title") for t in self.mod.DB["tickets"] if isinstance(t, dict)]
        self.assertEqual(titles.count("Atomic ticket"), 1, "retry không được nhân bản")
        self.assertEqual(self.mod.DB["tickets"][0]["title"], "Atomic ticket")

    def test_failed_save_on_patch_status_leaves_ram_unchanged(self):
        tid = next(t["id"] for t in self.mod.DB["tickets"]
                   if isinstance(t, dict) and "id" in t)
        # đưa ticket về trạng thái Open trước, rồi thử đổi sang Closed khi save lỗi
        self.mod.DB["tickets"] = [
            dict(t, status="Open") if isinstance(t, dict) and t.get("id") == tid else t
            for t in self.mod.DB["tickets"]]
        self.mod.save_db(self.mod.DB)
        before = copy.deepcopy(self.mod.DB)
        self._break_save()
        res = self.client.patch(f"/api/tickets/{tid}/status", json={"status": "Closed"})
        self._assert_no_traceback(res)
        self.assertEqual(self.mod.DB, before, "RAM phải giữ nguyên khi save lỗi")
        status_now = next(t["status"] for t in self.mod.DB["tickets"]
                          if isinstance(t, dict) and t.get("id") == tid)
        self.assertEqual(status_now, "Open", "status trong RAM không được đổi")

        setattr(self.mod, "save_db", self._real_save)
        res = self.client.patch(f"/api/tickets/{tid}/status", json={"status": "Closed"})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True)[:200])
        status_after = next(t["status"] for t in self.mod.DB["tickets"]
                            if isinstance(t, dict) and t.get("id") == tid)
        self.assertEqual(status_after, "Closed")
        self.assertEqual(
            sum(1 for t in read_db(self.data_file)["tickets"]
                if isinstance(t, dict) and t.get("id") == tid
                and t.get("status") == "Closed"), 1,
            "trên đĩa cũng chỉ có đúng một row đã đổi")

    def test_successful_commit_swaps_db_pointer_atomically(self):
        """Contract vòng 3: sau ghi đĩa thành công thì `global DB = snapshot`
        (pointer swap), không clear/update in-place. Object cũ trở thành snapshot
        bất biến; mọi thứ đọc DB phải đi qua `app.DB`."""
        before_ref = self.mod.DB
        res = self.client.post("/api/assets", json={
            "tag": "LP-SWAP", "brand": "B", "model": "M", "serial": "S"})
        self.assertEqual(res.status_code, 201, res.get_data(as_text=True)[:200])
        self.assertIsNot(self.mod.DB, before_ref,
                         "commit phải swap pointer sang snapshot mới")
        self.assertNotIn("LP-SWAP", [a.get("tag") for a in before_ref["assets"]
                                     if isinstance(a, dict)],
                         "object cũ không được bị mutate in-place")
        self.assertIn("LP-SWAP", [a.get("tag") for a in self.mod.DB["assets"]
                                  if isinstance(a, dict)])
        self.assertIn("LP-SWAP", [a.get("tag") for a in read_db(self.data_file)["assets"]
                                  if isinstance(a, dict)])

    def test_failed_save_does_not_leave_tmp_file(self):
        self._break_save()
        res = self.client.post("/api/assets", json={
            "tag": "LP-TMP", "brand": "B", "model": "M", "serial": "S"})
        self.assertGreaterEqual(res.status_code, 400)
        leftovers = [p.name for p in self.data_file.parent.iterdir()
                     if p.name.startswith("db.json.tmp-")]
        self.assertEqual(leftovers, [], f"không được rò temp file: {leftovers}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
