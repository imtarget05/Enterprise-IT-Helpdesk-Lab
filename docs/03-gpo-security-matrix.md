# Enterprise IT Helpdesk Lab — Group Policy Objects (GPO) Security Matrix

Tài liệu thiết kế và triển khai ma trận chính sách nhóm (GPO) trên máy chủ Windows Server 2022 nhằm kiểm soát an ninh thông tin, chuẩn hóa môi trường làm việc và phân quyền tự động cho doanh nghiệp.

---

## 1. MA TRẬN CHÍNH SÁCH GPO (POLICY MATRIX)

| Tên GPO | Đối tượng áp dụng (Scope / OU) | Thiết lập kỹ thuật (Settings Path) | Mục tiêu an ninh & vận hành |
|---|---|---|---|
| **GPO_DefaultDomainPasswordPolicy** | Toàn bộ Domain (`COMPANY.LOCAL`) | *Computer Configuration -> Windows Settings -> Security Settings -> Account Policies -> Password Policy* | - Độ dài mật khẩu tối thiểu: 10 ký tự.<br>- Độ phức tạp: Chữ hoa, chữ thường, số, ký tự đặc biệt.<br>- Thời hạn đổi mật khẩu: 90 ngày.<br>- Khóa tài khoản sau 5 lần nhập sai trong 15 phút (Lockout threshold). |
| **GPO_DriveMapping_Departments** | User Configuration áp dụng theo OU phòng ban | *User Configuration -> Preferences -> Windows Settings -> Drive Maps* | Tự động ánh xạ ổ đĩa mạng khi đăng nhập:<br>- `H:` trỏ về `\\FS01\HR` (chỉ nhóm `SG_HR_Users`).<br>- `A:` trỏ về `\\FS01\Accounting` (chỉ nhóm `SG_Accounting_Users`).<br>- `P:` trỏ về `\\FS01\Public` (toàn bộ nhân viên). |
| **GPO_Restrict_USB_Storage** | OU Workstations (trừ nhóm IT) | *Computer Configuration -> Administrative Templates -> System -> Removable Storage Access* | Bật chính sách: `All Removable Storage classes: Deny all access`. Chống rò rỉ dữ liệu qua USB cá nhân và ngăn lây lan mã độc ransomware. |
| **GPO_Disable_ControlPanel_Settings** | Toàn bộ User phòng ban thường | *User Configuration -> Administrative Templates -> Control Panel* | Bật chính sách: `Prohibit access to Control Panel and PC settings`. Ngăn người dùng tự ý cài đặt phần mềm lạ, đổi IP tĩnh làm xung đột mạng. |
| **GPO_ScreenLock_Timeout** | Toàn bộ máy trạm Workstations | *User Configuration -> Administrative Templates -> Control Panel -> Personalization* | Khóa màn hình máy tính có mật khẩu bảo vệ sau 10 phút không thao tác (Screen saver timeout) để tránh lộ dữ liệu khi rời bàn làm việc. |
| **GPO_WindowsUpdate_WSUS** | Toàn bộ Workstations & Servers | *Computer Configuration -> Administrative Templates -> Windows Components -> Windows Update* | Bật tự động tải bản vá bảo mật hàng tuần vào 2h sáng thứ Bảy, khởi động lại có thông báo trước. |

---

## 2. QUY TẮC PHÂN QUYỀN THƯ MỤC CHIA SẺ (SHARE VS NTFS PERMISSIONS)

Một nguyên tắc vàng trong quản trị File Server Windows:
> **Hiệu lực quyền = Giao điểm hạn chế nhất giữa Share Permissions và NTFS Permissions.**

### Thiết lập chuẩn tại `FS01-SRV`:
- **Share Permissions:** Luôn đặt `Authenticated Users = Full Control` hoặc `Change/Read`.
- **NTFS Permissions:** Áp dụng chặt chẽ theo nguyên tắc đặc quyền tối thiểu (Least Privilege):
  - Thư mục `D:\Shares\HR`:
    - `Domain Admins`: Full Control
    - `SG_HR_Users`: Modify (Read, Write, Execute, Delete)
    - `All Other Users`: Không có quyền (No Access / Deny)
  - Thư mục `D:\Shares\Accounting`:
    - `Domain Admins`: Full Control
    - `SG_Accounting_Users`: Modify
    - `All Other Users`: No Access
  - Thư mục `D:\Shares\Public`:
    - `Authenticated Users`: Read & Write (Không cho quyền Full Control để tránh xóa nhầm thư mục gốc).

---

## 3. LỆNH KIỂM TRA & XỬ LÝ LỖI GPO TẠI CLIENT
- Ép máy client nhận chính sách GPO mới ngay lập tức mà không cần khởi động lại:
  ```cmd
  gpupdate /force
  ```
- Xuất báo cáo kết quả áp dụng GPO chi tiết (kiểm tra GPO nào đang được áp dụng hoặc bị chặn):
  ```cmd
  gpresult /h C:\gpreport.html
  gpresult /r
  ```
