"""
Retrieve — truy vấn tri thức doanh nghiệp cho 1 ticket.

  query = title + category + description -> embed -> Qdrant top_k=3
  -> list {text, source, section, score} để:
    1. Ghép vào prompt Qwen (grounding, chống bịa),
    2. Trả kèm trong API response để UI hiển thị "Nguồn tham khảo".

Chạy độc lập: python -m rag.retrieve "máy in offline"
"""
import hashlib
import sys
import threading
from collections import OrderedDict
from pathlib import Path

from .vectors import embed
from .store import get_store

TOP_K = 3
# Giới hạn cache để process dài hạn (dev server) không phình bộ nhớ.
CACHE_MAX = 128

# (backend, dim, corpus_fingerprint) -> (store, mode)
# Dựng index MỘT LẦN; corpus đổi (thêm/sửa runbook) -> fingerprint đổi -> dựng
# lại, thay vì trả kết quả cũ tới hết đời process.
_STORE_CACHE: dict = {}
# OrderedDict LRU: cache_key -> hits
_QUERY_CACHE: OrderedDict = OrderedDict()
# Backend/dim của lần embed thật gần nhất, dùng để tra cache khi query trùng
# mà không cần embed lại (deterministic cùng model).
_ACTIVE: dict = {"backend": None, "dim": None}
# Khoá RIÊNG cho cache RAG: đã tách khỏi lock DB của Flask, và bảo vệ cache khi
# nhiều request AI gọi retrieve() song song (dùng chung store, không dựng bản
# riêng cho từng thread).
_CACHE_LOCK = threading.RLock()


def corpus_fingerprint(repo_root=None) -> str:
    """Fingerprint corpus (đường dẫn + mtime_ns + size) để invalidate index cache.

    Chỉ đọc metadata, không nạp nội dung file; theo đúng nguồn mà
    `rag.chunking.chunk_repo` quét: tickets/*.md, docs/*.md, src/ai-playbooks.js.
    """
    if repo_root is None:
        from .ingest import REPO_ROOT as repo_root
    root = Path(repo_root)
    parts = []
    for target in (sorted((root / "tickets").glob("*.md")) if (root / "tickets").is_dir() else [],
                   sorted((root / "docs").glob("*.md")) if (root / "docs").is_dir() else [],
                   [root / "internal-portal" / "src" / "ai-playbooks.js"]):
        for f in target:
            try:
                st = f.stat()
                parts.append(f"{f}:{st.st_mtime_ns}:{st.st_size}")
            except OSError:
                continue
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


def cache_key(backend: str, dim: int, query: str, top_k: int = TOP_K) -> tuple:
    """Fingerprint model + query: khác backend/dim/top_k/text là khác cache."""
    normalized = " ".join(str(query).split()).lower()
    return (str(backend), int(dim), int(top_k), normalized)


def _cache_get(key):
    with _CACHE_LOCK:
        if key in _QUERY_CACHE:
            _QUERY_CACHE.move_to_end(key)  # chạm = còn mới nhất (LRU)
            return _QUERY_CACHE[key]
    return None


def _cache_put(key, hits) -> None:
    with _CACHE_LOCK:
        _QUERY_CACHE[key] = hits
        _QUERY_CACHE.move_to_end(key)
        while len(_QUERY_CACHE) > CACHE_MAX:  # evict LRU, không clear() toàn bộ
            _QUERY_CACHE.popitem(last=False)


def reset_caches() -> None:
    with _CACHE_LOCK:
        _STORE_CACHE.clear()
        _QUERY_CACHE.clear()
        _ACTIVE["backend"] = None
        _ACTIVE["dim"] = None


def _get_store_cached(dim: int, backend: str = "hash-tf", fingerprint: str = ""):
    key = (str(backend), int(dim), str(fingerprint))
    with _CACHE_LOCK:
        cached = _STORE_CACHE.get(key)
    if cached is not None:
        return cached
    # Dựng index ngoài lock (ping Qdrant/embed corpus có thể chậm).
    store, mode = get_store(dim=dim)
    if store.count() == 0:
        # Chưa ingest -> nạp nhanh từ manifest/in-memory (không crash demo)
        from .ingest import build_index
        store, _info = build_index(store)
    with _CACHE_LOCK:
        # Double-check: thread khác có thể đã dựng xong -> dùng chung bản đó,
        # không tạo nhiều store cho cùng một corpus fingerprint.
        existing = _STORE_CACHE.get(key)
        if existing is not None:
            return existing
        _STORE_CACHE[key] = (store, mode)
    return store, mode


def retrieve(query: str, top_k: int = TOP_K) -> list:
    """Top-k chunk cho 1 query. Trả về BẢN SAO để caller không nhiễm cache."""
    fingerprint = corpus_fingerprint()

    # 1) Query trùng với lần gần nhất + cùng model/dim/top_k -> cache hit,
    #    không embed lại, không dựng lại index.
    with _CACHE_LOCK:
        active_backend, active_dim = _ACTIVE["backend"], _ACTIVE["dim"]
    if active_backend is not None:
        key = cache_key(active_backend, active_dim, query, top_k)
        cached = _cache_get(key)
        if cached is not None:
            return [dict(h) for h in cached]

    # 2) Embed query (backend = 'ollama:<model>' hoặc 'hash-tf').
    vecs, backend = embed([query])
    dim = len(vecs[0])
    with _CACHE_LOCK:
        _ACTIVE["backend"], _ACTIVE["dim"] = backend, dim
    key = cache_key(backend, dim, query, top_k)
    cached = _cache_get(key)
    if cached is not None:
        return [dict(h) for h in cached]

    store, _mode = _get_store_cached(dim, backend, fingerprint)
    if store.count() == 0:
        return []
    hits = store.search(vecs[0], top_k=top_k)
    _cache_put(key, [dict(h) for h in hits])
    return [dict(h) for h in hits]


def format_context(hits: list) -> str:
    if not hits:
        return ""
    lines = ["KIẾN THỨC NỘI BỘ (trích runbook công ty, ưu tiên cao hơn kiến thức chung):"]
    for i, h in enumerate(hits, 1):
        lines.append(f"[{i}] ({h.get('source','?')} | {h.get('section','')}) {h.get('text','')[:600]}")
    return "\n".join(lines)


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "cannot access internet APIPA"
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    hits = retrieve(q)
    print(f"query: {q}\n{'-' * 60}")
    for h in hits:
        print(f"score={h.get('score')} source={h.get('source')} section={h.get('section')}")
        print(h.get("text", "")[:300], "\n")
