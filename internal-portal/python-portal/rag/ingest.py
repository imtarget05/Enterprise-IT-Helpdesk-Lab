"""
Ingest — nạp tri thức doanh nghiệp vào Qdrant (chạy 1 lần, chạy lại khi
runbook đổi).

  python -m rag.ingest            # tự chọn qdrant hoặc memory
  python -m rag.ingest --memory   # ép in-memory (máy yếu / CI)
  python -m rag.ingest --check    # chỉ đếm chunk, không upsert

Pipeline: tickets/*.md + docs/*.md -> chunking -> embed (ollama hoặc
hash-tf offline) -> upsert Qdrant -> manifest.json (dim, backend, count).
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

from .chunking import chunk_repo
from .vectors import embed
from .store import get_store, InMemoryStore

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent  # PORTFOLIO/05-.../
MANIFEST = Path(__file__).resolve().parent / "manifest.json"


def build_index(store=None):
    chunks = chunk_repo(REPO_ROOT)
    if not chunks:
        return (store or InMemoryStore()), {"count": 0}
    texts = [c["text"] for c in chunks]
    vecs, backend = embed(texts)
    dim = len(vecs[0])
    if store is None:
        store, mode = get_store(dim=dim)
    else:
        mode = "memory" if isinstance(store, InMemoryStore) else "qdrant"
    if isinstance(store, InMemoryStore):
        store.upsert(list(range(len(chunks))), vecs,
                     [{"text": c["text"], "source": c["source"], "section": c["section"]} for c in chunks])
    else:
        store.dim = dim
        store.ensure_collection()
        ids = [int(hashlib.md5(f"{c['source']}#{i}".encode()).hexdigest()[:8], 16)
               for i, c in enumerate(chunks)]
        store.upsert(ids, vecs,
                     [{"text": c["text"], "source": c["source"], "section": c["section"]} for c in chunks])
    info = {"count": len(chunks), "dim": dim, "backend": backend,
            "mode": mode, "at": time.strftime("%Y-%m-%d %H:%M")}
    return store, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--memory", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        chunks = chunk_repo(REPO_ROOT)
        print(f"chunks: {len(chunks)} từ {REPO_ROOT}")
        for c in chunks[:3]:
            print(f" - [{c['source']} | {c['section']}] {c['text'][:100]}...")
        return

    store = InMemoryStore() if args.memory else None
    store, info = build_index(store)
    try:
        MANIFEST.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    print(json.dumps(info, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    main()
