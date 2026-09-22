# Incident Ticket #INC-1002 — Cannot Resolve DNS

- **Ticket ID:** INC-1002
- **Requester:** Le Hoang Nam (Phòng Kinh Doanh)
- **Department:** Sales & Marketing
- **Priority:** Medium
- **Category:** DNS / Name Resolution
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ (PROBLEM DESCRIPTION)
Người dùng báo cáo ứng dụng Zalo và Telegram trên máy tính vẫn nhắn tin nhận file bình thường, nhưng khi mở trình duyệt web Chrome và Edge để vào cổng thông tin nội bộ `portal.company.local` và trang web khách hàng thì màn hình báo lỗi: `DNS_PROBE_FINISHED_NXDOMAIN`.

---

## 2. CHẨN ĐOÁN (DIAGNOSIS)
1. Zalo/Telegram vẫn hoạt động chứng tỏ kết nối Internet và định tuyến Layer 3 hoạt động tốt.
2. Kiểm tra ping địa chỉ IP thô: `ping 8.8.8.8` phản hồi tốt (12ms).
3. Kiểm tra ping tên miền: `ping google.com` báo lỗi: *Ping request could not find host google.com. Please check the name and try again.*
4. Chạy `nslookup google.com`:
   - Kết quả: Server: UnKnown, Address: `127.0.0.1`, Query refused / timed out.
5. Kiểm tra `ipconfig /all`:
   - Mục `DNS Servers` đang bị chỉnh tĩnh thành `127.0.0.1`.

---

## 3. NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE)
Người dùng đã cài đặt một phần mềm VPN miễn phí từ trên mạng để truy cập các dịch vụ bị chặn theo vùng địa lý. Phần mềm này đã tự ý can thiệp vào card mạng và thay đổi DNS Server thành `127.0.0.1` (Local Loopback Proxy). Khi phần mềm bị gỡ bỏ không sạch sẽ, cấu hình DNS này bị kẹt lại khiến máy không còn máy chủ nào để phân giải tên miền.

---

## 4. CÁC BƯỚC KHẮC PHỤC (RESOLUTION)
1. Đặt lại cấu hình DNS của card mạng Ethernet về chế độ tự động nhận từ DHCP:
   ```powershell
   Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ResetServerAddresses
   ```
2. Kiểm tra lại `ipconfig /all`: DNS Servers đã nhận đúng IP của Domain Controller: `192.168.10.10`.
3. Xóa sạch bộ nhớ đệm DNS cũ:
   ```cmd
   ipconfig /flushdns
   ```
4. Kiểm tra phân giải tên miền nội bộ và quốc tế:
   ```cmd
   nslookup portal.company.local
   nslookup google.com
   ```
   Cả hai câu lệnh đều trả về địa chỉ IP chuẩn xác trong vòng 5ms.

---

## 5. PHÒNG NGỪA (PREVENTION)
- Triển khai chính sách GPO cấm người dùng không có quyền quản trị (Standard Users) cài đặt phần mềm không rõ nguồn gốc.
- Bật GPO khóa mục chỉnh sửa cấu hình mạng (Network Connections Properties) trong Control Panel.
