"""
Qdrant store qua REST (urllib, không cần qdrant-client) + fallback InMemory.

  - Có Qdrant (docker run -p 6333:6333 qdrant/qdrant) -> collection thật
    `it_helpdesk_runbooks`, search ANN của Qdrant.
  - Không có Qdrant -> InMemoryStore (cosine brute-force trên RAM).
    API giống hệt nhau nên ingest.py / retrieve.py không đổi code,
    demo trên máy yếu vẫn chạy.

Collection schema:
  vectors: { size: <dim>, distance: Cosine }
  payload: { text, source, section }
"""
import json
import os
import urllib.request

from .vectors import cosine

QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333").rstrip("/")
COLLECTION = os.environ.get("QDRANT_COLLECTION", "it_helpdesk_runbooks")


def _req(method: str, path: str, body: dict = None, timeout: int = 10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        QDRANT_URL + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode() or "{}")


class QdrantStore:
    """Wrapper REST tối thiểu: ensure_collection / upsert / search."""

    def __init__(self, collection: str = COLLECTION, dim: int = 384):
        self.collection = collection
        self.dim = dim
        self.available = self._ping()

    def _ping(self) -> bool:
        try:
            _req("GET", "/", timeout=3)
            return True
        except Exception:
            return False

    def ensure_collection(self):
        try:
            info = _req("GET", f"/collections/{self.collection}")
            existing = ((info.get("result") or {}).get("config") or {}).get("params", {})
            if ((existing.get("vectors") or {}).get("size") == self.dim):
                return
            _req("DELETE", f"/collections/{self.collection}")
        except Exception:
            pass  # chưa có collection -> tạo mới
        _req("PUT", f"/collections/{self.collection}", {
            "vectors": {"size": self.dim, "distance": "Cosine"}})

    def upsert(self, ids: list, vectors: list, payloads: list):
        points = [{"id": i, "vector": v, "payload": p}
                  for i, v, p in zip(ids, vectors, payloads)]
        for s in range(0, len(points), 64):  # batch 64 để nhẹ RAM
            _req("PUT", f"/collections/{self.collection}/points?wait=true",
                 {"points": points[s:s + 64]})

    def search(self, vector: list, top_k: int = 3) -> list:
        res = _req("POST", f"/collections/{self.collection}/points/search", {
            "vector": vector, "limit": top_k, "with_payload": True})
        return [{"score": p.get("score", 0.0),
                 **(p.get("payload") or {})} for p in res.get("result", [])]

    def count(self) -> int:
        try:
            res = _req("GET", f"/collections/{self.collection}")
            return (res.get("result") or {}).get("points_count", -1)
        except Exception:
            return -1


class InMemoryStore:
    """Fallback RAM: cùng interface upsert/search/count."""

    def __init__(self):
        self.vecs, self.payloads = [], []
        self.available = True

    def ensure_collection(self):
        pass

    def upsert(self, ids, vectors, payloads):
        self.vecs.extend(vectors)
        self.payloads.extend(payloads)

    def search(self, vector, top_k: int = 3) -> list:
        scored = sorted(
            ((cosine(vector, v), p) for v, p in zip(self.vecs, self.payloads)),
            key=lambda x: x[0], reverse=True)[:top_k]
        return [{"score": round(s, 4), **p} for s, p in scored]

    def count(self):
        return len(self.vecs)


def get_store(dim: int = 384):
    q = QdrantStore(dim=dim)
    if q.available:
        return q, "qdrant"
    return InMemoryStore(), "memory"
