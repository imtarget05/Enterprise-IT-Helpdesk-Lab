"""W6 fix round 1 — fail-safe data (IMP-1, MIN-3..MIN-7, MIN-11).

File tồn tại mà không đọc/parse được -> backup `.corrupt-*` rồi TỪ CHỐI ghi
(không overwrite). File không tồn tại -> hợp lệ, seed.
"""
try:
    import pytest
    pytest.importorskip("flask", reason="flask not installed; runs in CI with requirements")
except ImportError:
    pass  # pytest absent (unittest-only venv): nothing to skip-guard

import builtins
import json
import os
import stat
import unittest
from pathlib import Path

from tests.harness import (CANONICAL, SCHEMA_VERSION, TempDbCase, fixture_db,
                           load_app, read_db, write_db)


def _tmp_leftovers(directory: Path):
    return sorted(p.name for p in Path(directory).iterdir()
                  if p.name.startswith("db.json.tmp-"))


class CorruptDataFileTest(TempDbCase, unittest.TestCase):
    def _mod(self, seed=None):
        write_db(self.data_file, seed or fixture_db())
        return load_app(self.data_file, port=5088, case=self)

    def test_malformed_json_backs_up_and_aborts_without_overwrite(self):
        broken = b'{"assets": [{"id": 1}, '  # bị truncate
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        self.data_file.write_bytes(broken)
        mod = load_app(self.data_file, port=5087, case=self)

        with self.assertRaises(Exception) as ctx:
            mod.save_db({"assets": [{"id": 99, "tag": "X"}], "tickets": [], "licenses": []})
        message = str(ctx.exception).lower()
        self.assertIn("corrupt", message)
        self.assertIn(str(self.data_file.name).lower(), message)

        self.assertEqual(self.data_file.read_bytes(), broken,
                         "file gốc phải giữ nguyên byte-identical")
        backups = sorted(p.name for p in self.data_file.parent.iterdir()
                         if ".corrupt-" in p.name)
        self.assertGreaterEqual(len(backups), 1,
                                f"phải có backup .corrupt-*: {backups}")
        for name in backups:  # import-time + write-time đều phải backup nguyên trạng
            self.assertEqual((self.data_file.parent / name).read_bytes(), broken)
        self.assertEqual(_tmp_leftovers(self.data_file.parent), [],
                         "không được rò temp file khi abort")

    def test_non_dict_json_backs_up_and_aborts(self):
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        raw = b'[1, 2, 3]'
        self.data_file.write_bytes(raw)
        mod = load_app(self.data_file, port=5086, case=self)
        with self.assertRaises(Exception) as ctx:
            mod.save_db({"assets": [], "tickets": [], "licenses": []})
        self.assertIn("corrupt", str(ctx.exception).lower())
        self.assertEqual(self.data_file.read_bytes(), raw)
        self.assertEqual(_tmp_leftovers(self.data_file.parent), [])

    def test_unreadable_file_aborts_write_and_keeps_bytes(self):
        raw = b'{"assets": []}'
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        self.data_file.write_bytes(raw)
        mod = load_app(self.data_file, port=5085, case=self)
        real_open = builtins.open
        target = str(self.data_file)

        def deny(path, *args, **kwargs):
            if str(path) == target:
                raise PermissionError(13, "Permission denied", target)
            return real_open(path, *args, **kwargs)

        builtins.open = deny
        try:
            with self.assertRaises(PermissionError):
                mod._read_raw()
            with self.assertRaises(Exception) as ctx:
                mod.save_db({"assets": [{"id": 5}], "tickets": [], "licenses": []})
        finally:
            builtins.open = real_open
        self.assertNotIn("corrupt", str(ctx.exception).lower(),
                         "không đọc được file thì abort, không cần/nên sinh backup")
        self.assertEqual(self.data_file.read_bytes(), raw)
        self.assertEqual(_tmp_leftovers(self.data_file.parent), [])

    def test_chmod_000_file_does_not_get_overwritten(self):
        raw = b'{"assets": []}'
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        self.data_file.write_bytes(raw)
        mod = load_app(self.data_file, port=5084, case=self)
        os.chmod(self.data_file, 0)
        self.addCleanup(os.chmod, self.data_file, stat.S_IRUSR | stat.S_IWUSR)
        if os.access(self.data_file, os.R_OK):  # pragma: no cover - root
            self.skipTest("chmod 000 vẫn đọc được (đang chạy root?)")
        with self.assertRaises(OSError):
            mod.save_db({"assets": [{"id": 7}], "tickets": [], "licenses": []})
        os.chmod(self.data_file, stat.S_IRUSR | stat.S_IWUSR)
        self.assertEqual(self.data_file.read_bytes(), raw)
        self.assertEqual(_tmp_leftovers(self.data_file.parent), [])

    def test_missing_file_is_valid_and_seeds_full_schema(self):
        self.assertFalse(self.data_file.exists())
        mod = load_app(self.data_file, port=5083, case=self)
        mod.save_db(mod.load_db())
        fresh = read_db(self.data_file)
        self.assertEqual(fresh["schemaVersion"], SCHEMA_VERSION)
        for key in CANONICAL:
            self.assertIn(key, fresh, f"collection canonical {key} phải có trong file mới")
            self.assertIsInstance(fresh[key], list)
        self.assertEqual([p.name for p in self.data_file.parent.iterdir()
                          if ".corrupt-" in p.name], [],
                         "file không tồn tại là hợp lệ -> không sinh backup corrupt")

    def test_replace_failure_keeps_original_and_cleans_temp(self):
        seed = fixture_db()
        write_db(self.data_file, seed)
        before = self.data_file.read_bytes()
        mod = load_app(self.data_file, port=5082, case=self)
        real_replace = os.replace
        calls = []

        def boom(src, dst, *a, **kw):
            calls.append((str(src), str(dst)))
            raise OSError(28, "No space left on device", str(dst))

        os.replace = boom
        try:
            with self.assertRaises(OSError):
                mod.save_db({"assets": [{"id": 3, "tag": "Z"}], "tickets": [], "licenses": []})
        finally:
            os.replace = real_replace
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.data_file.read_bytes(), before,
                         "replace fail -> file gốc phải nguyên vẹn")
        self.assertEqual(_tmp_leftovers(self.data_file.parent), [],
                         "replace fail -> temp file phải được dọn")


