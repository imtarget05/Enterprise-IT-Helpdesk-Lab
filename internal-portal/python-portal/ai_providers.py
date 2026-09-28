"""
AI Assistant — 3 tầng engine (fail-soft, luôn HTTP 200 khi input hợp lệ):

  1. OpenAI cloud (OPENAI_API_KEY) — gpt-4o-mini, response JSON.
  2. LLM LOCAL: Ollama (mặc định) hoặc endpoint OpenAI-compatible trên LAN
     (LM Studio / llm-gateway) khi LLM_PROVIDER=lmstudio — không tốn phí.
  3. Playbook rule-based + RAG Qdrant — offline vẫn chạy.

KEY BẢO MẬT: chỉ đọc từ biến môi trường OPENAI_API_KEY (.env, gitignored),
KHÔNG hardcode, KHÔNG log, KHÔNG trả về client.
"""
import json
import os
import re
import urllib.request
import urllib.error
from datetime import datetime

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:0.5b")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT_MS", "20000")) // 1000 or 20

# Local LAN provider: "ollama" (mặc định) hoặc "lmstudio" (OpenAI-compatible).
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "ollama").strip().lower()
LMSTUDIO_URL = os.environ.get("LMSTUDIO_URL", "http://192.168.1.8:1234/v1").rstrip("/")
LMSTUDIO_MODEL = os.environ.get("LMSTUDIO_MODEL", "qwen2.5-vl-3b-instruct")
USE_LMSTUDIO = LLM_PROVIDER in ("lmstudio", "local_openai", "lms")


def _openai_key() -> str:
    return (os.environ.get("OPENAI_API_KEY") or "").strip()

SYSTEM_PROMPT = (
    "Bạn là kỹ thuật viên Helpdesk level 2 (chuẩn ITIL). "
    "ƯU TIÊN trả lời dựa trên phần KIẾN THỨC NỘI BỘ (runbook công ty) nếu có. "
    "Phân tích ticket và TRẢ VỀ DUY NHẤT object JSON hợp lệ, không markdown, gồm: "
    '"summary" (1-2 câu tiếng Việt), '
    '"diagnosis" (mảng 4-5 bước chẩn đoán cụ thể kèm lệnh), '
    '"rca" (nguyên nhân gốc), '
    '"prevention" (mảng 3 biện pháp phòng ngừa).'
)


def _rag_context(ticket: dict) -> tuple[str, list]:
    """Lấy context RAG (Qdrant) — lỗi thì trả rỗng, không bao giờ crash AI."""
    try:
        from rag.retrieve import retrieve, format_context
        q = " ".join(str(ticket.get(k, "")) for k in ("title", "category", "description"))
        hits = retrieve(q, top_k=3)
        return format_context(hits), hits
    except Exception:
        return "", []

PLAYBOOKS = [
    ("Network — APIPA / DHCP",
     re.compile(r"apipa|169\.254|dhcp|không có mạng|no internet", re.I),
     "Máy không nhận IP từ DHCP (dấu hiệu APIPA 169.254.x.x).",
     ["ipconfig /all — kiểm tra dải 169.254.x.x",
      "ipconfig /release && ipconfig /renew — xin lại IP",
      "Ping gateway — kiểm tra switch/cáp LAN",
      "Kiểm tra DHCP Server scope còn lease không",
      "Thử static IP cùng dải để khoanh vùng lỗi"],
     "DHCP dừng/scope hết lease hoặc lỗi switch/cáp.",
     ["Giám sát DHCP scope usage", "Bật DHCP failover", "Test port khi thay switch"]),
    ("Network — DNS",
     re.compile(r"dns|phân giải|domain", re.I),
     "Không phân giải tên miền — nghi lỗi DNS.",
     ["nslookup google.com — kiểm tra DNS phản hồi",
      "ipconfig /all — xác nhận DNS client",
      "ping bằng IP trực tiếp — phân biệt DNS vs routing",
      "Kiểm tra Forwarders trên DNS Server",
      "Restart dịch vụ DNS nếu NXDOMAIN tràn lan"],
     "DNS dừng/forwarders sai hoặc client trỏ sai server.",
     ["Đặt 2 DNS qua DHCP option 6", "Monitor nslookup định kỳ", "Ghi changelog DNS"]),
    ("Active Directory — lockout",
     re.compile(r"mật khẩu|password|khóa tài khoản|lockout|đăng nhập|login", re.I),
     "Lỗi đăng nhập AD — sai pass hoặc bị lockout.",
     ["ADUC — kiểm tra Lockout/Disabled",
      "Event Viewer 4740 — tìm nguồn gửi sai pass",
      "Kiểm tra app lưu pass cũ (mail/mapped drive)",
      "Unlock + yêu cầu đổi pass theo policy",
      "Kiểm tra GPO Password Policy"],
     "Pass cũ lưu ở thiết bị khác gửi sai liên tục → DC lock account.",
     ["Rotate credential khi đổi pass", "Theo dõi Event 4740", "Không lưu pass máy chung"]),
    ("Máy in / File share",
     re.compile(r"máy in|printer|share|ntfs|access denied|file server", re.I),
     "Lỗi máy in hoặc quyền share/NTFS.",
     ["Kiểm tra printer Offline/Paused, clear queue",
      "ping IP máy in — kiểm tra kết nối",
      "Kiểm tra Share vs NTFS permission",
      "Xác nhận user thuộc group được cấp quyền",
      "In test từ server để khoanh vùng"],
     "Queue treo/driver sai hoặc xung đột Share vs NTFS.",
     ["DHCP reservation cho máy in", "Deploy printer qua GPO", "Cấp quyền theo group"]),
]

