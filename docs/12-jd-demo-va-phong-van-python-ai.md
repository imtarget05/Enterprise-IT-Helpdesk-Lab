# Demo 5 phút + Kịch bản phỏng vấn — JD Python Internal App + AI + Helpdesk

> **Dùng cho JD:** app/script nội bộ Python · website · tích hợp AI (OpenAI/Google) ·
> tài liệu & training · helpdesk mạng/PC/email. Yêu cầu 1–2 năm KN.
> **Trung thực:** trình bày là *dự án portfolio mô phỏng*, không khai năm kinh nghiệm.

---

## PHẦN 1 — DEMO 5 PHÚT (làm đúng thứ tự, lệnh copy-paste)

### Project 1 — IT Helpdesk Portal + Python Flask + AI (0:00–3:30)

**0:00–0:30 — Mở đầu 1 câu:**
> "Em làm 1 portal IT nội bộ: quản lý tài sản + ticket helpdesk. Có 2 bản cùng nghiệp vụ —
> bản Node đang chạy ở `localhost:3000`, và bản **Python Flask** ở `localhost:5001`
> dùng chung dữ liệu, để chứng minh em làm chủ Python backend."

**0:30–1:30 — Python Flask (điểm ăn tiền nhất của JD):**
```bash
# Health + thống kê dashboard
curl -s http://localhost:5001/api/health
curl -s http://localhost:5001/api/dashboard/stats

# Tạo ticket mới bằng Python API
curl -s -X POST http://localhost:5001/api/tickets \
  -H 'Content-Type: application/json' \
  -d '{"title":"Network Printer HP M608 Offline","requester":"Demo User","dept":"Admin","priority":"High","category":"Hardware"}'
```

**1:30–2:30 — AI phân tích ticket (OpenAI + RAG):**
```bash
curl -s -X POST http://localhost:3000/api/ai/analyze \
  -H 'Content-Type: application/json' \
  -d '{"title":"Network Printer HP M608 Offline","category":"Hardware"}' | python3 -m json.tool
```
> Nói khi kết quả hiện: "AI chạy 3 tầng — **OpenAI gpt-4o-mini** trước, rớt xuống
> Qwen local, cuối cùng là playbook offline nên demo không bao giờ chết.
> Quan trọng: prompt luôn kèm **top-3 đoạn runbook công ty từ Qdrant**
> (`rag.sources`), nên AI trả lời đúng quy trình nội bộ thay vì bịa."

**2:30–3:30 — RAG pipeline (chứng minh hiểu AI, không chỉ gọi API):**
```bash
cd internal-portal/python-portal
python3 -m rag.ingest --check        # 255 chunk từ 20 ticket + 11 doc
python3 -m rag.retrieve "máy in offline"   # trả về đúng ticket-005
```
> "Runbook trong repo là tri thức sống: ingest vào Qdrant 1 lần,
> mỗi ticket mới retrieve top-3 đoạn liên quan rồi mới đưa cho LLM."

### Project 2 — MiniERP (3:30–5:00, vai phụ: chứng minh backend chắc)

> "Project thứ hai chứng minh em làm backend nghiêm túc: MiniERP kho + sản xuất,
> **C# ASP.NET 57 endpoint, Oracle PL/SQL, 164/164 test pass**.
> Liên quan JD ở 3 điểm: (1) thiết kế REST API — cùng tư duy với Flask portal;
> (2) tài liệu UAT/bàn giao/training đầy đủ — đúng yêu cầu 'viết hướng dẫn, hỗ trợ user';
> (3) runbook vận hành và xử lý incident — cùng DNA helpdesk."
```bash
# Nếu còn giờ: demo nhanh genealogy (truy xuất nguồn gốc lô hàng)
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/trace/FG-RUNNER-PRO-01?direction=backward"
```

---

## PHẦN 2 — KỊCH BẢN HỎI–ĐÁP THEO TỪNG BULLET JD

### 1. "Em làm Python web thế nào?"
> "Em port nguyên portal Asset/Ticket sang **Flask** (`python-portal/app.py`):
> CRUD tài sản có validate trùng tag/serial (409), ticket có phân quyền trạng thái,
> ghi file JSON atomic (tmp + rename, không corrupt khi mất điện),
> xuất CSV kiểm kê. Chạy `python app.py` là lên, không cần build."
> **Bằng chứng:** mở `app.py`, chạy 2 lệnh curl tạo asset + ticket.

