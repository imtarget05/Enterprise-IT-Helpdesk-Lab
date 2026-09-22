# Incident Ticket #INC-1019 — VoIP IP Phone SIP Registration Failure

- **Ticket ID:** INC-1019
- **Requester:** Le Thi Bich (Trưởng quầy Lễ tân & Tổng đài)
- **Department:** Front Desk & Reception
- **Priority:** High
- **Category:** Telephony / VoIP / SIP
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Điện thoại bàn IP Phone (Grandstream GXP2170 / Yealink T46U) đặt tại quầy lễ tân không thể nhận hoặc thực hiện bất kỳ cuộc gọi nào từ khách hàng bên ngoài. Trên màn hình LCD màu của điện thoại, biểu tượng tài khoản máy lẻ (Ext 101) nhấp nháy đèn đỏ và hiển thị dòng chữ cảnh báo: *"Registering..."* hoặc *"Registration Failed (408 Request Timeout)"*.

---

## 2. CHẨN ĐOÁN
1. Kiểm tra nguồn và dây cáp mạng (Layer 1): Điện thoại nhận nguồn qua cổng mạng PoE (Power over Ethernet) từ Switch Cisco, màn hình sáng tốt, dây cáp mạng cắm chặt.
2. Kiểm tra địa chỉ IP trên điện thoại:
   - Vào menu điện thoại -> Status -> Network:
     - IP Address: `192.168.10.185` (Đang nằm chung dải VLAN 10 của mạng máy tính văn phòng!).
   - Theo thiết kế mạng của công ty, điện thoại VoIP bắt buộc phải nhận IP thuộc dải **Voice VLAN 20** (`192.168.20.0/24`) để được ưu tiên đường truyền QoS và có đường định tuyến mở cổng sang tổng đài ảo IP PBX Cloud.
3. Kiểm tra cổng Switch cắm dây mạng của quầy lễ tân (Cisco Catalyst 2960):
   - Mở giao diện dòng lệnh của Switch qua SSH:
     ```text
     Switch# show running-config interface GigabitEthernet0/12
     ```
   - Cấu hình hiện tại của cổng:
     ```text
     interface GigabitEthernet0/12
      switchport mode access
      switchport access vlan 10
     ```
   - Thiếu hoàn toàn dòng cấu hình Voice VLAN: `switchport voice vlan 20`!
4. Do nằm ở VLAN Data 10, tường lửa Firewall nội bộ đã chặn các cổng giao thức thoại SIP (UDP 5060) và cổng âm thanh RTP (UDP 10000 - 20000) đi ra ngoài tổng đài để đảm bảo an ninh mạng máy tính.

---

## 3. NGUYÊN NHÂN GỐC RỄ
Tuần trước, tổ cơ điện đã di dời bàn quầy lễ tân sang vị trí sảnh mới và cắm dây mạng của điện thoại vào một ổ cắm mạng tường khác (Port Gi0/12). Cổng mạng này trước đây vốn chỉ được cấu hình làm cổng mạng máy tính thông thường (VLAN 10) mà chưa được bật tính năng Voice VLAN.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Đăng nhập vào Switch Cisco trung tâm qua tài khoản quản trị mạng:
2. Cấu hình lại cổng kết nối `GigabitEthernet0/12`:
   ```text
   Switch# configure terminal
   Switch(config)# interface GigabitEthernet0/12
   Switch(config-if)# description "Reception_IP_Phone_Ext101"
   Switch(config-if)# switchport mode access
   Switch(config-if)# switchport access vlan 10
   Switch(config-if)# switchport voice vlan 20
   Switch(config-if)# spanning-tree portfast
   Switch(config-if)# end
   Switch# write memory
   ```
3. Rút dây mạng ra và cắm lại vào cổng LAN của điện thoại IP Phone:
   - Điện thoại gửi bản tin nhận diện LLDP-MED / CDP.
   - Switch tự động gán điện thoại vào Voice VLAN 20.
   - Máy chủ DHCP cấp địa chỉ IP thoại mới: `192.168.20.22`.
4. Điện thoại gửi bản tin đăng ký `SIP REGISTER` tới máy chủ IP PBX qua cổng UDP 5060:
   - Màn hình điện thoại hiển thị biểu tượng điện thoại màu xanh lá cây kèm dòng chữ: *"Registered - Ext 101"*.

---

## 5. NGHIỆM THU
- Lấy điện thoại di động gọi thử vào số hotline công ty: Điện thoại bàn đổ chuông ngay lập tức, nhấc máy nghe gọi âm thanh to rõ, hai chiều đàm thoại không bị rè hay mất tiếng.
- Bấm gọi nội bộ từ Ext 101 sang Ext 102 (Phòng Giám đốc) -> Đổ chuông thông suốt.
