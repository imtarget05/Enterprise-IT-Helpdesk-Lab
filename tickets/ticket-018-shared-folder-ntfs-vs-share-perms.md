# Incident Ticket #INC-1018 — Shared Folder "Read Only" Conflict (Share vs NTFS Permissions)

- **Ticket ID:** INC-1018
- **Requester:** Vu Dinh Dung (Trưởng phòng Dự án)
- **Department:** Project Management
- **Priority:** Medium
- **Category:** File Server / Permissions Conflict
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Toàn bộ thành viên phòng Quản lý Dự án (6 nhân viên) báo cáo: Họ vẫn mở và đọc được các file tài liệu trong thư mục mạng chia sẻ `\\FS01\Projects\DuAn2026`. Tuy nhiên, khi chỉnh sửa nội dung và bấm `Save`, phần mềm Word và Excel báo lỗi không cho lưu:
*"Word cannot complete the save due to a file permission error."* hoặc yêu cầu *"Save As"* sang một vị trí khác, khiến mọi người không thể cộng tác chỉnh sửa file dự án.

---

## 2. CHẨN ĐOÁN
1. Kiểm tra tài khoản người dùng: Tất cả 6 nhân viên đều thuộc nhóm bảo mật `SG_Projects_Team` trong Active Directory.
2. Đăng nhập vào máy chủ File Server `FS01-SRV` kiểm tra thư mục `D:\Shares\Projects`:
   - **Kiểm tra Tab NTFS Security:**
     - Nhóm `SG_Projects_Team` được cấp quyền: **`Modify`** (Bao gồm Read, Write, Execute, Delete, Create files).
     - Như vậy về mặt phân quyền NTFS hệ thống hoàn toàn cho phép ghi (Write Allowed).
   - **Kiểm tra Tab Sharing (Advanced Sharing -> Permissions):**
     - Danh sách cấp quyền Share:
       - `Everyone`: Chỉ được tích chọn **`Read`**! (Mục `Change` và `Full Control` không được tích chọn).

---

## 3. NGUYÊN NHÂN GỐC RỄ
Xung đột giữa **Share Permissions** và **NTFS Permissions**.
Theo quy tắc bảo mật của hệ điều hành Windows:
$$\text{Effective Permission} = \text{Most Restrictive}(\text{Share Permissions}, \text{NTFS Permissions})$$
Mặc dù NTFS cho phép quyền `Modify`, nhưng Share Permission lại giới hạn ở mức `Read Only`. Do người dùng truy cập qua giao thức mạng SMB, quyền hạn chế nhất là `Read` được áp dụng, làm triệt tiêu hoàn toàn quyền ghi của người dùng!

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Trên máy chủ File Server `FS01-SRV`:
   - Mở File Explorer -> Chuột phải vào thư mục `D:\Shares\Projects` -> Properties -> Tab `Sharing` -> Bấm nút `Advanced Sharing...`.
   - Bấm nút `Permissions`.
   - Tại mục quyền của nhóm `Authenticated Users` (hoặc `Everyone`):
     - Tích chọn thêm ô **`Change`** (Cho phép Đọc, Tạo mới, Chỉnh sửa và Xóa file qua mạng).
   - Nhấn `Apply` và `OK`.
2. Giữ nguyên phân quyền an ninh chi tiết tại tab `Security (NTFS)` để đảm bảo chỉ những ai thuộc nhóm `SG_Projects_Team` mới được sửa đổi trong các thư mục dự án tương ứng.

---

## 5. NGHIỆM THU
Yêu cầu nhân viên mở lại file Word báo cáo tiến độ trên đường dẫn `\\FS01\Projects\DuAn2026`, sửa thêm một đoạn văn bản và bấm nút `Save` -> File lưu thành công ngay lập tức trong 1 giây, không còn thông báo lỗi quyền.
