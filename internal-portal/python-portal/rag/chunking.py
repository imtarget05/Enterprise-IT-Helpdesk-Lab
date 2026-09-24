"""
Chunking cho RAG — stdlib only, không cần cài thêm gì.

Pipeline: file .md (tickets/, docs/) -> tách theo header ## -> sliding window
  chunk ~800 ký tự, overlap 120 ký tự -> {text, source, section}.

Vì sao tách theo header: mỗi ticket trong repo đã có cấu trúc chuẩn
  (MÔ TẢ / CHẨN ĐOÁN / ROOT CAUSE / KHẮC PHỤC / PHÒNG NGỪA) nên mỗi chunk
  giữ nguyên 1 bước nghiệp vụ -> retrieve trả về đúng đoạn cần thiết,
  Qwen nhỏ (0.5B) không bị nhiễu context dài.
"""
import re
from pathlib import Path

CHUNK_SIZE = 800
CHUNK_OVERLAP = 120

HEADER_RE = re.compile(r"^(#{1,3})\s+(.+)$", re.M)


def chunk_markdown(text: str, source: str) -> list:
    """Tách markdown thành các chunk kèm section header."""
    text = text.replace("\r\n", "\n").strip()
    if not text:
        return []
    # Tách theo header ## / ###, giữ header đi kèm đoạn
    parts, current_header, buf = [], "", []
    for line in text.split("\n"):
        m = HEADER_RE.match(line.strip())
        if m and len(m.group(1)) >= 2:
            if buf:
                parts.append((current_header, "\n".join(buf).strip()))
            current_header = m.group(2).strip()
            buf = []
        else:
            buf.append(line)
    if buf:
        parts.append((current_header, "\n".join(buf).strip()))

    chunks = []
    for header, body in parts:
        if not body:
            continue
        prefix = f"[{source} | {header}]\n" if header else f"[{source}]\n"
        # Sliding window trên đoạn dài
        start = 0
        while start < len(body):
            piece = body[start:start + CHUNK_SIZE]
            chunks.append({
                "text": prefix + piece,
                "source": source,
                "section": header or "general",
            })
            if start + CHUNK_SIZE >= len(body):
                break
            start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


def chunk_repo(repo_root: Path) -> list:
    """Quét tickets/*.md + docs/*.md (+ ai-playbooks) thành chunks."""
    chunks = []
    for sub in ("tickets", "docs"):
        d = repo_root / sub
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            try:
                text = f.read_text(encoding="utf-8")
            except OSError:
                continue
            chunks.extend(chunk_markdown(text, f"{sub}/{f.name}"))
    # Thêm playbook rule-based (src/ai-playbooks.js) nếu có
    pb = repo_root / "internal-portal" / "src" / "ai-playbooks.js"
    if pb.exists():
        try:
            raw = pb.read_text(encoding="utf-8")
            summaries = re.findall(r'summary:\s*[\'"`]([^\'"`]+)[\'"`]', raw)
            for i, s in enumerate(summaries):
                chunks.append({
                    "text": f"[playbook/{i}] {s.strip()}",
                    "source": "src/ai-playbooks.js",
                    "section": "playbook",
                })
        except OSError:
            pass
    return chunks
