# Ảnh chứng minh (Evidence Screenshots)

Thư mục này chứa ảnh chụp màn hình **thật** từ portal đang chạy trong Docker
(`cd internal-portal && docker compose up -d --wait` → `http://localhost:3000`),
được nhúng inline trong `README.md` (§15) và `internal-portal/README.md`.

## Ảnh đã chụp (7 file, 23/09/2026)

| Tên file | Nội dung |
|---|---|
| `portal-dashboard.png` | Dashboard: 4 thẻ KPI + sự cố mới nhất + thiết bị cần bảo trì |
| `portal-assets.png` | IT Assets: bảng 6 thiết bị, filter, nút CSV |
| `portal-tickets.png` | Helpdesk Tickets: 6 ticket + nút **AI** trên mỗi dòng |
| `portal-ai-analysis.png` | Modal AI phân tích ticket #1001 (playbook offline, không có Ollama) |
| `portal-licenses.png` | Software Licenses: utilization + renewal |
| `portal-csv-export.png` | CSV xuất ra mở dạng text UTF-8 (BOM, mọi ô quoted) |
| `portal-health-endpoint.png` | `GET /api/health` trả về từ container |

## Ảnh lab VM — Pending (chụp trên lab thật)

| Tên file | Nội dung cần chụp | Cách tạo |
|---|---|---|
| `lab-aduc.png` | **Active Directory Users and Computers**: cây OU `Company_Enterprise` + tài khoản mẫu | Trên DC01 (VMware/VirtualBox) |
| `lab-gpo.png` | **Group Policy Management**: danh sách GPO đang áp (Password Policy, Mapped Drive, USB Block…) | Trên DC01 |
| `lab-apipa-before-after.png` | `ipconfig /all` trước khi lỗi (APIPA `169.254.x.x`) và sau khi `ipconfig /renew` thành công | Trên CL01 (Windows 11) |
| `lab-dns-nslookup.png` | `nslookup` thất bại (DNS sai) → sửa DNS → `nslookup` thành công | Trên CL01 |

## Quy tắc khi thêm ảnh

- Định dạng `.png`, **≤ 500 KB/ảnh** (dùng `pngquant`/`ImageOptim` nếu cần), bề rộng ~1400 px.
- **Che thông tin nhạy cảm**: mật khẩu, token, mã sản phẩm bản quyền, email/tên khách hàng thật.
  Chỉ dùng dữ liệu giả của lab (`corp.local`, `binh.tran`, `192.168.10.x`).
- Đặt tên đúng như bảng trên rồi **bỏ comment** dòng `<!-- ![...] -->` tương ứng trong `README.md` gốc.
- Nếu chưa có ảnh, phần *Screenshots & Demo* trong README vẫn render sạch (không có link ảnh gãy).