class DurabilityTest(TempDbCase, unittest.TestCase):
    def test_fsyncs_file_and_directory_after_replace(self):
        write_db(self.data_file, fixture_db())
        mod = load_app(self.data_file, port=5081, case=self)
        real_fsync, real_open, real_replace = os.fsync, os.open, os.replace
        fsynced, opened, order = [], [], []

        def track_fsync(fd):
            fsynced.append(fd)
            return real_fsync(fd)

        def track_open(path, flags, *a, **kw):
            fd = real_open(path, flags, *a, **kw)
            opened.append((str(path), flags))
            return fd

        def track_replace(src, dst, *a, **kw):
            order.append("replace")
            return real_replace(src, dst, *a, **kw)

        os.fsync, os.open, os.replace = track_fsync, track_open, track_replace
        try:
            mod.save_db(mod.load_db())
        finally:
            os.fsync, os.open, os.replace = real_fsync, real_open, real_replace

        self.assertGreaterEqual(len(fsynced), 2, f"phải fsync cả file lẫn directory: {fsynced}")
        dir_opens = [f for path, f in opened
                     if str(path) == str(self.data_file.parent)]
        self.assertTrue(dir_opens,
                        f"phải mở fd của directory để fsync: {opened}")
        self.assertTrue(all(f & os.O_RDONLY == os.O_RDONLY for f in dir_opens))
        self.assertIn("replace", order)

    def test_directory_fsync_failure_does_not_lose_the_write(self):
        write_db(self.data_file, fixture_db())
        mod = load_app(self.data_file, port=5080, case=self)
        real_fsync, real_open = os.fsync, os.open
        target_dir = str(self.data_file.parent)

        def picky_fsync(fd):
            try:
                path = os.fstat(fd)
            except OSError:
                return real_fsync(fd)
            if stat.S_ISDIR(getattr(path, "st_mode", 0)):
                raise OSError(22, "Invalid argument", "dir fsync unsupported")
            return real_fsync(fd)

        os.fsync = picky_fsync
        try:
            mod.save_db(mod.load_db())
        finally:
            os.fsync = real_fsync
        self.assertTrue(self.data_file.exists())
        self.assertEqual(read_db(self.data_file)["schemaVersion"], SCHEMA_VERSION)


