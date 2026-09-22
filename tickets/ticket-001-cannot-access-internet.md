# Incident Ticket #INC-1001 — Cannot Access Internet

- **Ticket ID:** INC-1001
- **Requester:** Nguyen Thi Mai (Phòng Kế toán)
- **Department:** Accounting & Finance
- **Priority:** High
- **Category:** Network / Connectivity
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ (PROBLEM DESCRIPTION)
Người dùng báo cáo máy tính bàn tại bàn làm việc không thể truy cập bất kỳ trang web nào (báo lỗi trên trình duyệt: "Không có kết nối Internet"). Phần mềm kế toán MISA và hóa đơn điện tử không thể gửi dữ liệu, làm chậm tiến độ xuất hóa đơn cuối ngày.

---

## 2. CHẨN ĐOÁN BAN ĐẦU (DIAGNOSIS)
1. Hỏi thăm các máy tính xung quanh: Các đồng nghiệp cùng phòng Kế toán vẫn lướt web và làm việc bình thường -> Sự cố chỉ xảy ra cục bộ trên máy tính của người dùng (Client-side issue).
2. Kiểm tra vật lý (Layer 1): Đèn LED cổng mạng RJ45 phía sau thùng máy vẫn sáng xanh và nhấp nháy vàng. Cáp mạng cắm chắc chắn vào ổ cắm trên tường (Wallplate).
3. Kiểm tra cấu hình IP (Layer 2 & 3):
   - Mở Command Prompt (`cmd.exe`), chạy `ipconfig /all`.
   - Kết quả: Máy nhận IP `169.254.88.14`, Subnet Mask `255.255.0.0`, Default Gateway bị trống.
4. Nhận diện vấn đề: Máy tính đang nhận dải địa chỉ tự gán **APIPA**, chứng tỏ máy không nhận được phản hồi gói tin DHCP Offer từ máy chủ cấp IP `DC01-SRV`.

---

## 3. NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE)
Dịch vụ DHCP Client trên máy người dùng bị xung đột sau khi Windows tự động cập nhật bản vá driver card mạng Realtek đêm qua, khiến card mạng bị treo trong trạng thái đàm phán cấp phát (Negotiation timeout).

---

## 4. CÁC BƯỚC KHẮC PHỤC (RESOLUTION)
1. Thử xin cấp lại IP qua lệnh chuẩn:
   ```cmd
   ipconfig /release
   ipconfig /renew
   ```
   Lệnh báo lỗi: *An error occurred while renewing interface Ethernet : The operation timed out.*
2. Mở `services.msc` bằng quyền Administrator:
   - Tìm dịch vụ `DHCP Client`.
   - Khởi động lại dịch vụ (Restart Service).
3. Reset lại ngăn xếp mạng TCP/IP và Winsock Catalog:
   ```cmd
   netsh winsock reset
   netsh int ip reset
   ```
4. Khởi động lại máy tính.
5. Sau khi máy khởi động lại, chạy `ipconfig /all`:
   - IPv4 Address: `192.168.10.124` (Được cấp thành công từ DHCP Server `192.168.10.10`).
   - Default Gateway: `192.168.10.2`.
   - DNS Servers: `192.168.10.10`.

---

## 5. NGHIỆM THU (VERIFICATION)
- Ping kiểm tra Default Gateway: `ping 192.168.10.2 -n 4` -> 0% packet loss, latency < 1ms.
- Ping kiểm tra DNS: `ping 8.8.8.8` và `ping company.local` -> Phản hồi tốt.
- Mở trình duyệt Chrome truy cập thử trang hóa đơn điện tử và trang web tin tức -> Tải trang mượt mà trong 1 giây.

---

## 6. PHÒNG NGỪA (PREVENTION)
- Đưa mã lỗi cập nhật driver vào cơ sở dữ liệu IT Knowledge Base.
- Cấu hình GPO hoãn các bản cập nhật Driver tự động từ Windows Update trên toàn bộ OU Workstations để IT kiểm thử trước khi phân phối hàng loạt.
