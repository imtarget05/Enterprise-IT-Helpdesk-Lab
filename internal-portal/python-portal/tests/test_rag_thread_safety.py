"""W6 fix round 4 — cache RAG an toàn khi nhiều thread gọi đồng thời.

Không network: `urlopen` bị chặn, Qdrant/Ollama trỏ 127.0.0.1:1 (fallback hash-TF).
"""
import sys
import threading
import unittest
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from tests.harness import PORTAL_DIR

if str(PORTAL_DIR) not in sys.path:
    sys.path.insert(0, str(PORTAL_DIR))


def _no_network(*args, **kwargs):
    raise AssertionError("RAG không được gọi network trong test offline")


class RagThreadSafetyTest(unittest.TestCase):
    def setUp(self):
        import rag.retrieve as rm
        import rag.store as sm
        import rag.vectors as vm

        self.rm = rm
        real_urlopen = urllib.request.urlopen
        urllib.request.urlopen = _no_network
        vm.OLLAMA_URL = "http://127.0.0.1:1/blocked"
        sm.QDRANT_URL = "http://127.0.0.1:1/blocked"
        self.addCleanup(setattr, urllib.request, "urlopen", real_urlopen)
        rm.reset_caches()
        self.addCleanup(rm.reset_caches)

    def test_concurrent_retrieve_is_consistent_and_bounded(self):
        rm = self.rm
        queries = [f"query an toan {i}" for i in range(12)]
        barrier = threading.Barrier(6)
        results = {}
        errors = []

        def worker(i):
            barrier.wait(timeout=30)
            out = []
            for q in queries:
                out.append(rm.retrieve(q, top_k=2))
            results[i] = out

        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = [pool.submit(worker, i) for i in range(6)]
            for f in futures:
                try:
                    f.result()
                except Exception as exc:  # noqa: BLE001 - ghi lại để assert
                    errors.append(repr(exc))
        self.assertEqual(errors, [], f"retrieve đồng thời ném lỗi: {errors[:3]}")
        for i, out in results.items():
            for q, hits in zip(queries, out):
                self.assertIsInstance(hits, list)
                self.assertLessEqual(len(hits), 2)
        self.assertLessEqual(len(rm._QUERY_CACHE), rm.CACHE_MAX,
                             "cache phải giữ đúng giới hạn LRU")
        self.assertGreater(len(rm._QUERY_CACHE), 0)

    def test_same_query_from_many_threads_returns_equal_results(self):
        rm = self.rm
        barrier = threading.Barrier(8)
        outputs = []

        def worker(_i):
            barrier.wait(timeout=30)
            outputs.append(rm.retrieve("cùng một câu hỏi", top_k=3))

        with ThreadPoolExecutor(max_workers=8) as pool:
            for f in [pool.submit(worker, i) for i in range(8)]:
                f.result()
        first = outputs[0]
        self.assertTrue(first, "phải có kết quả")
        for out in outputs[1:]:
            self.assertEqual([h.get("text") for h in out], [h.get("text") for h in first],
                             "cùng query phải trả cùng kết quả dù chạy song song")

    def test_store_cache_has_single_instance_under_concurrency(self):
        rm = self.rm
        barrier = threading.Barrier(6)
        stores = []

        def worker(i):
            barrier.wait(timeout=30)
            stores.append(rm._get_store_cached(384, "hash-tf", "fp-shared"))

        with ThreadPoolExecutor(max_workers=6) as pool:
            for f in [pool.submit(worker, i) for i in range(6)]:
                f.result()
        self.assertEqual(len({id(s) for s, _ in stores}), 1,
                         "phải dùng chung MỘT store instance (không dựng 6 bản)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
