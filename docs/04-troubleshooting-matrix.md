# Enterprise IT Helpdesk Lab — Technical Troubleshooting Matrix

Ma trận chẩn đoán và khắc phục sự cố kỹ thuật nhanh theo mô hình 7 tầng OSI và chuẩn vận hành ITIL.

---

## 1. CÂY CHẨN ĐOÁN SỰ CỐ MẠNG (NETWORK DIAGNOSTIC TREE)

```text
[Người dùng mất kết nối Internet / Mạng nội bộ]
                      │
                      ▼
[Bước 1: Layer 1 - Physical]
- Kiểm tra đèn link card mạng (RJ45 vàng/xanh sáng nhấp nháy không?)
- Kiểm tra cáp mạng có bị gãy lẫy, tuột khỏi ổ cắm tường (Wallplate) không?
- Với Wi-Fi: Card Wi-Fi có bị bật chế độ Airplane mode hoặc phím cứng tắt không?
                      │ (Physical OK)
                      ▼
[Bước 2: Layer 2 & 3 - Data Link & Network]
- Chạy: ipconfig /all
  ├─ Nhận IP 169.254.x.x (APIPA)? -> Mất kết nối DHCP Server / VLAN sai.
  ├─ Nhận IP 0.0.0.0 hoặc Disconnected? -> Cáp hỏng hoặc Driver card mạng lỗi.
  └─ Nhận đúng IP 192.168.10.x? -> Tiếp tục.
                      │
                      ▼
[Bước 3: Ping kiểm tra phân đoạn mạng]
- Ping 127.0.0.1 (Loopback) -> Kiểm tra ngăn xếp TCP/IP hệ điều hành.
- Ping [IP Gateway: 192.168.10.2] -> Kiểm tra kết nối từ PC đến Router cục bộ.
- Ping 8.8.8.8 -> Kiểm tra luồng Internet ra thế giới bên ngoài.
                      │
                      ▼
[Bước 4: Layer 7 - Application / DNS]
- Ping được 8.8.8.8 nhưng KHÔNG ping được google.com?
  └─ Lỗi DNS! Chạy `nslookup google.com`, đổi DNS Server hoặc `ipconfig /flushdns`.
```

---

## 2. BẢNG MA TRẬN KHẮC PHỤC SỰ CỐ PHỔ BIẾN

| Sự Cố | Dấu hiệu nhận biết | Nguyên nhân gốc rễ (Root Cause) | Các bước xử lý chuẩn (Standard Fix) |
|---|---|---|---|
| **Lỗi phân giải tên miền (DNS)** | Lướt web báo "DNS_PROBE_FINISHED_BAD_CONFIG", các ứng dụng chat dùng IP vẫn chạy được. | - Cache DNS cục bộ lưu bản ghi cũ bị hỏng.<br>- DNS Server nội bộ (DC01) bị treo dịch vụ.<br>- Card mạng bị cấu hình DNS tĩnh sai. | 1. `ipconfig /flushdns`<br>2. Chạy `nslookup [domain]` kiểm tra máy chủ phân giải.<br>3. Kiểm tra service `DNS` trên máy chủ DC01.<br>4. Đặt lại chế độ nhận DNS tự động từ DHCP. |
| **Xung đột IP (IP Conflict)** | Windows hiển thị thông báo "There is an IP address conflict with another system on the network". | Hai thiết bị (thường là 1 máy đặt IP tĩnh vô tội vạ) dùng chung 1 địa chỉ IP trong cùng subnet. | 1. Chạy `arp -a` tìm địa chỉ MAC của thiết bị gây xung đột.<br>2. Chạy `ipconfig /release` và `ipconfig /renew` để cấp IP mới sạch sẽ từ DHCP.<br>3. Xác định thiết bị đặt IP tĩnh thủ công và chuyển sang DHCP Reservation. |
| **Máy in mạng báo Offline** | Người dùng gửi lệnh in nhưng máy in ở trạng thái Offline trong Devices and Printers. | - Máy in bị đổi IP do DHCP cấp lại IP khác.<br>- Print Spooler service trên Windows bị treo.<br>- Dây mạng máy in bị lỏng hoặc kẹt giấy. | 1. Ping IP của máy in từ máy trạm.<br>2. Mở `services.msc`, Restart service `Print Spooler`.<br>3. Vào Properties máy in -> Ports -> Cấu hình Standard TCP/IP Port trỏ đúng IP cố định hoặc tạo DHCP Reservation cố định cho máy in. |
| **Tài khoản AD bị khóa (Account Locked)** | Màn hình đăng nhập báo "The referenced account is currently locked out and may not be logged on to". | Người dùng nhập sai mật khẩu quá 5 lần quy định trong GPO (thường do đổi pass trên máy tính nhưng điện thoại/Outlook còn lưu mật khẩu cũ). | 1. Mở Active Directory Users and Computers trên DC01.<br>2. Tìm User -> Chuột phải Properties -> Account -> Tích chọn "Unlock account".<br>3. Yêu cầu người dùng cập nhật mật khẩu mới trên Wi-Fi điện thoại và ứng dụng email. |
| **Màn hình xanh chết chóc (BSOD)** | Máy tính tự khởi động lại, màn hình xanh hiện mã lỗi (CRITICAL_PROCESS_DIED, MEMORY_MANAGEMENT). | - Lỗi phần cứng (thanh RAM bẩn/lỗi, ổ cứng có Bad Sector).<br>- Driver card đồ họa hoặc chipset bị xung đột sau bản update Windows. | 1. Khởi động vào Safe Mode.<br>2. Dùng công cụ `BlueScreenView` hoặc `WinDbg` đọc file minidump tại `C:\Windows\Minidump`.<br>3. Chạy lệnh quét hệ thống `sfc /scannow` và `dism /online /cleanup-image /restorehealth`.<br>4. Chạy `chkdsk C: /f /r` và công cụ Windows Memory Diagnostic kiểm tra RAM. |
| **Ổ đĩa C bị đầy đỏ (Low Disk Space)** | Windows báo "Low Disk Space", máy chạy chậm chạp, không mở được file tạm. | Thư mục `C:\Windows\Temp`, thư mục cập nhật `SoftwareDistribution`, hoặc file `hiberfil.sys`/`pagefile.sys` chiếm quá nhiều dung lượng. | 1. Chạy `Cleanmgr /sageset:1` (Disk Cleanup chuẩn quản trị).<br>2. Dừng Windows Update service, xóa toàn bộ file tải dở trong `C:\Windows\SoftwareDistribution\Download`.<br>3. Dùng công cụ `TreeSize Free` hoặc PowerShell tìm các file log rác khổng lồ để dọn dẹp. |