DEFAULT_PB = ("General IT", None,
              "Sự cố IT cần phân loại thêm — áp dụng quy trình Helpdesk chuẩn.",
              ["Xác nhận triệu chứng với người báo",
               "Thu thập ipconfig /all, ảnh lỗi",
               "Kiểm tra sự cố đồng loạt không",
               "Thử tái hiện trên máy khác",
               "Update ticket theo SLA"],
              "Chưa đủ dữ liệu kết luận root cause.",
              ["Ghi runbook sau xử lý", "Bổ sung vào kho ticket"])


def _pick(ticket: dict):
    hay = " ".join(str(ticket.get(k, "")) for k in ("title", "category", "description"))
    for pb in PLAYBOOKS:
        if pb[1].search(hay):
            return pb
    return DEFAULT_PB


def rule_based(ticket: dict) -> dict:
    name, _, summary, diagnosis, rca, prevention = _pick(ticket)
    return {
        "engine": "rule-based", "model": None, "playbook": name,
        "summary": summary, "diagnosis": list(diagnosis),
        "rca": rca, "prevention": list(prevention),
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }


def _parse_llm_json(content: str) -> dict:
    try:
        obj = json.loads(content)
    except json.JSONDecodeError:
        s, e = content.find("{"), content.rfind("}")
        obj = json.loads(content[s:e + 1])
    if not obj.get("summary"):
        raise ValueError("LLM thiếu trường summary")
    norm = lambda v: [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else ([str(v).strip()] if str(v).strip() else [])
    return {
        "summary": str(obj.get("summary", "")).strip(),
        "diagnosis": norm(obj.get("diagnosis", [])),
        "rca": str(obj.get("rca", "")).strip(),
        "prevention": norm(obj.get("prevention", [])),
    }


def _build_user(ticket: dict, ctx: str) -> str:
    user_parts = filter(None, [
        f"Ticket: {ticket.get('title', '')}",
        f"Phòng ban: {ticket.get('dept', 'N/A')} — Người báo: {ticket.get('requester', 'N/A')}",
        f"Priority: {ticket.get('priority', 'Medium')} — Category: {ticket.get('category', 'General')}",
        f"Mô tả: {ticket.get('description', '')}" if ticket.get("description") else "",
    ])
    return "\n".join(user_parts) + (f"\n\n{ctx}" if ctx else "")


def _openai_chat(user: str, timeout: int = TIMEOUT) -> dict:
    payload = json.dumps({
        "model": OPENAI_MODEL, "temperature": 0.2, "max_tokens": 800,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT + " Trả lời bằng tiếng Việt."},
            {"role": "user", "content": user},
        ],
    }).encode()
    req = urllib.request.Request(
        OPENAI_CHAT_URL, data=payload, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {_openai_key()}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError("OpenAI key không hợp lệ (401)")
        if e.code == 429:
            raise ValueError("OpenAI hết quota/rate-limit (429)")
        raise ValueError(f"OpenAI HTTP {e.code}")
    choices = data.get("choices") or []
    content = (choices[0].get("message") or {}).get("content", "") if choices else ""
    if not content:
        raise ValueError("OpenAI trả về message rỗng")
    return _parse_llm_json(content)


def _ollama_chat(ticket: dict, timeout: int = TIMEOUT) -> dict:
    ctx, hits = _rag_context(ticket)
    _ollama_chat.last_hits = hits
    user = _build_user(ticket, ctx)
    payload = json.dumps({
        "model": OLLAMA_MODEL, "stream": False, "format": "json",
        "options": {"temperature": 0.2, "num_predict": 450},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
    }).encode()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat", data=payload,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        data = json.loads(res.read().decode())
    content = (data.get("message") or {}).get("content", "")
    return _parse_llm_json(content)


def _lmstudio_chat(ticket: dict, timeout: int = TIMEOUT) -> dict:
    """LLM local qua endpoint OpenAI-compatible (LM Studio / llm-gateway)."""
    ctx, hits = _rag_context(ticket)
    _ollama_chat.last_hits = hits
    user = _build_user(ticket, ctx)
    payload = json.dumps({
        "model": LMSTUDIO_MODEL, "temperature": 0.2, "max_tokens": 800,
        "stream": False,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
    }).encode()
    req = urllib.request.Request(
        f"{LMSTUDIO_URL}/chat/completions", data=payload, method="POST",
        headers={"Content-Type": "application/json", "X-Project": "IT-Helpdesk-Lab"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        data = json.loads(res.read().decode())
    choices = data.get("choices") or []
    content = (choices[0].get("message") or {}).get("content", "") if choices else ""
    return _parse_llm_json(content)


def _local_chat(ticket: dict) -> tuple[dict, str, str]:
    """Gọi tầng LLM local đang cấu hình → (analysis, engine, model)."""
    if USE_LMSTUDIO:
        return _lmstudio_chat(ticket), "lmstudio", LMSTUDIO_MODEL
    return _ollama_chat(ticket), "ollama", OLLAMA_MODEL


def _rag_hits_of(ticket: dict) -> list:
    return getattr(_ollama_chat, "last_hits", []) or []


def analyze_ticket(ticket: dict) -> dict:
    ctx, hits = _rag_context(ticket)
    _ollama_chat.last_hits = hits
    rag = {"hits": len(hits), "sources": [h.get("source") for h in hits]}
    local_engine = "lmstudio" if USE_LMSTUDIO else "ollama"
    # Tầng 1: OpenAI cloud (nếu có key).
    if _openai_key():
        try:
            r = _openai_chat(_build_user(ticket, ctx))
            return {"engine": "openai", "model": OPENAI_MODEL,
                    "rag": rag, "playbook": None, **r,
                    "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M")}
        except Exception as e_openai:
            try:  # Tầng 2: LLM local (Ollama hoặc LM Studio).
                r, engine, model = _local_chat(ticket)
                out = {"engine": engine, "model": model,
                       "rag": rag, "playbook": None, **r,
                       "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M")}
                out["fallbackReason"] = f"OpenAI lỗi ({e_openai}) → dùng {engine} local"
                return out
            except Exception as e2:
                out = _rag_fallback(ticket, f"OpenAI: {e_openai}; {local_engine}: {e2}")
                return out
    try:
        r, engine, model = _local_chat(ticket)
        hits = _rag_hits_of(ticket)
        return {"engine": engine, "model": model,
                "rag": {"hits": len(hits),
                        "sources": [h.get("source") for h in hits]},
                "playbook": None, **r,
                "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M")}
    except Exception as e:  # fail-soft: LLM local chưa chạy -> RAG rule-based vẫn 200
        return _rag_fallback(ticket, e)


