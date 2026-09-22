# IT Asset & Helpdesk Portal — Hardening Plan (Persistence, CSV Export, Docker, E2E Tests)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Nâng cấp `internal-portal/` từ demo in-memory thành ứng dụng production-grade: dữ liệu bền vững qua restart, xuất báo cáo kiểm kê CSV, đóng gói Docker, bộ test tự động phủ 100% REST endpoints với kết quả PASS/FAIL.

**Architecture:** Tách `server.js` thành `src/app.js` (factory Express app, inject `dataDir` → test trên ephemeral port), `src/store.js` (JSON store, atomic write tmp→rename, corrupt-safe), `src/seed.js` (dữ liệu mẫu ITIL), `src/csv.js` (CSV RFC-4180 + BOM cho Excel), `src/notify.js` (webhook mock ticket High/Critical). Frontend giữ vanilla JS, thêm toast/loading/sort/filter + nút xuất CSV.

**Tech Stack:** Node.js 22, Express 4, CORS, Vanilla JS/CSS, Docker multi-stage (node:20-alpine, non-root, HEALTHCHECK), test bằng `node:test` built-in + bash/curl.

**Spec:** `~/Downloads/PORTFOLIO/KE_HOACH_HOAN_THIEN_IT_PORTAL_LAB_CHO_AI.md` (Phần 3, Bước 2–3)

## Constraints

- Zero runtime dependency mới — JSON file store thay SQLite (không native build, offline-safe cho Docker).
- Port mặc định `3000` (override `PORT`); data dir mặc định `./data` (override `DATA_DIR`).
- Docker: non-root user, HEALTHCHECK, volume `./data:/app/data`, `restart: unless-stopped`.
- `db.json` missing → seed; `db.json` corrupt → backup `.corrupt-<ts>` rồi seed (không bao giờ crash).
- UI: giữ design system dark mode hiện có, label tiếng Việt, mọi fetch có try/catch + toast.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/seed.js` | Create | Dataset mẫu assets/tickets/licenses |
| `src/store.js` | Create | JSON persistence: load/commit/nextId/find, atomic + corrupt-safe |
| `src/csv.js` | Create | `toCsv(rows, columns)`, `auditFilename()` |
| `src/notify.js` | Create | Webhook mock alert (log file + console + optional POST) |
| `src/app.js` | Create | `createApp(opts) → {app, store, notifier}` — toàn bộ routes |
| `server.js` | Modify | Bootstrap mỏng: createApp + listen |
| `public/index.html` | Modify | Nút Export CSV, filters, toast container, sortable headers |
| `public/app.js` | Modify | `apiJson()` wrapper, debounce, export, toast, PATCH status |
| `public/styles.css` | Modify | Toast, skeleton, sort caret, spinner, responsive |
| `test/*.test.js` | Create | `node:test` unit + integration + restart persistence |
| `test-api.sh` | Create | Bash/curl smoke test → PASS/FAIL table + exit code |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | Create | Containerisation |
| `internal-portal/README.md` | Create | Chạy / Docker / test / kiến trúc |
| `scripts/*.ps1` | Verify | Syntax tĩnh (host không có pwsh) |

## Endpoint Contract

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/health` | 200 `{status,uptime,storage,counts}` | — |
| GET | `/api/dashboard/stats` | 200 KPI + licenseAlerts + assetsByType + sla | — |
| GET | `/api/assets` | 200 (query `q,status,type`) | — |
| GET | `/api/assets/export.csv` | 200 `text/csv` attachment | — |
| GET | `/api/assets/:id` | 200 | 404 |
| POST | `/api/assets` | 201 | 400 thiếu tag/brand/model; 409 trùng tag/serial; 422 status sai |
| PATCH | `/api/assets/:id` | 200 | 404, 409, 422 |
| DELETE | `/api/assets/:id` | 200 `{success}` | 404 |
| GET | `/api/tickets` | 200 (query `q,status,priority`) | — |
| GET | `/api/tickets/:id` | 200 | 404 |
| POST | `/api/tickets` | 201 (+ webhook High/Critical) | 400 |
| PATCH | `/api/tickets/:id/status` | 200 | 404, 422 |
| GET | `/api/licenses` | 200 | — |
| GET | `/api/notifications` | 200 `{count,items}` | — |
| ANY | `/api/*` | — | 404 JSON |

## Tasks

- [ ] **T1** Store + seed: red (`Cannot find module`) → green (load/commit/corrupt/nextId).
- [ ] **T2** CSV + notifier: escaping/BOM/filename, threshold alert, webhook failure tolerated.
- [ ] **T3** API `src/app.js` + bootstrap `server.js`: mọi endpoint + validation + 404/500 handler + `await store.load()` trước listen.
- [ ] **T4** UI: Export CSV button, filters, sort, toast, skeleton, debounce, error handling.
- [ ] **T5** Dockerfile multi-stage + compose + .dockerignore + build/run/restart-persistence verify.
- [ ] **T6** `test-api.sh` phủ 100% endpoints + `npm test`; kiểm tra cú pháp 3 file `.ps1`; cập nhật README + docs.

## Self-review

- Spec coverage: persistence (T1/T3), CSV export (T2/T3/T4), webhook mock (T2/T3), Docker (T5), auto test (T3/T6), UI mượt (T4), PowerShell syntax (T6). Không còn requirement nào chưa có task.
- Type consistency: `createStore`, `createApp`, `toCsv`, `auditFilename`, `createNotifier` dùng thống nhất giữa các task.
