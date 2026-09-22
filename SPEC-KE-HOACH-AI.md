# KẾ HOẠCH & PROMPT DÀNH CHO AI: HOÀN THIỆN ĐỒ ÁN IT ASSET & HELPDESK PORTAL

> **Mục đích:** File này được thiết kế để bạn copy toàn bộ hoặc gửi trực tiếp cho một AI Coding Assistant (Cline, Cursor, Roo Code, Claude, Copilot, ChatGPT...) để AI tự động nâng cấp, kiểm thử và đóng gói hoàn thiện ứng dụng web nội bộ **IT Asset & Helpdesk Management Portal** và bộ công cụ tự động hóa của dự án **05-Enterprise-IT-Helpdesk-Lab**.
> **Vị trí dự án trên máy:** `~/Downloads/PORTFOLIO/05-Enterprise-IT-Helpdesk-Lab/`

---

## PHẦN 1: TỔNG QUAN YÊU CẦU & BỐI CẢNH DỰ ÁN

- **Mục tiêu:** Xây dựng hoàn chỉnh ứng dụng quản lý thiết bị CNTT, vòng đời tài sản (IT Asset Lifecycle) và xử lý ticket hỗ trợ kỹ thuật nội bộ phục vụ trực tiếp cho vị trí **Nhân viên IT (Phần mềm nội bộ + IT Support)** tại BMC Việt Nam và vị trí **IT Helpdesk** tại OKIA.
- **Kiến trúc ứng dụng:**
  - Vị trí: `05-Enterprise-IT-Helpdesk-Lab/internal-portal/`
  - Backend: Node.js + Express REST API (`server.js`, `package.json`).
  - Frontend: Giao diện bảng điều khiển đơn trang (Single Page Dashboard: `index.html`, `styles.css`, `app.js`) với 4 phân hệ: Dashboard KPI, Quản lý thiết bị (Assets), Quản lý phiếu hỗ trợ (Tickets), Quản lý bản quyền phần mềm (Licenses).
  - Tự động hóa: Bộ script PowerShell tại `scripts/` (`New-CompanyUser.ps1`, `Export-ITAssetAudit.ps1`, `Test-NetworkHealth.ps1`).

---

## PHẦN 2: CÁC FILE ĐÃ CÓ SẴN TRONG REPOSITORY
AI không cần dựng khung từ đầu mà sẽ nâng cấp trực tiếp từ các file đã xây dựng:
- `internal-portal/server.js`: Đã có sẵn các API endpoints, cấu trúc dữ liệu thiết bị, ticket và license.
- `internal-portal/public/index.html`: Giao diện Dashboard hiện đại đã có sẵn thanh menu, biểu đồ KPI, bảng dữ liệu và các form modal thêm thiết bị/ticket.
- `internal-portal/public/styles.css`: Hệ màu giao diện tối (Dark mode) chuẩn doanh nghiệp.
- `internal-portal/public/app.js`: Xử lý tương tác fetch API, tìm kiếm lọc dữ liệu, đổi trạng thái ticket.
- `docs/06-interview-qa.md`: 30 câu hỏi phỏng vấn Helpdesk kinh điển.
- `tickets/`: 20 kịch bản sự cố chuẩn ITIL (INC-1001 đến INC-1020).

---

## PHẦN 3: LỘ TRÌNH THỰC THI CHI TIẾT (DÀNH CHO AI)

```text
[BƯỚC 1: KHỞI TẠO & KIỂM TRA MÃ NGUỒN HIỆN TẠI]
├── Di chuyển vào thư mục internal-portal/.
├── Chạy npm install và npm start.
└── Xác nhận máy chủ mở tại http://localhost:3000 không có lỗi runtime.

[BƯỚC 2: NÂNG CẤP TÍNH NĂNG CHUYÊN SÂU]
├── 1. Lưu trữ dữ liệu bền vững (Persistence):
│      Thêm cơ chế lưu trữ tự động vào file JSON cục bộ (data/db.json) hoặc SQLite
│      để khi restart server, các thiết bị và ticket mới tạo không bị mất.
├── 2. Tính năng Xuất Báo Cáo (CSV / Excel Export):
│      Thêm nút "Xuất File Kiểm Kê (CSV)" trong tab IT Assets để tải về danh sách thiết bị.
├── 3. Tính năng Thông báo Webhook (Notification Mock):
│      Khi có Ticket mức "High" được tạo, tự động log thông báo giả lập gửi về Telegram/Email.
└── 4. Đóng gói Docker (Containerization):
       Tạo Dockerfile và docker-compose.yml nhẹ cho internal-portal để có thể chạy ở bất kỳ đâu chỉ bằng 1 lệnh.

[BƯỚC 3: KIỂM THỬ TỰ ĐỘNG & VERIFICATION]
├── Viết một file test tự động (test.js hoặc test-api.sh) kiểm tra toàn bộ REST API:
│   ├── GET /api/dashboard/stats
│   ├── POST /api/assets (thêm thử 1 laptop mới)
│   ├── PATCH /api/tickets/1006/status (chuyển trạng thái ticket sang Resolved)
│   └── DELETE /api/assets/:id
└── Kiểm tra cú pháp của 3 script PowerShell trong thư mục scripts/ để đảm bảo không có lỗi chính tả.
```

---

## PHẦN 4: ĐOẠN PROMPT CHUẨN ĐỂ BẠN COPY-PASTE CHO AI

*(Bạn hãy copy toàn bộ đoạn trong khung dưới đây và dán vào AI Assistant của bạn)*

```text
Bạn là một Fullstack & DevOps Engineer giàu kinh nghiệm.
Nhiệm vụ của bạn là hoàn thiện, nâng cấp và kiểm thử toàn diện đồ án "IT Asset & Helpdesk Portal" đặt tại thư mục:
/Users/mainguyenbinhtan/Downloads/PORTFOLIO/05-Enterprise-IT-Helpdesk-Lab/internal-portal

YÊU CẦU THỰC HIỆN TỪNG BƯỚC:
1. Đọc và phân tích mã nguồn hiện tại trong server.js, public/index.html, public/app.js, public/styles.css.
2. Cài đặt các dependencies và khởi động ứng dụng để kiểm tra hoạt động hiện tại (port 3000).
3. Nâng cấp tính năng lưu trữ bền vững:
   - Thêm module lưu trữ dữ liệu (sử dụng file JSON nội bộ hoặc thư viện SQLite nhẹ) để dữ liệu Assets và Tickets được bảo toàn khi server khởi động lại.
4. Bổ sung tính năng Xuất Báo Cáo Tài Sản:
   - Thêm nút "Xuất Danh Sách Tài Sản (CSV)" trên giao diện web để người dùng có thể tải file kiểm kê về máy.
5. Tạo Dockerfile và docker-compose.yml cho ứng dụng để đóng gói chạy độc lập trên môi trường máy chủ.
6. Viết script kiểm thử tự động (test-api.sh hoặc test.js) chạy kiểm tra tự động 100% các REST endpoints và in ra kết quả PASS/FAIL rõ ràng.
7. Đảm bảo giao diện UI mượt mà, phản hồi nhanh và báo cáo kết quả hoàn thành chi tiết cho tôi.
```
