# Demo 5 phút + Kịch bản phỏng vấn — JD Python Internal App + AI + Helpdesk

> **Dùng cho JD:** app/script nội bộ Python · website · tích hợp AI (OpenAI/Google) ·
> tài liệu & training · helpdesk mạng/PC/email. Yêu cầu 1–2 năm KN.
> **Trung thực:** trình bày là *dự án portfolio mô phỏng*, không khai năm kinh nghiệm.

---

## PHẦN 1 — DEMO 5 PHÚT (làm đúng thứ tự, lệnh copy-paste)

### Project 1 — IT Helpdesk Portal + Python Flask + AI (0:00–3:30)

**0:00–0:30 — Mở đầu 1 câu:**
> "Em làm 1 portal IT nội bộ: quản lý tài sản + ticket helpdesk. Có 2 bản cùng nghiệp vụ —
> bản Node đang chạy ở `localhost:3000`, và bản **Python Flask** ở `127.0.0.1:5001`
> với **data riêng** (`python-portal/data/db.json`), có chốt an toàn chống trỏ nhầm
> sang file của Node, để chứng minh em làm chủ Python backend.
> Bản Flask chỉ dùng để demo/JD walkthrough: chạy loopback, không có auth, CORS mở —
> nếu đưa vào dùng thật thì phải bổ sung auth + chốt chạy Node/Flask trên data riêng."

> Bản **Node** thì có auth thật: chạy `AUTH_MODE=lab` thì người dùng đăng nhập qua
> form của portal để lấy Bearer token, và chính token đó mới mở được các route
> enterprise (tài sản, ITSM, audit) — không có route nào đó là public. Đây là hành
> trình em dùng để demo, và cũng là hành trình `scripts/test-ui-e2e.sh` tự động hoá
> bằng Playwright (journey `lab` + journey `legacy`)."

**0:30 (bổ sung) — đăng nhập `AUTH_MODE=lab` và tạo ticket thật qua portal:**
```bash
cd internal-portal
AUTH_MODE=lab npm start
# mở http://localhost:3000 → đăng nhập bằng user lab → tạo 1 ticket → refresh → ticket còn nguyên
```
> Nói khi mở được màn hình sau login: "Đây không phải UI tĩnh — nó đi qua
> `auth.middleware` trước mọi route enterprise. Bộ test của em kiểm đúng ranh giới
> này: anonymous thấy `401`, sai role thấy `403`."
> **Bằng chứng:** `test/auth-boundary.test.js`; chạy tự động: `scripts/test-ui-e2e.sh`.

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
> **C# ASP.NET 62 endpoint, Oracle PL/SQL, 302/302 test pass** (247 test không cần DB + 55 test `Category=Integration` chạy trên Oracle thật).
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
> ghi file JSON atomic (ghi file tạm → `fsync` → `os.replace` → `fsync` thư mục,
> nên không để lại file nửa vời khi mất điện), giữ nguyên các collection mở rộng
> của bản Node khi ghi đè (read-modify-write), từ chối ghi đè nếu file data đang
> hỏng, xuất CSV kiểm kê. Chạy `python app.py` là lên, không cần build.
> Bản Flask **tách biệt về dữ liệu**: mặc định nó trỏ `data/db.json` riêng của
> Flask, và nếu ai trỏ `DATA_FILE` vào đúng file của Node thì nó **fail-fast
> chứ không ghi**, nên hai cổng không còn đè dữ liệu lên nhau nữa.
> Lưu ý: bản Flask là **demo, không có auth**, bind loopback mặc định."
> **Bằng chứng:** mở `app.py`, chạy 2 lệnh curl tạo asset + ticket; bộ test
> cô lập của Flask là `python-portal/tests/` + `test_isolation.py` —
> `cd python-portal && DATA_FILE=<tmp>/db.json PORT=0 python3 -m unittest discover -s . -p 'test_*.py'`
> → **79/79 pass**.

### 2. "Tích hợp AI ra sao? Có dùng OpenAI không?"
> "Dạ có. `src/ai.js` chạy 3 tầng: **OpenAI cloud** (`response_format: json_object`,
> key chỉ đọc từ `.env`, không bao giờ log) → rớt xuống **Ollama Qwen local**
> → cuối cùng là **playbook rule-based**. Kèm **RAG Qdrant**: 255 chunk runbook
> nội bộ, retrieve top-3 ghép vào prompt nên AI không bịa lệnh.
> Test suite có case fake OpenAI 401 → fallback đúng, **269/269 pass**."
> **Bằng chứng:** `test/api-ai.test.js` (2 case OpenAI), response có `rag.sources`.
> Ngoài unit/integration, em còn có **browser E2E bằng Playwright** (`scripts/test-ui-e2e.sh`)
> chạy 2 journey (legacy + `AUTH_MODE=lab`) và kiểm cả "console không có lỗi" lẫn
> "không có request same-origin nào thất bại" — vì demo bằng mắt thì không bắt được
> lỗi network. Lần chạy gần nhất: **19/19** browser E2E, **18/18** gate, **68/68** REST smoke.

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