class MergeSemanticsTest(TempDbCase, unittest.TestCase):
    def test_non_dict_rows_on_disk_are_preserved(self):
        seed = fixture_db()
        seed["tickets"] = ["legacy-scalar-row", {"id": 1, "title": "T"}]
        write_db(self.data_file, seed)
        mod = load_app(self.data_file, port=5079, case=self)
        res = mod.app.test_client().post("/api/tickets",
                                        json={"title": "New", "requester": "QA"})
        self.assertEqual(res.status_code, 201,
                         f"row scalar không được làm route lỗi: {res.status_code}")
        self.assertNotIn("Traceback", res.get_data(as_text=True))
        after = read_db(self.data_file)
        self.assertIn("legacy-scalar-row", after["tickets"],
                      "row không phải dict không được âm thầm bị drop")

    def test_key_deleted_by_other_process_is_not_resurrected(self):
        seed = fixture_db(extra={"customVendorCollection": [{"id": 55}]})
        write_db(self.data_file, seed)
        mod = load_app(self.data_file, port=5078, case=self)

        external = read_db(self.data_file)
        del external["customVendorCollection"]
        write_db(self.data_file, external)

        mod.app.test_client().post("/api/assets", json={
            "tag": "LP-NORESURRECT", "brand": "X", "model": "Y", "serial": "Z"})
        after = read_db(self.data_file)
        self.assertNotIn("customVendorCollection", after,
                         "không được hồi sinh key đã bị process khác xóa")
        self.assertIn("LP-NORESURRECT", [a.get("tag") for a in after["assets"]])

    def test_missing_canonical_collections_are_seeded_from_canonical_list(self):
        seed = fixture_db()
        for key in ("problems", "notifications", "monitoringHistory"):
            seed.pop(key)
        write_db(self.data_file, seed)
        mod = load_app(self.data_file, port=5077, case=self)
        mod.save_db(mod.load_db())
        after = read_db(self.data_file)
        for key in CANONICAL:
            self.assertIn(key, after, f"thiếu collection canonical {key}")
            self.assertIsInstance(after[key], list)


class GuardFailClosedTest(TempDbCase, unittest.TestCase):
    def test_resolve_error_fails_closed(self):
        import subprocess
        import sys

        from tests.harness import PORTAL_DIR

        script = (
            "import pathlib\n"
            "orig = pathlib.Path.resolve\n"
            "def boom(self, *a, **kw):\n"
            "    raise OSError('resolve failed')\n"
            "pathlib.Path.resolve = boom\n"
            "import app\n"
        )
        env = {k: v for k, v in os.environ.items() if k != "DATA_FILE"}
        proc = subprocess.run([sys.executable, "-c", script], cwd=str(PORTAL_DIR),
                              env={**env, "DATA_FILE": str(self.data_file)},
                              capture_output=True, text=True, timeout=60)
        self.assertNotEqual(proc.returncode, 0,
                            "guard phải fail-closed khi resolve() lỗi")
        output = (proc.stdout + proc.stderr).lower()
        self.assertTrue("resolve" in output or "không xác định" in output
                        or "unsupported" in output, output[-400:])


class DefaultHostTest(TempDbCase, unittest.TestCase):
    def test_default_bind_host_is_loopback_and_env_overridable(self):
        import importlib
        import sys

        from tests.harness import PORTAL_DIR

        source = (PORTAL_DIR / "app.py").read_text(encoding="utf-8")
        self.assertIn('os.environ.get("HOST", "127.0.0.1")', source,
                      "default host phải là loopback (demo-only, không auth)")
        write_db(self.data_file, fixture_db())
        os.environ["HOST"] = "127.0.0.1"
        self.addCleanup(os.environ.pop, "HOST", None)
        sys.modules.pop("app", None)
        mod = importlib.import_module("app")
        self.assertEqual(mod.HOST, "127.0.0.1")
        self.assertNotIn('host="0.0.0.0"', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
