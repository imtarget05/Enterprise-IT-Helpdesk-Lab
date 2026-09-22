# Request Ticket #REQ-2014 — New Laptop Provisioning & Employee Onboarding

- **Ticket ID:** REQ-2014
- **Requester:** Nguyen Thi Hoa (Chuyên viên Tuyển dụng HR)
- **Department:** Human Resources
- **Priority:** Medium
- **Category:** Hardware Provisioning / Onboarding
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ YÊU CẦU (SERVICE REQUEST)
Tiếp nhận nhân sự mới:
- **Họ và tên:** Nguyen Hoang Phuc
- **Vị trí:** Chuyên viên Phân tích Dữ liệu (Data Analyst)
- **Phòng ban:** Business Intelligence / Kinh Doanh
- **Ngày bắt đầu làm việc:** Thứ Hai tuần tới (28/09/2026)
- **Yêu cầu trang bị:** 01 Laptop cấu hình mạnh (Core i7 / 16GB RAM / SSD 512GB), màn hình rời 27 inch, tài khoản AD, email doanh nghiệp và quyền truy cập kho dữ liệu báo cáo.

---

## 2. QUY TRÌNH THỰC HIỆN KỸ THUẬT (EXECUTION)

### Bước 1: Khởi tạo Danh tính & Tài khoản Người dùng
1. Mở PowerShell trên Domain Controller `DC01-SRV`, thực thi script tự động hóa:
   ```powershell
   New-ADUser -Name "Nguyen Hoang Phuc" `
              -GivenName "Phuc" -Surname "Nguyen Hoang" `
              -SamAccountName "phuc.nguyen" `
              -UserPrincipalName "phuc.nguyen@company.local" `
              -Path "OU=Sales_Marketing,OU=Departments,OU=Company_Enterprise,DC=company,DC=local" `
              -AccountPassword (ConvertTo-SecureString "Welcome2026#Temp" -AsPlainText -Force) `
              -ChangePasswordAtLogon $true `
              -Enabled $true `
              -Department "Business Intelligence" `
              -Title "Data Analyst"
   ```
2. Thêm vào các nhóm bảo mật tương ứng:
   ```powershell
   Add-ADGroupMember -Identity "SG_Sales_Users" -Members "phuc.nguyen"
   Add-ADGroupMember -Identity "SG_VPN_RemoteAccess" -Members "phuc.nguyen"
   ```

### Bước 2: Cấp phát Bản quyền Phần mềm & Hòm thư
- Đăng nhập Microsoft 365 Admin Center: Gán bản quyền `Microsoft 365 Business Standard` (bao gồm Outlook, Excel, PowerPoint, Teams, OneDrive 1TB).
- Cấu hình bắt buộc kích hoạt MFA qua Microsoft Authenticator trong lần đăng nhập đầu tiên.

### Bước 3: Cài đặt và Đóng gói Thiết bị Phần cứng (Laptop Provisioning)
1. Lấy laptop ThinkPad T14 Gen 4 từ kho thiết bị IT:
   - Serial Number: `PF-39X8K2`
   - Dán tem nhãn quản lý tài sản: **Asset Tag: `LP-BI-005`**.
2. Triển khai bản cài đặt hệ điều hành chuẩn qua Windows Deployment Services (WDS) / USB Image chuẩn:
   - Windows 11 Pro 64-bit sạch, đã cài đầy đủ trình điều khiển (Drivers).
   - Bộ phần mềm chuẩn: Microsoft 365 Apps, Chrome, 7-Zip, Adobe Acrobat Reader, Endpoint Antivirus Agent, FortiClient VPN, Power BI Desktop, DBeaver.
3. Join máy tính vào Domain:
   ```cmd
   netdom join LP-BI-005 /domain:company.local /userd:admin /passwordd:*
   ```
   Chuyển tài khoản máy tính vào đúng `OU=Workstations`.
4. Cập nhật thông tin máy tính và gán cho nhân sự `Nguyen Hoang Phuc` trong cơ sở dữ liệu **IT Asset & Helpdesk Portal**.

---

## 3. BÀN GIAO & KÝ BIÊN BẢN (HANDOVER)
Sáng thứ Hai, nhân viên mới đến nhận việc:
1. IT trực tiếp hướng dẫn nhân viên đăng nhập lần đầu, đổi mật khẩu tạm thời sang mật khẩu bảo mật cá nhân.
2. Hướng dẫn thiết lập MFA trên điện thoại và kiểm tra mở các ổ đĩa mạng dùng chung.
3. Ký xác nhận **Biên bản Bàn giao Thiết bị CNTT (IT Asset Acceptance Form)** gồm: 01 Laptop ThinkPad kèm sạc type-C, 01 chuột không dây, 01 balo chống sốc và 01 màn hình Dell 27 inch kèm dây cáp HDMI.
4. Đóng ticket thành công đúng SLA cam kết.
