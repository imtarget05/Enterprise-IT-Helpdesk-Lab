# Incident Ticket #INC-1005 — Network Printer Showing Offline

- **Ticket ID:** INC-1005
- **Requester:** Nguyen Van Cuong (Trưởng phòng Hành chính)
- **Department:** Administration
- **Priority:** High
- **Category:** Printing / Hardware
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ (PROBLEM DESCRIPTION)
Cả phòng Hành chính và phòng Kế toán tầng 2 (khoảng 15 nhân viên) không thể in bất kỳ tài liệu hợp đồng nào ra máy in đa chức năng HP LaserJet Enterprise M608. Trên máy tính người dùng, biểu tượng máy in hiển thị trạng thái mờ xám: *"Offline"*.

---

## 2. CHẨN ĐOÁN (DIAGNOSIS)
1. Kiểm tra trực tiếp tại máy in vật lý:
   - Màn hình LCD của máy in vẫn hiển thị trạng thái *"Ready"*, đèn nguồn xanh, khay giấy đầy, không báo kẹt giấy (Paper Jam) hay hết mực.
   - Thao tác in trực tiếp trang cấu hình mạng (Configuration Page) từ menu màn hình máy in thành công.
   - Trên bản in báo cáo: Máy in đang có địa chỉ IP: `192.168.10.145` (do nhận động từ DHCP).
2. Kiểm tra trên máy trạm người dùng:
   - Mở `Printers & Scanners` -> Chuột phải vào máy in -> `Printer Properties` -> Tab `Ports`.
   - Cổng kết nối (Standard TCP/IP Port) đang trỏ tới địa chỉ IP cũ: `192.168.10.25`.
3. Kiểm tra ping:
   - `ping 192.168.10.25` -> Request timed out (Không có thiết bị).
   - `ping 192.168.10.145` -> Phản hồi tốt (< 1ms).

---

## 3. NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE)
Đêm qua văn phòng bị mất điện đột ngột do tòa nhà bảo trì trạm biến áp. Khi có điện lại, máy in khởi động trước và gửi bản tin xin IP tới DHCP Server. Tuy nhiên, do trước đó địa chỉ `192.168.10.25` chưa được tạo **DHCP Reservation** cố định theo địa chỉ MAC của máy in, máy chủ DHCP đã cấp một IP ngẫu nhiên mới trong dải động (`192.168.10.145`). Toàn bộ máy trạm vẫn gửi gói tin in về IP cũ dẫn đến trạng thái Offline hàng loạt.

---

## 4. CÁC BƯỚC KHẮC PHỤC (RESOLUTION)
1. Lấy địa chỉ MAC của máy in từ bản in cấu hình: `00:11:22:33:44:55`.
2. Đăng nhập vào máy chủ DHCP Server `DC01-SRV`:
   - Mở công cụ `DHCP` (`dhcpmgmt.msc`).
   - Mở rộng nhánh `IPv4 -> Scope [192.168.10.0] -> Reservations`.
   - Chuột phải chọn `New Reservation...`:
     - Reservation name: `HP_LaserJet_Enterprise_Floor2`
     - IP address: `192.168.10.25`
     - MAC address: `001122334455`
     - Supported types: Both (DHCP and BOOTP).
3. Khởi động lại card mạng của máy in (hoặc tắt/bật lại nguồn máy in) để máy in xin lại IP:
   - Máy in nhận đúng địa chỉ IP chuẩn: `192.168.10.25`.
4. Trên máy chủ Print Server `FS01-SRV`:
   - Mở `services.msc`, Restart lại dịch vụ `Print Spooler` để xóa sạch các lệnh in rác đang bị nghẽn trong hàng đợi (Queue).
5. Kiểm tra trên máy trạm: Biểu tượng máy in chuyển ngay lập tức sang trạng thái *"Ready"*.

---

## 5. NGHIỆM THU & PHÒNG NGỪA (PREVENTION)
- Gửi lệnh in test từ 3 máy trạm phòng Kế toán và Hành chính -> Máy in in ra tài liệu ngay lập tức sau 2 giây.
- **Biện pháp phòng ngừa:** Rà soát toàn bộ máy in và thiết bị mạng (Switch, AP, Camera, Máy chấm công) trong công ty, bắt buộc phải thiết lập DHCP Reservation cố định theo MAC address trong DHCP Server để chống hiện tượng nhảy IP sau sự cố mất điện.