### 2. "Tích hợp AI ra sao? Có dùng OpenAI không?"
> "Dạ có. `src/ai.js` chạy 3 tầng: **OpenAI cloud** (`response_format: json_object`,
> key chỉ đọc từ `.env`, không bao giờ log) → rớt xuống **Ollama Qwen local**
> → cuối cùng là **playbook rule-based**. Kèm **RAG Qdrant**: 255 chunk runbook
> nội bộ, retrieve top-3 ghép vào prompt nên AI không bịa lệnh.
> Test suite có case fake OpenAI 401 → fallback đúng, **162/162 pass**."
> **Bằng chứng:** `test/api-ai.test.js` (2 case OpenAI), response có `rag.sources`.

### 3. "Frontend tới đâu?"
> "Dashboard + portal viết **HTML/CSS/JS thuần**, responsive, gọi REST trực tiếp:
> lọc tài sản theo trạng thái, tạo/đóng ticket, modal AI hiển thị nguồn RAG.
> Em chọn vanilla cho tool nội bộ vì nhẹ, không cần build; sẵn sàng học
> framework (React/Vue) khi công ty yêu cầu."
> **Bằng chứng:** mở `public/app.js` hàm `analyzeTicket`, modal `#ai-modal`.

### 4. "Viết tài liệu & hỗ trợ user?"
> "Cả 2 project đều có: MiniERP có **UAT plan + test case + signoff + user manual
> + training agenda** (`portfolio-case-studies` mẫu tương tự);
> Helpdesk Lab có **20 ticket ITIL viết theo khung symptom→diagnosis→root cause→fix→prevention**,
> SOP onboarding/offboarding, ma trận GPO. Em quen viết để người không chuyên đọc được."
> **Bằng chứng:** mở `tickets/ticket-001-*.md`, `docs/05-onboarding-offboarding-sop.md`.

### 5. "Sự cố mạng/PC/email xử lý sao?" (cho tình huống)
> Ví dụ: *"Ping được 8.8.8.8 nhưng không mở được google.com?"*
> "Ping IP được nghĩa là Layer 1–3 OK, lỗi ở **DNS**: em chạy `nslookup`,
> `ipconfig /all` kiểm tra DNS client, thử đổi tạm 8.8.8.8, `ipconfig /flushdns`,
> kiểm tra file hosts. Đúng runbook ticket-002 trong repo em."
> **Bằng chứng:** `tickets/ticket-002-cannot-resolve-dns.md`.

### 6. "Chưa đủ 1–2 năm kinh nghiệm?"
> "Em trung thực là fresher, chưa đi làm chính thức. Bù lại em đã **tự thực hành
> đúng đầu việc của vị trí**: CRUD app nội bộ, gọi AI API có fallback,
> viết tài liệu user, xử lý 20 kịch bản sự cố chuẩn ITIL — tất cả chạy được,
> test được, demo được ngay hôm nay. Em học nhanh và làm độc lập tốt,
> phần cứng công ty training thêm là em theo kịp."

---

## PHẦN 3 — CÂU HỎI KHÓ & CÁCH ĐỠ

| Câu hỏi bẫy | Cách đỡ |
|---|---|
| "Sao không dùng Django?" | "Tool nội bộ nhỏ, Flask đủ và nhẹ; em nắm MVC/request lifecycle nên sang Django chỉ là học thêm ORM/Admin — em sẵn sàng." |
| "Sao không dùng Google Gemini?" | "Pattern gọi API tương tự (endpoint + key + JSON); code em tách provider riêng nên đổi model là chạy. Em chọn OpenAI trước vì JSON mode ổn định." |
| "Qdrant tự host có cực không?" | "Không: 1 service docker, ~30MB RAM lúc rỗi; không có Qdrant thì code tự fallback InMemory — demo không gãy. Đây là thiết kế fail-soft xuyên suốt project em." |
| "Key OpenAI lộ thì sao?" | "Key chỉ nằm trong `.env` (gitignored), response/status API không bao giờ trả key — có test assert hẳn điều này. Key từng lộ là revoke ngay." |
| "MiniERP C# thì liên quan gì JD Python?" | "Chứng minh backend nền: thiết kế API, transaction, test, tài liệu UAT — chuyển sang Python là chuyển ngôn ngữ, không phải học lại tư duy." |
