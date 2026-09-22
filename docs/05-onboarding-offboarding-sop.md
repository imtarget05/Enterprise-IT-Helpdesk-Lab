# Enterprise IT Helpdesk Lab — Onboarding & Offboarding Standard Operating Procedures (SOP)

Quy trình chuẩn vận hành (SOP) dành cho bộ phận IT Helpdesk trong việc quản lý vòng đời tài khoản và tài sản công nghệ của nhân sự từ ngày đầu vào công ty cho đến khi nghỉ việc.

---

## 1. QUY TRÌNH TIẾP NHẬN NHÂN VIÊN MỚI (IT ONBOARDING SOP)

```text
[Nhận Ticket Onboarding từ HR trước ngày đi làm 3 ngày]
                         │
                         ▼
        [Bước 1: Khởi tạo tài khoản người dùng]
        - Chạy script PowerShell New-CompanyUser.ps1
        - Đặt tài khoản vào đúng OU phòng ban (OU=Departments)
        - Phân nhóm quyền bảo mật (Security Groups)
        - Cấu hình bắt buộc đổi mật khẩu lần đầu đăng nhập
                         │
                         ▼
        [Bước 2: Cấp phát hòm thư & Bản quyền phần mềm]
        - Gán bản quyền Microsoft 365 Business Standard
        - Thiết lập hòm thư [ten.ho@company.local]
        - Cấu hình xác thực 2 lớp (MFA via Microsoft Authenticator)
                         │
                         ▼
        [Bước 3: Chuẩn bị thiết bị phần cứng (Hardware Provisioning)]
        - Cài đặt hệ điều hành chuẩn (Windows 11 Pro Enterprise Image)
        - Cài đặt phần mềm bắt buộc: Endpoint Antivirus, Office 365, VPN Client, 7-Zip, Chrome
        - Join máy tính vào Domain COMPANY.LOCAL
        - Dán tem nhãn tài sản (Asset Tag: ví dụ `LP-IT-042`)
        - Đăng ký máy tính vào hệ thống quản lý IT Asset Portal
                         │
                         ▼
        [Bước 4: Bàn giao và ký Biên bản Bàn giao Thiết bị]
        - Hướng dẫn nhân viên mới đăng nhập mạng nội bộ, kết nối Wi-Fi doanh nghiệp
        - Hướng dẫn mở ổ đĩa mạng dùng chung (H:, A:, P:)
        - Ký biên bản bàn giao tài sản và hướng dẫn tạo ticket hỗ trợ
```

---

## 2. QUY TRÌNH THU HỒI TÀI SẢN KHI NGHỈ VIỆC (IT OFFBOARDING SOP)

```text
[Nhận thông báo nghỉ việc chính thức từ phòng Nhân sự / Ban Giám đốc]
                         │
                         ▼
        [Bước 1: Khóa quyền truy cập tức thời (Account Lockdown)]
        - Vào Active Directory: Disable Account (Không xóa vội để bảo toàn SID và dữ liệu)
        - Đổi mật khẩu tài khoản thành chuỗi ngẫu nhiên 30 ký tự
        - Thu hồi toàn bộ phiên đăng nhập đang hoạt động (Revoke active sessions / Sign out of all sessions)
        - Xóa tài khoản khỏi các Security Groups nhạy cảm
                         │
                         ▼
        [Bước 2: Xử lý Hòm thư và Dữ liệu công việc]
        - Chuyển đổi hòm thư Exchange sang Shared Mailbox để không tốn chi phí license M365
        - Ủy quyền quyền đọc hòm thư (Mailbox Delegation) cho Quản lý trực tiếp theo yêu cầu
        - Lập chính sách tự động trả lời thư (Auto-reply Out of Office) thông báo nhân sự đã chuyển công tác
        - Sao lưu dữ liệu OneDrive và ổ đĩa cá nhân của nhân sự vào kho lưu trữ nội bộ
                         │
                         ▼
        [Bước 3: Thu hồi và Kiểm định Thiết bị phần cứng]
        - Thu hồi Laptop, sạc, chuột, bàn phím, thẻ từ ra vào cửa văn phòng
        - Kiểm tra tình trạng vật lý (màn hình vỡ, trầy xước, bàn phím liệt)
        - Chạy script kiểm định phần cứng và kiểm tra ổ đĩa
        - Cập nhật trạng thái thiết bị trong IT Asset Portal: Chuyển từ `Assigned` sang `In Storage` hoặc `Under Maintenance`
                         │
                         ▼
        [Bước 4: Tẩy xóa dữ liệu an toàn (Data Sanitization)]
        - Sau thời hạn lưu trữ quy định 30 ngày (Data Retention Period):
        - Thực hiện Secure Wipe hoặc Re-image máy tính sạch sẽ để sẵn sàng cấp phát cho nhân sự tiếp theo
        - Ký xác nhận hoàn tất thủ tục bàn giao IT với phòng Nhân sự
```
