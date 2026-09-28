"""W6 — RAG retrieve: offline, không Qdrant thật, không re-embed mỗi call.

Test chỉ patch urllib trong process test; không gọi network thật.
"""
import sys
import unittest
from pathlib import Path

from tests.harness import PORTAL_DIR

if str(PORTAL_DIR) not in sys.path:
    sys.path.insert(0, str(PORTAL_DIR))

QUERY = "máy in offline không in được"


def _no_network(*args, **kwargs):
    raise AssertionError("RAG không được gọi network trong test offline")


class RagRetrieveTest(unittest.TestCase):
    def setUp(self):
        import urllib.request

        from rag import retrieve as retrieve_mod
        from rag import store as store_mod
        from rag import vectors as vectors_mod

        self.retrieve_mod = retrieve_mod
        self.store_mod = store_mod
        self.vectors_mod = vectors_mod
        self._urlopen = urllib.request.urlopen
        self._ollama = vectors_mod.OLLAMA_URL
        self._qdrant = store_mod.QDRANT_URL
        urllib.request.urlopen = _no_network
        vectors_mod.OLLAMA_URL = "http://127.0.0.1:1/blocked"
        store_mod.QDRANT_URL = "http://127.0.0.1:1/blocked"
        # chặn cả instance tạo trong module khác
        store_mod.urllib.request.urlopen = _no_network
        vectors_mod.urllib.request.urlopen = _no_network
        self.addCleanup(self._restore)
        # bỏ qua mọi cache đã tạo bởi test/lần chạy trước
        reset = getattr(retrieve_mod, "reset_caches", None)
        if reset:
            reset()

    def _restore(self):
        import urllib.request

        urllib.request.urlopen = self._urlopen
        self.vectors_mod.OLLAMA_URL = self._ollama
        self.store_mod.QDRANT_URL = self._qdrant

    def test_retrieve_runs_without_network_and_returns_hits(self):
        hits = self.retrieve_mod.retrieve(QUERY, top_k=3)
        self.assertIsInstance(hits, list)
        self.assertLessEqual(len(hits), 3)
        for hit in hits:
            self.assertIn("score", hit)
            self.assertTrue(hit.get("text"))

    def test_repeated_same_query_does_not_rebuild_or_reembed(self):
        import rag.ingest as ingest
        import rag.retrieve as rm

        calls = {"query_embed": 0, "corpus_embed": 0, "corpus_texts": 0}
        orig_retrieve, orig_ingest = rm.embed, ingest.embed

        def counting_retrieve_embed(texts):
            calls["query_embed"] += 1
            return orig_retrieve(texts)

        def counting_ingest_embed(texts):
            calls["corpus_embed"] += 1
            calls["corpus_texts"] += len(texts)
            return orig_ingest(texts)

        rm.embed = counting_retrieve_embed
        ingest.embed = counting_ingest_embed
        self.addCleanup(setattr, rm, "embed", orig_retrieve)
        self.addCleanup(setattr, ingest, "embed", orig_ingest)
        reset = getattr(rm, "reset_caches", None)
        if reset:
            reset()

        first = rm.retrieve(QUERY, top_k=3)
        self.assertEqual(calls["corpus_embed"], 1,
                         "index chỉ được dựng/embed đúng 1 lần")
        self.assertGreater(calls["corpus_texts"], 0)

        second = rm.retrieve(QUERY, top_k=3)
        self.assertEqual(calls["corpus_embed"], 1,
                         f"retrieve lần 2 không được re-embed corpus (calls={calls})")
        self.assertEqual(calls["query_embed"], 1,
                         f"query trùng phải cache hit, không embed lại (calls={calls})")
        self.assertEqual(first, second, "cache hit phải trả cùng kết quả")

    def test_store_is_reused_across_calls(self):
        store_a, mode_a = self.retrieve_mod._get_store_cached(384) \
            if hasattr(self.retrieve_mod, "_get_store_cached") else (None, None)
        if store_a is None:
            self.skipTest("retrieve chưa expose store cache (sẽ được thêm ở GREEN)")
        store_b, _ = self.retrieve_mod._get_store_cached(384)
        self.assertIs(store_a, store_b, "store phải được tái sử dụng, không dựng lại mỗi call")
        self.assertEqual(mode_a, "memory")

    def test_cache_key_depends_on_model_and_query(self):
        rm = self.retrieve_mod
        if not hasattr(rm, "cache_key"):
            self.skipTest("retrieve chưa expose cache_key (sẽ được thêm ở GREEN)")
        k1 = rm.cache_key("hash-tf", 384, QUERY, 3)
        k2 = rm.cache_key("hash-tf", 384, QUERY, 3)
        k3 = rm.cache_key("hash-tf", 384, QUERY, 5)
        k4 = rm.cache_key("ollama:nomic-embed-text", 384, QUERY, 3)
        k5 = rm.cache_key("hash-tf", 768, QUERY, 3)
        self.assertEqual(k1, k2)
        self.assertNotEqual(k1, k3)
        self.assertNotEqual(k1, k4)
        self.assertNotEqual(k1, k5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
