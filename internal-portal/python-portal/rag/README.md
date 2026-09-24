# RAG Pipeline — Qdrant + Qwen local

```text
tickets/*.md + docs/*.md
        │ ingest (python -m rag.ingest)
        ▼
chunking (header ##, 800 chars/overlap 120)
        │ embed (ollama nomic-embed-text → fallback hash-TF offline)
        ▼
Qdrant [it_helpdesk_runbooks] ──không có──▶ InMemory (cosine RAM)
        │ retrieve top-3 (query = title+category+description)
        ▼
Qwen 0.5B (Ollama) + KIẾN THỨC NỘI BỘ → JSON {summary, diagnosis, rca, prevention}
        │ Ollama chưa chạy
        ▼
rag-rule (playbook + sources RAG) → luôn HTTP 200
```

## Chạy

```bash
# 1. (tùy chọn, máy khỏe) Qdrant thật:
docker run -d -p 6333:6333 qdrant/qdrant

# 2. Nạp tri thức (lần đầu + mỗi khi sửa runbook):
python3 -m rag.ingest            # tự chọn qdrant/memory
python3 -m rag.ingest --check    # chỉ đếm chunk

# 3. Thử retrieve:
python3 -m rag.retrieve "máy in offline"

# 4. (tùy chọn) Ollama để sinh ngữ nghĩa thật:
ollama pull qwen2.5:0.5b && ollama pull nomic-embed-text && ollama serve
```
