"""
Retrieve — truy vấn tri thức doanh nghiệp cho 1 ticket.

  query = title + category + description -> embed -> Qdrant top_k=3
  -> list {text, source, section, score} để:
    1. Ghép vào prompt Qwen (grounding, chống bịa),
    2. Trả kèm trong API response để UI hiển thị "Nguồn tham khảo".

Chạy độc lập: python -m rag.retrieve "máy in offline"
"""
import sys
from pathlib import Path

from .vectors import embed
from .store import get_store

TOP_K = 3


def retrieve(query: str, top_k: int = TOP_K) -> list:
    (vecs, _backend) = embed([query])
    store, _mode = get_store(dim=len(vecs[0]))
    if store.count() == 0:
        # Chưa ingest -> nạp nhanh từ manifest/in-memory (không crash demo)
        from .ingest import build_index
        store, _ = build_index(store)
    if store.count() == 0:
        return []
    return store.search(vecs[0], top_k=top_k)


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
