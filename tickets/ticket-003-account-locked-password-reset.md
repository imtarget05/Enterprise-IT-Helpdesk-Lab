# Incident Ticket #INC-1003 — Account Locked Out & Password Reset

- **Ticket ID:** INC-1003
- **Requester:** Tran Van Binh (Phòng Nhân Sự)
- **Department:** Human Resources
- **Priority:** High
- **Category:** Active Directory / Identity & Access
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ (PROBLEM DESCRIPTION)
Người dùng sáng thứ Hai đến công ty bật máy tính đăng nhập vào tài khoản domain `binh.tran` nhưng màn hình báo lỗi màu đỏ:
*"The referenced account is currently locked out and may not be logged on to."*
Người dùng khẳng định đã gõ đúng mật khẩu nhưng tài khoản vẫn bị khóa cứng.

---

## 2. CHẨN ĐOÁN (DIAGNOSIS)
1. Đăng nhập vào máy chủ Domain Controller `DC01-SRV` bằng tài khoản Domain Admin.
2. Mở công cụ `Active Directory Users and Computers` (`dsa.msc`), tìm đến OU `Company_Enterprise -> Departments -> Human_Resources`.
3. Chuột phải vào tài khoản `binh.tran` -> Properties -> Account:
   - Tùy chọn *"Unlock account. This account is currently locked out on this Active Directory Domain Controller."* đang được tích chọn.
4. Mở `Event Viewer` trên DC01 -> `Windows Logs -> Security`:
   - Lọc Event ID `4740` (A user account was locked out).
   - Chi tiết bản ghi:
     - Target Account: `binh.tran`
     - Caller Computer Name: `WIFI-AP-CORP` / `IP: 192.168.10.215` (Điện thoại iPhone cá nhân của người dùng kết nối Wi-Fi công ty qua chuẩn WPA2-Enterprise 802.1X).

---

## 3. NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE)
Cuối tuần trước, người dùng đã đổi mật khẩu máy tính theo thông báo nhắc nhở 90 ngày của hệ thống. Tuy nhiên, trên điện thoại iPhone cá nhân kết nối Wi-Fi nội bộ bằng tài khoản domain, người dùng quên chưa cập nhật mật khẩu mới. Sáng nay khi bước vào văn phòng, điện thoại tự động bắt Wi-Fi và liên tục gửi thông tin mật khẩu cũ tới máy chủ RADIUS/DC làm vượt quá giới hạn 5 lần nhập sai của GPO Account Lockout Threshold.

---

## 4. CÁC BƯỚC KHẮC PHỤC (RESOLUTION)
1. Hướng dẫn người dùng tạm thời tắt Wi-Fi trên điện thoại cá nhân (hoặc chọn "Forget This Network").
2. Trên máy chủ Domain Controller:
   - Tích chọn "Unlock account" và nhấn Apply.
   - Hỗ trợ người dùng đặt lại mật khẩu tạm thời mới theo đúng độ phức tạp (chữ hoa, thường, số, ký tự đặc biệt) và tích chọn: *"User must change password at next logon"*.
3. Yêu cầu người dùng đăng nhập tại máy tính bàn, hệ thống yêu cầu đổi mật khẩu cá nhân thành công.
4. Hướng dẫn người dùng bật lại Wi-Fi trên điện thoại, nhập mật khẩu mới vừa đổi để xác thực Wi-Fi an toàn.

---

## 5. PHÒNG NGỪA (PREVENTION)
- Soạn cẩm nang hướng dẫn ngắn "Những việc cần làm ngay sau khi đổi mật khẩu máy tính Domain" (cập nhật Wi-Fi điện thoại, Outlook app, Teams).
- Đăng tải cẩm nang lên Cổng thông tin nội bộ của công ty.
