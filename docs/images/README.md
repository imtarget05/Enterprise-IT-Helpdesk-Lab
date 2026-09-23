# Ảnh chứng minh (Evidence Screenshots)

Thư mục này chứa ảnh chụp màn hình dùng cho `README.md` gốc. Mục đích: chứng minh
phòng Lab và Portal **chạy thật**, không chỉ là văn bản mô tả.

## Danh mục ảnh cần chụp

| Tên file | Nội dung cần chụp | Cách tạo |
|---|---|---|
| `portal-dashboard.png` | Tab **Dashboard**: 4 thẻ KPI + bảng sự cố mới nhất + hàng đợi cảnh báo | `cd internal-portal && npm start` → mở `http://localhost:3000` |
| `portal-assets.png` | Tab **IT Assets**: bảng thiết bị, bộ lọc trạng thái, nút *Xuất Danh Sách Tài Sản (CSV)* | cùng portal, bấm tab IT Assets |
| `portal-tickets.png` | Tab **Helpdesk Tickets**: danh sách ticket + form tạo ticket + `PATCH` đổi trạng thái | cùng portal, bấm tab Helpdesk Tickets |
| `portal-csv-excel.png` | File CSV vừa xuất **mở bằng Excel** (đủ dấu tiếng Việt, không lỗi font) | Xuất CSV → mở bằng Excel/Numbers → chụp |
| `portal-docker-healthy.png` | `docker compose up -d --wait` + `docker ps` cột STATUS = *healthy* | `cd internal-portal && docker compose up -d --wait && docker ps` |
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
