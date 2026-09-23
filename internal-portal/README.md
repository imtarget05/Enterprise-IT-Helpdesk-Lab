# IT Asset & Helpdesk Management Portal — v2.0.0

Ứng dụng web nội bộ quản lý **tài sản CNTT**, **ticket hỗ trợ (ITIL)** và **bản quyền phần mềm**, xây theo JD *Nhân viên IT (phần mềm nội bộ + IT Support)* — BMC Việt Nam / *IT Helpdesk* — OKIA.

- **Backend:** Node.js 18+/22, Express 4, CORS — persistence file JSON nguyên tử, **0 dependency native**.
- **Frontend:** SPA một trang (`public/`) — vanilla JS, dark mode, toast, skeleton, sort/filter, xuất CSV.
- **Kiểm thử:** `node:test` (unit + integration HTTP thật) và `test-api.sh` (curl) phủ **100% REST endpoints**.
- **Đóng gói:** Dockerfile multi-stage (non-root, healthcheck) + `docker-compose.yml`.

## 1. Chạy nhanh

```bash
npm install
npm start          # → http://localhost:3000
```

Biến môi trường: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (./data), `IT_WEBHOOK_URL` (tuỳ chọn).

```bash
npm run dev        # node --watch, tự reload khi sửa code
```

Khôi phục dữ liệu demo về trạng thái chuẩn (trước buổi demo/phỏng vấn):

```bash
cp fixtures/db.baseline.json data/db.json    # rồi khởi động lại (hoặc docker compose restart)
```

## 2. Chạy với Docker

```bash
docker compose up -d --wait        # build + chạy, data mount vào ./data
open http://localhost:3000
docker compose logs -f it-portal   # xem log (bao gồm alert ticket High/Critical)
docker compose restart             # dữ liệu VẪN CÒN (persistence qua volume)
docker compose down
```

Không dùng compose:

```bash
docker build -t bmc/it-asset-helpdesk-portal:2.0.0 .
docker run -d -p 3000:3000 -v "$PWD/data:/app/data" --name it-portal bmc/it-asset-helpdesk-portal:2.0.0
```

## 3. Kiểm thử tự động

| Lệnh | Nội dung |
|---|---|
| `npm test` | **93 test PASS**: store/CSV/notifier unit test + integration HTTP thật trên ephemeral port + restart persistence + UI contract + PowerShell lint/mutation |
| `npm run test:api` (hoặc `./test-api.sh`) | Smoke test **curl** chạy qua **100% endpoints**, in bảng PASS/FAIL, tự boot server trên port 3210 với data tạm, exit code 0/1 |
| `PORT=3210 ./test-api.sh` | Như trên nhưng chọn port khác |
| `BASE_URL=http://localhost:3000 ./test-api.sh` | Đánh vào server/container **đang chạy thật** |
| `bash scripts/verify-ps1-syntax.sh` | Parse 3 file `.ps1` bằng AST parser PowerShell thật (dùng pwsh local hoặc Docker) |

Ví dụ kết thúc của `test-api.sh`:

```
  Tổng số kiểm tra : 61
  PASS            : 61
  FAIL            : 0
  Tỷ lệ đạt       : 100.0%
```

## 4. Kiến trúc

```
server.js            bootstrap mỏng: tạo app + listen + graceful shutdown (flush db)
src/app.js           createApp({dataDir}) → {app, store, notifier}; toàn bộ routes + validate
src/store.js         JSON file store: load/commit atomic (tmp→rename), corrupt-safe, nextId/find
src/seed.js          dữ liệu mẫu doanh nghiệp (6 assets, 6 tickets ITIL, 4 licenses)
src/csv.js           toCsv() RFC-4180 + UTF-8 BOM (mở Excel không lỗi font Việt) + auditFilename()
src/notify.js        webhook mock cho ticket High/Critical (console + data/notifications.log + POST thật nếu cấu hình)
public/              index.html · app.js · styles.css  (SPA, không build step)
data/db.json         ← sinh tự động ở lần chạy đầu, được .gitignore
test/                node:test suites + helpers + ps1-lint + list-routes
fixtures/            db.baseline.json — snapshot dữ liệu demo để restore nhanh (xem fixtures/README.md)
```

### Persistence hoạt động thế nào
1. Khởi động: nếu `data/db.json` tồn tại → nạp; nếu thiếu → seed từ `src/seed.js` rồi ghi đĩa; nếu **hỏng JSON** → đổi tên `db.json.corrupt-<timestamp>` và seed lại (server không bao giờ crash vì dữ liệu).
2. Ghi: mỗi mutation `await store.commit()` → ghi file tạm rồi `rename()` (atomic), các commit nối tiếp nhau qua 1 promise chain.
3. tắt máy: `SIGTERM/SIGINT` → `store.flush()` rồi `server.close()` (Docker stop an toàn).

### REST API

> 📄 **OpenAPI 3.1 spec:** [`public/openapi.yaml`](public/openapi.yaml) — được phục vụ tĩnh tại `/openapi.yaml`,
> dán vào [Swagger Editor](https://editor.swagger.io) để xem docs tương tác (request/response schema, enum, ví dụ).
> CI validate spec ở mỗi push (job `openapi-spec`).

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/health` | trạng thái, version, storage, số bản ghi |
| GET | `/api/dashboard/stats` | KPI: tài sản theo trạng thái, ticket, SLA %, cảnh báo license |
| GET | `/api/assets` | danh sách; filter `?q= &status= &type=` |
| GET | `/api/assets/export.csv` | **tải file kiểm kê CSV** (tôn trọng filter) |
| GET/PATCH/DELETE | `/api/assets/:id` | chi tiết / cập nhật / xóa |
| POST | `/api/assets` | đăng ký thiết bị (400 thiếu trường · 409 trùng tag/serial · 422 status sai) |
| GET | `/api/tickets` | danh sách; filter `?q= &status= &priority=` |
| GET | `/api/tickets/export.csv` | báo cáo ticket CSV |
| GET | `/api/tickets/:id` | chi tiết |
| POST | `/api/tickets` | tạo ticket; High/Critical → **webhook alert** |
| PATCH | `/api/tickets/:id/status` | Open → In Progress → Resolved/Closed (+ `resolvedAt`) |
| GET | `/api/licenses` `/api/licenses/:id` | bản quyền + `utilizationPercent` |
| GET | `/api/notifications` | hàng đợi cảnh báo đã gửi (`?limit=`) |
| * | sai đường dẫn/`/api/*` | 404 JSON; sai method → 405 + `Allow` |

### Webhook alert (mock → thật)
Mặc định in log `[notify:telegram]`, `[notify:email]` và ghi `data/notifications.log`.
Trỏ vào Slack/Teams/Mattermost thật:

```bash
IT_WEBHOOK_URL="https://hooks.slack.com/services/XXX/YYY/ZZZ" npm start
```

## 5. Ghi chú nghiệp vụ (ITIL)
- Vòng đời tài sản: `Active ⇄ In Storage`, `Maintenance`, `Retired`; nút **Cấp phát / Thu hồi** trên bảng.
- Ticket: phân loại theo sự cố thật (Network, DNS, AD, File Server, Hardware…), SLA % tính từ tỉ lệ đã xử lý.
- Asset Tag & Serial **duy nhất** (409) — đúng ràng buộc kiểm kê thực tế.
- CSV có UTF-8 BOM → bàn giao cho Kế toán/Tài sản mở bằng Excel ngay, không cần import wizard.
