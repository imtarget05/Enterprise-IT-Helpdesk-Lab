# Incident Ticket #INC-1006 — DHCP IP Conflict & Scope Exhaustion

- **Ticket ID:** INC-1006
- **Requester:** Nguyen Bao Long (Phòng Marketing)
- **Department:** Marketing
- **Priority:** High
- **Category:** Network / DHCP
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Người dùng mang laptop cá nhân đến phòng họp tham gia hội thảo ra mắt sản phẩm mới thì bị mất kết nối mạng. Trên khay hệ thống hiển thị tam giác vàng chấm than kèm thông báo lỗi: *"Windows has detected an IP address conflict with another system on the network"*. Ngay sau đó một nhân viên khác trong phòng họp cũng bị ngắt kết nối.

---

## 2. CHẨN ĐOÁN
1. Chạy lệnh `ipconfig /all` trên máy laptop người dùng:
   - IP đang nhận: `192.168.10.150`.
2. Kiểm tra bảng phân giải địa chỉ ARP từ một máy khác:
   ```cmd
   arp -a | findstr "192.168.10.150"
   ```
   - Phát hiện có 2 bản ghi MAC khác nhau luân phiên phản hồi cho cùng một địa chỉ IP `192.168.10.150`.
3. Kiểm tra máy chủ DHCP `DC01-SRV`:
   - Mở `DHCP Console` -> Scope `[192.168.10.0]`.
   - Kiểm tra mục `Scope Statistics`: Dải cấp phát `192.168.10.100 - 200` đã cấp phát **99/101 địa chỉ (98% In-Use)** -> Scope đang tiệm cận trạng thái cạn kiệt (Scope Exhaustion) do hôm nay có đông khách tham quan hội thảo kết nối Wi-Fi.
   - Một thiết bị Smart TV trong phòng họp đã bị ai đó cấu hình IP tĩnh thủ công `192.168.10.150` nằm đè lên dải cấp phát động của DHCP.

---

## 3. NGUYÊN NHÂN GỐC RỄ
1. Thiết bị TV phòng họp bị cài IP tĩnh nằm trong dải động mà không được khai báo Exclusion.
2. Dải Scope DHCP quá hẹp trong khi thời gian thuê (Lease duration) đặt mặc định quá dài (8 ngày) khiến các thiết bị vãng lai ngắt kết nối rồi nhưng IP vẫn bị giữ chỗ.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Chuyển thiết bị Smart TV sang nhận IP động hoặc gán IP tĩnh nằm ngoài dải DHCP (chuyển sang `192.168.10.35`).
2. Trên máy chủ DHCP:
   - Xóa bỏ các bản ghi thuê IP hết hạn hoặc của thiết bị lạ (De-allocate dead leases).
   - Tách riêng VLAN và SSID cho mạng Khách (Guest Wi-Fi) sang dải mạng riêng `172.16.0.0/22` với Lease Time 4 giờ.
   - Điều chỉnh thời gian thuê của Scope văn phòng xuống còn 24 giờ.
3. Trên máy tính người dùng:
   ```cmd
   ipconfig /release
   ipconfig /renew
   ```
   Máy nhận địa chỉ IP mới sạch sẽ `192.168.10.158`, không còn xung đột.

---

## 5. PHÒNG NGỪA
- Thiết lập tính năng **DHCP Snooping** và **ARP Inspection** trên Core Switch để ngăn chặn việc tự ý gán IP tĩnh trái phép trong mạng LAN.
