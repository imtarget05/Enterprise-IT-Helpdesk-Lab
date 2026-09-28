"""Phase-2 portal invariants (unittest-compatible, stdlib only).

Runs green under BOTH ``python -m unittest`` and ``pytest`` in the gateway
venv (which has no flask/pandas). Two invariants over REAL repo code:

  * ticket-id uniqueness over 500 seeded creates via the real ``next_id``
    helper from app.py — loaded with stdlib ``importlib`` under stubbed
    ``flask``/``flask_cors`` modules (flask is absent here; the stubs only
    provide the import-time names, never HTTP behavior). Module is loaded
    under a unique name with sys.modules/env restored afterwards, so the
    flask-based suite is unaffected when run in its own venv.
  * RAG chunk overlap invariant on the import-clean ``rag/chunking.py``:
    sliding-window step == CHUNK_SIZE - CHUNK_OVERLAP, consecutive chunks
    overlap by exactly CHUNK_OVERLAP chars, and the union of chunks covers
    the full body with no gaps.

Plus a live-guard test proving ``require_live_llm`` skips (no network).
"""
import importlib.util
import os
import random
import sys
import tempfile
import types
import unittest
from pathlib import Path

PORTAL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PORTAL_DIR))

from rag.chunking import (  # noqa: E402
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    chunk_markdown,
)

from tests.live_infra import (  # noqa: E402
    LIVE_TESTS_ENABLED,
    is_http_reachable,
    require_db,
    require_live_llm,
)

SEED = 20260927