def _rag_fallback(ticket: dict, err) -> dict:
    try:
        from rag.retrieve import retrieve
        q = " ".join(str(ticket.get(k, "")) for k in ("title", "category", "description"))
        hits = retrieve(q, top_k=3)
    except Exception:
        hits = []
    if hits:
        best = hits[0]
        out = rule_based(ticket)
        out["engine"] = "rag-rule"
        out["rag"] = {"hits": len(hits),
                      "sources": [h.get("source") for h in hits]}
        out["summary"] = f"(RAG: {best.get('source')}) {out['summary']}"
        out["fallbackReason"] = str(err)[:200]
        return out
    out = rule_based(ticket)
    out["fallbackReason"] = str(err)[:200]
    return out


def ai_status() -> dict:
    local_model = LMSTUDIO_MODEL if USE_LMSTUDIO else OLLAMA_MODEL
    local_url = LMSTUDIO_URL if USE_LMSTUDIO else OLLAMA_URL
    local_engine = "lmstudio" if USE_LMSTUDIO else "ollama"
    base = {"model": local_model,
            "openai": {"configured": bool(_openai_key()), "model": OPENAI_MODEL},
            "checkedAt": datetime.now().strftime("%Y-%m-%d %H:%M")}
    try:
        if USE_LMSTUDIO:
            req = urllib.request.Request(f"{LMSTUDIO_URL}/models", method="GET")
            with urllib.request.urlopen(req, timeout=3) as res:
                data = json.loads(res.read().decode())
            models = [m.get("id", "") for m in data.get("data", []) if m.get("id")]
        else:
            req = urllib.request.Request(f"{OLLAMA_URL}/api/tags", method="GET")
            with urllib.request.urlopen(req, timeout=3) as res:
                data = json.loads(res.read().decode())
            models = [m.get("name", "") for m in data.get("models", []) if m.get("name")]
        return {"engine": local_engine, "reachable": True, "url": local_url,
                "models": models, "error": None, **base}
    except Exception as e:
        eng = "openai" if _openai_key() else "rule-based"
        return {"engine": eng, "reachable": False, "url": local_url,
                "models": [], "error": str(e)[:200], **base}
