# Incident Ticket #INC-1008 — Outlook Disconnected & Credential Cache Loop

- **Ticket ID:** INC-1008
- **Requester:** Pham Quoc Huy (Phòng Dự án)
- **Department:** Project Management
- **Priority:** High
- **Category:** Email / Microsoft 365
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Người dùng mở ứng dụng Microsoft Outlook 365 trên máy tính để gửi báo cáo tuần cho đối tác. Góc dưới bên phải của Outlook hiển thị thông báo trạng thái: *"Disconnected"* hoặc *"Need Password"*. Khi người dùng bấm vào và nhập mật khẩu tài khoản thì hộp thoại đăng nhập biến mất rồi lập tức hiện lại vòng lặp (Login Loop), không thể tải thư mới.

---

## 2. CHẨN ĐOÁN
1. Kiểm tra tài khoản trên web: Hướng dẫn người dùng mở trình duyệt web truy cập `outlook.office.com`. Người dùng đăng nhập thành công và gửi nhận thư bình thường -> Khẳng định tài khoản không bị khóa, không bị sai mật khẩu và license M365 vẫn đang hoạt động.
2. Kiểm tra tiến trình Outlook: Khởi động Outlook ở chế độ Safe Mode (`outlook.exe /safe`) -> Vẫn bị kẹt ở trạng thái Disconnected -> Loại trừ nguyên nhân do Add-in bên thứ ba.
3. Kiểm tra thông tin lưu trữ xác thực Windows (Windows Credential Manager):
   - Mở `Control Panel -> Credential Manager -> Windows Credentials`.
   - Phát hiện có 6 bản ghi lưu trữ mật khẩu cũ liên quan đến `MicrosoftOffice16_Data:SSPI:...` và `ADAL` đã tồn tại từ 6 tháng trước.

---

## 3. NGUYÊN NHÂN GỐC RỄ
Bộ nhớ đệm xác thực Modern Authentication (ADAL/WAM) của Windows bị lỗi đồng bộ Token với Azure AD / Microsoft Entra ID. Các khóa lưu trong Windows Credential Manager bị xung đột khiến tiến trình `brokerplugin.exe` gửi mã xác thực cũ lên máy chủ xác thực, gây ra vòng lặp từ chối đăng nhập.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Đóng hoàn toàn Outlook và Teams (kiểm tra trong Task Manager để chắc chắn không còn tiến trình chạy ngầm).
2. Xóa sạch thông tin đăng nhập cũ trong Windows Credential Manager:
   - Xóa toàn bộ các mục có chứa `MicrosoftOffice16`, `MS.Outlook`, `OneDrive`, `Teams`.
3. Đổi tên thư mục Identity Cache để ép Windows tái tạo lại hồ sơ xác thực mới:
   ```cmd
   ren "%localappdata%\Microsoft\IdentityCache" "IdentityCache.old"
   ren "%localappdata%\Microsoft\OneAuth" "OneAuth.old"
   ```
4. Mở lại Outlook:
   - Cửa sổ đăng nhập Microsoft 365 hiện đại xuất hiện.
   - Người dùng nhập địa chỉ email, mật khẩu chuẩn và thực hiện phê duyệt thông báo xác thực 2 lớp (MFA) trên ứng dụng Microsoft Authenticator.
5. Kiểm tra góc dưới Outlook: Trạng thái chuyển ngay sang *"Connected to: Microsoft Exchange"* và thanh tiến trình hiển thị *"All folders are up to date"*.

---

## 5. PHÒNG NGỪA
- Thêm kịch bản xử lý này vào mục FAQ của IT Portal để người dùng có thể tự xóa Credential rác khi đổi mật khẩu mới.
