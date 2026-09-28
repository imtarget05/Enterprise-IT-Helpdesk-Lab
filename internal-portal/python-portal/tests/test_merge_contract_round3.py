"""W6 fix round 3 — merge contract: Flask chỉ quản lý dict rows.

- Row non-dict trong base: giữ nguyên vẹn, không bị thay, không bị nhân bản.
- Row non-dict trong incoming (stale RAM): bị BỎ QUA, không insert.
- Dict rows: merge theo `id`; duplicate id trong base -> canonical (một dòng).
"""
try:
    import pytest
    pytest.importorskip("flask", reason="flask not installed; runs in CI with requirements")
except ImportError:
    pass  # pytest absent (unittest-only venv): nothing to skip-guard

import unittest

from tests.harness import TempDbCase, fixture_db, load_app, read_db, write_db


class MergeContractTest(TempDbCase, unittest.TestCase):
    def _mod(self, assets):
        seed = fixture_db()
        seed["assets"] = assets
        write_db(self.data_file, seed)
        mod = load_app(self.data_file, port=5018, case=self)
        return mod

    def test_non_dict_base_rows_kept_verbatim_and_never_duplicated(self):
        mod = self._mod([
            {"id": 1, "tag": "A1"},
            "scalar-middle",
            {"id": 2, "tag": "A2"},
            7,
            None,
        ])
        for _ in range(3):  # lưp lại nhiều lần (giống nhiều route save)
            mod.save_db(mod.DB)
        after = read_db(self.data_file)["assets"]
        self.assertEqual(after[:5], [
            {"id": 1, "tag": "A1"}, "scalar-middle", {"id": 2, "tag": "A2"}, 7, None,
        ], f"scalar rows phải giữ nguyên và không bị nhân bản: {after}")

    def test_incoming_non_dict_rows_are_ignored(self):
        mod = self._mod([{"id": 1, "tag": "A1"}])
        merged = mod._merge_rows(
            [{"id": 1, "tag": "A1"}],
            ["stale-scalar", 42, {"id": 2, "tag": "FLASK-NEW"}],
        )
        self.assertEqual(merged, [{"id": 1, "tag": "A1"}, {"id": 2, "tag": "FLASK-NEW"}],
                         "Flask không quản lý non-dict -> incoming non-dict phải bị bỏ qua")

    def test_duplicate_dict_ids_in_base_are_canonicalized(self):
        mod = self._mod([
            {"id": 1, "tag": "OLD-A"},
            {"id": 2, "tag": "KEEP"},
            {"id": 1, "tag": "DUP-A"},
        ])
        mod.save_db(mod.DB)
        after = read_db(self.data_file)["assets"]
        ids = [r["id"] for r in after if isinstance(r, dict)]
        self.assertEqual(sorted(ids), [1, 2], f"duplicate id phải canonical: {after}")
        self.assertEqual([r["tag"] for r in after if isinstance(r, dict)], ["OLD-A", "KEEP"])

    def test_incoming_row_replaces_base_row_with_same_id(self):
        mod = self._mod([{"id": 1, "tag": "BASE"}, "scalar"])
        merged = mod._merge_rows(
            [{"id": 1, "tag": "BASE"}, "scalar"],
            [{"id": 1, "tag": "FLASK"}],
        )
        self.assertEqual(merged, [{"id": 1, "tag": "FLASK"}, "scalar"])

    def test_repeated_route_saves_with_scalar_middle(self):
        mod = self._mod([{"id": 1, "tag": "A1"}, "scalar-middle", {"id": 2, "tag": "A2"}])
        client = mod.app.test_client()
        for i in range(3):
            res = client.post("/api/assets", json={
                "tag": f"LP-R3-{i}", "brand": "B", "model": "M", "serial": f"S{i}"})
            self.assertEqual(res.status_code, 201, res.get_data(as_text=True)[:200])
        after = read_db(self.data_file)["assets"]
        self.assertEqual(after.count("scalar-middle"), 1,
                         f"scalar không được nhân bản sau 3 lần ghi: {after}")
        self.assertEqual(len([r for r in after if isinstance(r, dict)]), 5)
        tags = [r.get("tag") for r in after if isinstance(r, dict)]
        self.assertEqual(tags[:2], ["A1", "A2"], "row gốc giữ thứ tự ở đầu")
        self.assertEqual(tags[2:], ["LP-R3-0", "LP-R3-1", "LP-R3-2"],
                         "row mới của Flask append sau row gốc, không chen giữa scalar")


if __name__ == "__main__":
    unittest.main(verbosity=2)
