# Incident Ticket #INC-1013 — Remote Access VPN Connection Failure

- **Ticket ID:** INC-1013
- **Requester:** Tran Duc Thang (Kỹ sư Hiện trường / Remote Worker)
- **Department:** Engineering & Site Ops
- **Priority:** High
- **Category:** Network / Remote Access VPN
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Nhân viên đang đi công tác tại công trình nhà máy ở Đồng Nai sử dụng laptop kết nối Wi-Fi khách sạn. Khi mở phần mềm VPN Client công ty (FortiClient SSL-VPN / OpenVPN) để truy cập hệ thống quản lý bản vẽ nội bộ, phần mềm dừng lại ở 48% (hoặc 98%) rồi báo lỗi:
*"Unable to establish the VPN connection. The VPN server may be unreachable (-8)."*

---

## 2. CHẨN ĐOÁN
1. Kiểm tra mạng tại khách sạn: Người dùng vẫn lướt web và gọi video Zalo bình thường -> Đường truyền internet của khách sạn hoạt động tốt.
2. Kiểm tra từ phía IT Helpdesk: Các nhân viên khác làm việc tại nhà vẫn kết nối VPN công ty mượt mà -> Hệ thống máy chủ VPN Gateway tại trụ sở chính hoạt động 100% bình thường.
3. Kiểm tra kiểm tra phân giải tên miền máy chủ VPN:
   - Yêu cầu người dùng chạy `nslookup vpn.company.com` trên CMD.
   - Kết quả: Trả về đúng địa chỉ IP Public tĩnh của Firewall công ty `118.69.120.45`.
4. Kiểm tra kết nối cổng dịch vụ (Port Connectivity):
   - Mở PowerShell trên máy người dùng, kiểm tra cổng dịch vụ VPN (cổng HTTPS 443 hoặc 10443):
     ```powershell
     Test-NetConnection -ComputerName vpn.company.com -Port 443
     ```
   - Kết quả: `TcpTestSucceeded : False` (Bị chặn!).
5. Thử phát mạng 4G/5G từ điện thoại di động cá nhân (Personal Hotspot) sang laptop và chạy lại lệnh kiểm tra:
   - Kết quả: `TcpTestSucceeded : True` -> Kết nối VPN thành công ngay lập tức!

---

## 3. NGUYÊN NHÂN GỐC RỄ
Hệ thống mạng Wi-Fi công cộng của khách sạn đã kích hoạt tường lửa hạn chế (Captive Portal / Firewall Policy), thực hiện chặn các cổng VPN và chặn cổng HTTPS tùy chỉnh `TCP 10443` mà phần mềm VPN công ty đang sử dụng mặc định.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Hướng dẫn người dùng phương án xử lý nhanh tức thời: Tiếp tục dùng kết nối chia sẻ từ điểm phát sóng 4G/5G của điện thoại di động để truy cập tải các bản vẽ khẩn cấp cho dự án.
2. Cấu hình giải pháp đường hầm dự phòng trên hệ thống Firewall công ty:
   - Kích hoạt thêm cổng dự phòng **TCP Port 443 (Standard HTTPS)** và **UDP Port 4500 (IPsec NAT-Traversal)** trên VPN Gateway. Vì cổng 443 là cổng web an toàn tiêu chuẩn toàn cầu, hầu hết mọi Wi-Fi khách sạn, sân bay hay quán cafe đều không thể chặn.
3. Thêm hồ sơ cấu hình dự phòng "Company VPN - Port 443 Backup" vào phần mềm FortiClient trên máy tính người dùng.

---

## 5. NGHIỆM THU
Người dùng chuyển laptop quay lại bắt sóng Wi-Fi khách sạn, chọn kết nối qua cổng 443 dự phòng -> Đăng nhập thành công, xác thực 2 bước qua OTP hoàn tất, mở được toàn bộ bản vẽ trên File Server.
