"""
Embeddings — 2 tầng, stdlib + urllib, không cần torch/fastembed:

  1. Ollama /api/embeddings (model nomic-embed-text, ~274MB, chạy CPU tốt).
     Có Ollama -> vector ngữ nghĩa thật, Qdrant search chuẩn.
  2. Fallback hash-TF (deterministic, 384 dim, L2-normalized).
     Không Ollama / không mạng -> pipeline ingest + retrieve vẫn chạy,
     demo + CI không bao giờ gãy. Cosine similarity vẫn phân biệt được
     từ khóa chuyên môn (DHCP/APIPA/DNS/AD/GPO...) vì cùng từ -> cùng bucket.

DIM = 384 để tương thích cả 2 tầng (nomic-embed-text là 768 nhưng ta
  chuẩn hoá về cùng DIM cho collection Qdrant duy nhất; khi Ollama có mặt,
  ingest.py sẽ dùng DIM của model thật — xem ingest.py).
"""
import hashlib
import json
import math
import os
import re
import urllib.request
from typing import List, Optional, Tuple

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
HASH_DIM = 384
TOKEN_RE = re.compile(r"[a-z0-9À-ỹ]+", re.I)


def _l2norm(vec: list) -> list:
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


def hash_embed(text: str, dim: int = HASH_DIM) -> list:
    """Bag-of-words băm vào `dim` bucket, L2-norm. Deterministic 100%."""
    vec = [0.0] * dim
    for tok in TOKEN_RE.findall(text.lower()):
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        vec[h % dim] += 1.0
        # bigram nhẹ để giữ thứ tự từ ("ip conflict" khác "conflict ip" ít hơn)
        vec[(h // 7) % dim] += 0.15
    return _l2norm(vec)


def ollama_embed(texts: list, timeout: int = 15) -> Optional[list]:
    """Trả về list vectors hoặc None nếu Ollama chưa chạy."""
    try:
        out = []
        for t in texts:
            payload = json.dumps({"model": EMBED_MODEL, "prompt": t[:2000]}).encode()
            req = urllib.request.Request(
                f"{OLLAMA_URL}/api/embeddings", data=payload,
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as res:
                data = json.loads(res.read().decode())
            vec = data.get("embedding")
            if not vec:
                return None
            out.append(_l2norm(list(vec)))
        return out
    except Exception:
        return None


def embed(texts: list) -> Tuple[list, str]:
    """(vectors, backend) — backend là 'ollama:<model>' hoặc 'hash-tf'."""
    vecs = ollama_embed(texts)
    if vecs is not None:
        return vecs, f"ollama:{EMBED_MODEL}"
    return [_l2norm(hash_embed(t)) for t in texts], "hash-tf"


def cosine(a: list, b: list) -> float:
    return sum(x * y for x, y in zip(a, b))  # đã L2-norm -> cosine = dot
