# Incident Ticket #INC-1004 — Cannot Access Network Shared Folder

- **Ticket ID:** INC-1004
- **Requester:** Dang Thi Thu (Phòng Nhân Sự)
- **Department:** Human Resources
- **Priority:** Medium
- **Category:** File Server / NTFS Permissions
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ (PROBLEM DESCRIPTION)
Nhân viên mới chuyển từ phòng Hành chính sang phòng Nhân sự được 2 ngày. Khi nhấp đúp vào ổ đĩa mạng `H:` (trỏ về `\\FS01\HR`) hoặc truy cập đường dẫn mạng `\\fs01.company.local\HR`, màn hình hiển thị popup cảnh báo lỗi:
*"\\FS01\HR is not accessible. You might not have permission to use this network resource. Access is denied."*

---

## 2. CHẨN ĐOÁN (DIAGNOSIS)
1. Kiểm tra kết nối mạng tới máy chủ File Server: Chạy `ping fs01.company.local` -> Phản hồi tốt (< 1ms).
2. Kiểm tra truy cập thư mục chung: Người dùng vào `\\FS01\Public` đọc/ghi bình thường -> Dịch vụ chia sẻ file SMB hoạt động tốt.
3. Kiểm tra thông tin nhóm tài khoản của người dùng:
   - Mở PowerShell trên máy client hoặc DC01, chạy lệnh:
     ```powershell
     whoami /groups
     # Hoặc:
     Get-ADPrincipalGroupMembership -Identity "thu.dang" | Select-Object Name
     ```
   - Kết quả: Tài khoản `thu.dang` chỉ thuộc nhóm `Domain Users` và `SG_Admin_Staff`, **CHƯA** được thêm vào nhóm bảo mật `SG_HR_Users`.
4. Kiểm tra phân quyền NTFS trên thư mục `D:\Shares\HR` tại máy chủ `FS01-SRV`:
   - Phân quyền chỉ cấp cho nhóm `SG_HR_Users` quyền Modify.

---

## 3. NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE)
Khi phòng Nhân sự gửi thông báo điều chuyển phòng ban, phòng IT chưa được bàn giao ticket cập nhật nhóm phân quyền bảo mật Active Directory cho nhân sự này.

---

## 4. CÁC BƯỚC KHẮC PHỤC (RESOLUTION)
1. Mở `Active Directory Users and Computers` trên máy chủ `DC01-SRV`.
2. Tìm kiếm tài khoản `thu.dang` -> Chuột phải -> `Add to a group...` -> Nhập `SG_HR_Users` -> OK.
3. Đồng thời xóa tài khoản khỏi nhóm cũ `SG_Admin_Staff` để đảm bảo nguyên tắc đặc quyền tối thiểu (Least Privilege).
4. **Bước quan trọng về Kerberos Token:** Do vé Kerberos TGT cũ của người dùng trên máy trạm chưa chứa SID của nhóm `SG_HR_Users`, yêu cầu người dùng:
   - Đăng xuất tài khoản (Sign Out / Log off).
   - Đăng nhập lại (Log in) để Kerberos phát hành lại vé xác thực mới chứa quyền của nhóm mới.
5. Sau khi đăng nhập lại, nhấp đúp vào ổ đĩa `H:` -> Toàn bộ danh mục hồ sơ nhân sự mở ra bình thường.

---

## 5. PHÒNG NGỪA (PREVENTION)
- Chuẩn hóa quy trình điều chuyển nhân sự nội bộ (Internal Transfer SOP) qua form ticket có xác nhận của cả 2 trưởng phòng ban.
