# Request Ticket #REQ-2015 — Employee Termination & IT Offboarding Procedure

- **Ticket ID:** REQ-2015
- **Requester:** Tran Thi Thu (Trưởng phòng Nhân sự)
- **Department:** Human Resources
- **Priority:** High
- **Category:** Security / Account Revocation / Offboarding
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ YÊU CẦU
Nhân sự nghỉ việc:
- **Họ và tên:** Pham Thanh Tung
- **Tài khoản AD:** `tung.pham`
- **Vị trí:** Trưởng nhóm Bán hàng (Sales Lead)
- **Thời điểm bàn giao chính thức:** 17:30 chiều ngày 25/09/2026.
- **Yêu cầu an ninh:** Thu hồi toàn bộ quyền truy cập hệ thống ngay đúng 17:30; chuyển quyền truy cập hòm thư cho Trưởng phòng Kinh doanh để theo dõi tiếp các hợp đồng còn dở dang; thu hồi laptop công ty và kiểm tra tình trạng vật lý.

---

## 2. QUY TRÌNH THỰC HIỆN KỸ THUẬT (EXECUTION)

### Bước 1: Khóa Quyền Truy Cập Danh Tính (Đúng 17:30)
1. Trên máy chủ Domain Controller `DC01-SRV`:
   - Vô hiệu hóa tài khoản AD (Disable Account):
     ```powershell
     Disable-ADAccount -Identity "tung.pham"
     ```
   - Đổi mật khẩu tài khoản thành một chuỗi ngẫu nhiên dài 32 ký tự để ngăn đăng nhập:
     ```powershell
     Set-ADAccountPassword -Identity "tung.pham" -NewPassword (ConvertTo-SecureString "xK9#mQ2$vL8!zR5%tP4@wN7&yB1*jD3+" -AsPlainText -Force) -Reset
     ```
   - Thu hồi toàn bộ thành viên nhóm bảo mật nhạy cảm:
     ```powershell
     Remove-ADGroupMember -Identity "SG_Sales_Users" -Members "tung.pham" -Confirm:$false
     Remove-ADGroupMember -Identity "SG_VPN_RemoteAccess" -Members "tung.pham" -Confirm:$false
     ```
   - Chuyển tài khoản vào OU lưu trữ tài khoản đã nghỉ việc: `OU=Disabled_Users`.
2. Trên cổng quản trị Microsoft 365 Admin Center:
   - Nhấn **Sign out of all sessions** (Đăng xuất khỏi toàn bộ phiên làm việc trên trình duyệt, điện thoại, máy tính trạm).
   - Chặn đăng nhập (Block sign-in).

### Bước 2: Xử Lý Hòm Thư & Dữ Liệu Công Việc
1. Chuyển đổi hòm thư của nhân viên sang dạng **Shared Mailbox** (Hòm thư dùng chung miễn phí):
   - Thao tác này giúp công ty giữ lại toàn bộ lịch sử email mà không phải tiếp tục trả tiền bản quyền license Microsoft 365 hàng tháng.
2. Cấp quyền đọc hòm thư (Read and Manage / Send As) cho Trưởng phòng Kinh doanh (`nam.le@company.local`).
3. Cấu hình tin nhắn phản hồi tự động (Auto-Reply / Out of Office):
   *"Kính gửi Quý Khách hàng, tôi đã chuyển công tác kể từ ngày 25/09/2026. Để được hỗ trợ các đơn hàng và hợp đồng, xin vui lòng liên hệ Ông Lê Hoàng Nam - Trưởng phòng Kinh doanh tại email: nam.le@company.local hoặc hotline công ty."*
4. Sao lưu toàn bộ dữ liệu OneDrive và máy trạm vào kho lưu trữ mã hóa nội bộ (Retention Policy: lưu trữ tối thiểu 90 ngày trước khi xóa hẳn).

### Bước 3: Thu Hồi và Kiểm Định Thiết Bị Phần Cứng
1. Tiếp nhận thiết bị bàn giao:
   - Laptop Dell Latitude 5420 (Asset Tag: `LP-SL-012`, Serial: `8H2K9L3`).
   - Sạc cáp zin, chuột không dây, túi đựng.
2. Kiểm định kỹ thuật:
   - Màn hình không sọc, không điểm chết. Bàn phím hoạt động đầy đủ các phím. Ổ cứng SSD sức khỏe 98% (kiểm tra qua CrystalDiskInfo).
3. Đăng nhập vào **IT Asset & Helpdesk Portal**:
   - Cập nhật trạng thái của tài sản `LP-SL-012`: Chuyển từ `Assigned (Pham Thanh Tung)` sang `In Storage (Kho IT - Chờ Re-image)`.

---

## 3. KÝ BIÊN BẢN & ĐÓNG TICKET
- Đại diện phòng IT, phòng Nhân sự và nhân sự bàn giao cùng ký vào **Biên bản Hoàn tất Thủ tục Nghỉ việc (IT Offboarding Checklist)**.
- Đóng ticket với đầy đủ biên bản đính kèm, hoàn thành đúng quy trình an ninh doanh nghiệp.