def _load_app_helpers():
    """Import app.py's pure helpers (next_id, _merge_rows) without flask.

    Returns (module, restore_fn). Restores sys.modules + env so sibling
    tests that use the real flask app are never poisoned.
    """
    saved_modules = {k: sys.modules.get(k) for k in ("flask", "flask_cors")}
    saved_env = {k: os.environ.get(k) for k in ("DATA_FILE", "PORT")}
    tmp = tempfile.TemporaryDirectory(prefix="invariants-")

    flask = types.ModuleType("flask")

    class _Flask:
        def __init__(self, *a, **k):
            import logging
            self.logger = logging.getLogger("portal-stub")

        def _decorator(self, *a, **k):
            def wrap(f):
                return f
            return wrap

        get = post = patch = _decorator

        def test_client(self):
            raise RuntimeError("stub has no HTTP client")

    flask.Flask = _Flask
    flask.jsonify = lambda *a, **k: (a, k)
    flask.request = types.SimpleNamespace(args={})

    class _Response:
        def __init__(self, *a, **k):
            pass

    flask.Response = _Response
    cors = types.ModuleType("flask_cors")
    cors.CORS = lambda *a, **k: None
    sys.modules["flask"] = flask
    sys.modules["flask_cors"] = cors
    # Point at a nonexistent file: load_db() then returns the in-memory seed
    # without reading or writing any real database.
    os.environ["DATA_FILE"] = str(Path(tmp.name) / "db.json")
    os.environ["PORT"] = "59999"

    spec = importlib.util.spec_from_file_location(
        "portal_app_invariants", str(PORTAL_DIR / "app.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["portal_app_invariants"] = mod
    spec.loader.exec_module(mod)

    def restore():
        for k, v in saved_modules.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        sys.modules.pop("portal_app_invariants", None)
        tmp.cleanup()

    return mod, restore


class TicketIdUniquenessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod, cls._restore = _load_app_helpers()

    @classmethod
    def tearDownClass(cls):
        cls._restore()

    def test_500_seeded_creates_yield_unique_increasing_ids(self):
        rng = random.Random(SEED)
        rows: list = []
        seen = set()
        next_expected = 1001  # ticket id space starts at 1001 in app.py
        for case in range(500):
            # Simulate concurrent-ish creation: random pre-existing id sets,
            # including legacy scalar rows and non-int ids the helper skips.
            if rng.random() < 0.1:
                rows.append(rng.choice(["legacy-scalar", None, {"noid": 1}]))
            new_id = self.mod.next_id(rows, start=1001)
            self.assertNotIn(new_id, seen,
                             f"case {case}: duplicate ticket id {new_id}")
            self.assertGreaterEqual(new_id, next_expected,
                                    f"case {case}: id went backwards")
            seen.add(new_id)
            next_expected = new_id + 1
            # Insert at a random position: id allocation must not depend on order.
            rows.insert(rng.randint(0, len(rows)), {"id": new_id})
        self.assertEqual(len(seen), 500, "all 500 seeded ids must be unique")
        int_ids = [r["id"] for r in rows if isinstance(r, dict) and "id" in r]
        self.assertEqual(sorted(int_ids), list(range(1001, 1501)),
                         "ids must densely cover 1001..1500 with no gaps")

    def test_next_id_ignores_non_dict_and_non_int_rows(self):
        mod = self.mod
        self.assertEqual(mod.next_id([], start=1001), 1001)
        self.assertEqual(
            mod.next_id(["scalar", None, {"noid": 1}, {"id": "x"}], start=7), 7)
        self.assertEqual(mod.next_id([{"id": 3}, {"id": 9}]), 10)


class RagChunkOverlapTest(unittest.TestCase):
    def test_sliding_window_overlap_and_full_coverage(self):
        rng = random.Random(SEED + 1)
        vocab = "khắc phục mạng máy in phần mềm sự cố kiểm tra khởi động lại".split()
        for case in range(200):
            n = rng.choice([0, 1, 50, 500, 2000, 5000])
            body = " ".join(rng.choice(vocab) for _ in range(n)).strip()
            chunks = chunk_markdown(body, f"case-{case}.md")
            if not body:
                self.assertEqual(chunks, [],
                                 f"case {case}: empty body must yield no chunks")
                continue
            self.assertTrue(chunks, f"case {case}: non-empty body lost")
            step = CHUNK_SIZE - CHUNK_OVERLAP
            self.assertEqual(step, 680, "window step must be 800-120")
            bodies = []
            for c in chunks:
                text = c["text"]
                # Strip the "[source | section]\n" prefix to get the raw slice.
                _, _, raw = text.partition("\n")
                bodies.append(raw if raw else text)
                self.assertEqual(c["source"], f"case-{case}.md",
                                 f"case {case}: chunk lost its source tag")
            # Coverage: every body char must appear in at least one chunk.
            covered = [False] * len(body)
            for start in range(0, len(body), step):
                piece = body[start:start + CHUNK_SIZE]
                idx = body.find(piece, max(0, start - CHUNK_OVERLAP))
                for i in range(idx, idx + len(piece)):
                    if 0 <= i < len(body):
                        covered[i] = True
            self.assertTrue(all(covered),
                            f"case {case}: chunk union has gaps in coverage")
            # Overlap: consecutive non-final chunks share CHUNK_OVERLAP chars.
            for i in range(len(bodies) - 1):
                if len(bodies[i]) == CHUNK_SIZE and len(body) > (i + 1) * step + CHUNK_SIZE:
                    self.assertEqual(bodies[i][-CHUNK_OVERLAP:], bodies[i + 1][:CHUNK_OVERLAP],
                                     f"case {case}: chunks {i}/{i+1} overlap != 120 chars")

    def test_chunk_boundaries_never_emit_empty_text(self):
        chunks = chunk_markdown("## MÔ TẢ\n\nNội dung ngắn.", "s.md")
        self.assertTrue(chunks)
        for c in chunks:
            self.assertTrue(c["text"].strip(), "chunk text must be non-empty")
            self.assertIn("section", c)


class LiveGuardTest(unittest.TestCase):
    def test_require_live_llm_skips_without_env(self):
        if LIVE_TESTS_ENABLED:
            self.skipTest("LIVE_TESTS=1: live guard must attempt the probe")
        for fn in (require_live_llm, lambda: require_db("postgres")):
            with self.assertRaises((unittest.SkipTest, Exception)) as ctx:
                fn()
            self.assertIn("LIVE_TESTS", str(ctx.exception))

    def test_unreachable_probe_returns_false_fast(self):
        # 1.5s probe against a closed port must fail closed without raising.
        self.assertFalse(is_http_reachable("http://127.0.0.1:59999/health", timeout=1.5))


if __name__ == "__main__":
    unittest.main(verbosity=2)
