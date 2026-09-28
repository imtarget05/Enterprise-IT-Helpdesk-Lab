"""W6 fix round 1 — RAG cache policy: corpus fingerprint + LRU + trả bản sao.

Không network, không Qdrant thật (giống test_rag_retrieve_cache).
"""
import sys
import unittest
import urllib.request

from tests.harness import PORTAL_DIR

if str(PORTAL_DIR) not in sys.path:
    sys.path.insert(0, str(PORTAL_DIR))


def _no_network(*args, **kwargs):
    raise AssertionError("RAG không được gọi network trong test offline")


class RagCachePolicyTest(unittest.TestCase):
    def setUp(self):
        import rag.ingest as ingest
        import rag.retrieve as rm
        import rag.store as sm
        import rag.vectors as vm

        self.rm, self.ingest, self.sm, self.vm = rm, ingest, sm, vm
        real_urlopen = urllib.request.urlopen
        urllib.request.urlopen = _no_network
        vm.OLLAMA_URL = "http://127.0.0.1:1/blocked"
        sm.QDRANT_URL = "http://127.0.0.1:1/blocked"
        self.addCleanup(setattr, urllib.request, "urlopen", real_urlopen)
        self._real_chunk_repo = ingest.chunk_repo
        reset = getattr(rm, "reset_caches", None)
        if reset:
            reset()
            self.addCleanup(reset)

    def test_corpus_fingerprint_changes_when_corpus_changes(self):
        """Fingerprint đọc metadata thật (path + mtime + size) trên corpus tạm —
        không sửa file nào trong repo."""
        import tempfile
        from pathlib import Path

        rm = self.rm
        if not hasattr(rm, "corpus_fingerprint"):
            self.skipTest("retrieve chưa expose corpus_fingerprint")
        with tempfile.TemporaryDirectory(prefix="w6-corpus-") as tmp:
            root = Path(tmp)
            (root / "tickets").mkdir()
            (root / "docs").mkdir()
            (root / "tickets" / "a.md").write_text("## A\nabc", encoding="utf-8")
            (root / "docs" / "b.md").write_text("## B\ndef", encoding="utf-8")
            first = rm.corpus_fingerprint(root)
            self.assertTrue(first)

            (root / "tickets" / "c.md").write_text("## C\nghi", encoding="utf-8")
            second = rm.corpus_fingerprint(root)
            self.assertNotEqual(first, second, "thêm runbook -> fingerprint phải đổi")

            (root / "tickets" / "c.md").unlink()
            self.assertEqual(rm.corpus_fingerprint(root), first,
                             "bỏ runbook -> fingerprint về đúng trạng thái cũ")

    def test_store_cache_keyed_by_corpus_fingerprint_rebuilds_index(self):
        rm = self.rm
        if "fingerprint" not in getattr(rm, "_get_store_cached").__code__.co_varnames:
            self.skipTest("_get_store_cached chưa nhận fingerprint")
        store_a, mode_a = rm._get_store_cached(384, "hash-tf", "fp-a")
        self.assertEqual(mode_a, "memory")
        self.assertGreater(store_a.count(), 0)

        store_a2, _ = rm._get_store_cached(384, "hash-tf", "fp-a")
        self.assertIs(store_a, store_a2, "cùng fingerprint -> tái dùng store")

        store_b, _ = rm._get_store_cached(384, "hash-tf", "fp-b")
        self.assertIsNot(store_a, store_b, "corpus đổi -> không dùng lại store cũ")

    def test_retrieve_rebuilds_index_when_fingerprint_changes(self):
        """End-to-end: đổi fingerprint (tức corpus đổi) -> phải dựng lại index,
        tức embed corpus chạy lại đúng một lần cho fingerprint mới."""
        import rag.ingest as ingest

        rm = self.rm
        rm.reset_caches()
        calls = {"corpus": 0}
        original = ingest.embed
        ingest.embed = lambda texts: (calls.__setitem__(
            "corpus", calls["corpus"] + 1) or original(texts))
        self.addCleanup(setattr, ingest, "embed", original)

        real_fp = rm.corpus_fingerprint
        state = {"fp": "fp-1"}
        rm.corpus_fingerprint = lambda repo_root=None: state["fp"]
        self.addCleanup(setattr, rm, "corpus_fingerprint", real_fp)

        rm.retrieve("fingerprint query A", top_k=2)
        self.assertEqual(calls["corpus"], 1)
        rm.retrieve("fingerprint query A", top_k=2)  # cache hit, không dựng lại
        self.assertEqual(calls["corpus"], 1)

        state["fp"] = "fp-2"  # corpus đổi
        rm.retrieve("fingerprint query B", top_k=2)
        self.assertEqual(calls["corpus"], 2, "corpus đổi -> dựng lại index đúng 1 lần")
        rm.retrieve("fingerprint query B", top_k=2)
        self.assertEqual(calls["corpus"], 2, "sau khi dựng lại thì cache trả kết quả")

    def test_query_cache_evicts_lru_instead_of_clearing_all(self):
        rm = self.rm
        if not hasattr(rm, "_QUERY_CACHE"):
            self.skipTest("chưa có _QUERY_CACHE")
        original_max = rm.CACHE_MAX
        rm.CACHE_MAX = 3
        self.addCleanup(setattr, rm, "CACHE_MAX", original_max)
        rm.reset_caches()

        for i in range(5):
            rm.retrieve(f"query lru {i}", top_k=1)
        self.assertLessEqual(len(rm._QUERY_CACHE), 3,
                             f"cache phải giới hạn theo LRU: {len(rm._QUERY_CACHE)}")
        self.assertGreater(len(rm._QUERY_CACHE), 0,
                           "không được clear() toàn bộ khi vượt CACHE_MAX")
        keys = list(rm._QUERY_CACHE)
        self.assertIn(rm.cache_key("hash-tf", 384, "query lru 4", 1), keys,
                      "entry mới nhất phải còn trong cache")
        self.assertNotIn(rm.cache_key("hash-tf", 384, "query lru 0", 1), keys,
                         "entry cũ nhất phải bị evict (LRU), không phải clear-all")

    def test_retrieve_returns_copies_not_cached_objects(self):
        rm = self.rm
        rm.reset_caches()
        first = rm.retrieve("copy check query", top_k=3)
        self.assertTrue(first)
        first.append({"score": -1, "text": "caller mutation"})
        first[0]["text"] = "MUTATED-BY-CALLER"
        second = rm.retrieve("copy check query", top_k=3)
        self.assertNotIn({"score": -1, "text": "caller mutation"}, second)
        self.assertNotEqual(second[0].get("text"), "MUTATED-BY-CALLER",
                            "caller mutate không được ảnh hưởng cache")
        self.assertIsNot(first, second, "phải trả list mới, không trả object trong cache")

    def test_cached_query_hit_also_returns_copy(self):
        rm = self.rm
        rm.reset_caches()
        rm.retrieve("hit copy", top_k=2)
        a = rm.retrieve("hit copy", top_k=2)
        b = rm.retrieve("hit copy", top_k=2)
        self.assertIsNot(a, b)
        a.clear()
        self.assertTrue(rm.retrieve("hit copy", top_k=2), "cache hit sau khi caller clear list")


if __name__ == "__main__":
    unittest.main(verbosity=2)
