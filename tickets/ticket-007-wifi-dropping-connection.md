# Incident Ticket #INC-1007 — Wi-Fi Dropping & Roaming Disconnects

- **Ticket ID:** INC-1007
- **Requester:** Vo Thi Kim Cuc (Phòng Chăm sóc Khách hàng)
- **Department:** Customer Service
- **Priority:** Medium
- **Category:** Wireless / Network
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Nhân viên sử dụng laptop và tai nghe Bluetooth để gọi điện thoại tư vấn khách hàng qua hệ thống VoIP/Zalo Call. Cứ mỗi lần di chuyển từ bàn làm việc sang khu vực phòng trà hoặc phòng họp tầng 3 là cuộc gọi bị ngắt quãng, rớt mạng Wi-Fi khoảng 20-30 giây rồi mới kết nối lại.

---

## 2. CHẨN ĐOÁN
1. Sử dụng phần mềm phân tích sóng Wi-Fi (Wi-Fi Analyzer) khảo sát tín hiệu tại khu vực hành lang tầng 3:
   - Sóng băng tần 2.4GHz rất mạnh nhưng bị nhiễu kênh (Channel Interference) nghiêm trọng: 3 Access Point (AP) gần nhau đều đang phát chung kênh Channel 6.
   - Sóng băng tần 5GHz có cường độ -68dBm đến -72dBm (ở mức chấp nhận được).
2. Kiểm tra cài đặt Card mạng Wi-Fi trên laptop người dùng:
   - Mở `Device Manager -> Network adapters -> Intel Wi-Fi 6 AX201 -> Properties -> Advanced`.
   - Thông số **Roaming Aggressiveness (Mức độ chuyển vùng)** đang để giá trị mặc định: `3. Medium`.
   - Thông số **Preferred Band (Băng tần ưu tiên)** đang để: `1. No Preference`.

---

## 3. NGUYÊN NHÂN GỐC RỄ
1. Laptop không ưu tiên bắt băng tần 5GHz tốc độ cao mà liên tục cố bám vào sóng 2.4GHz đang bị suy hao và nghẽn kênh do phát sóng trùng kênh giữa các Access Point.
2. Thiết lập chuyển vùng (Roaming) của card mạng quá chậm: Khi người dùng di chuyển xa khỏi AP bàn làm việc, laptop vẫn cố giữ kết nối cho đến khi tín hiệu tụt xuống dưới -85dBm mới chịu tìm kiếm AP mới, gây ra hiện tượng rớt mạng cuộc gọi.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Tối ưu hóa cài đặt trên máy tính người dùng:
   - Chỉnh `Roaming Aggressiveness` từ `3. Medium` lên `5. Highest` (hoặc `4. Medium-High`): Giúp laptop chủ động quét và chuyển sang AP gần nhất ngay khi tín hiệu bắt đầu suy yếu.
   - Chỉnh `Preferred Band` thành `Prefer 5GHz band`: Ép máy tính luôn ưu tiên kết nối băng tần 5GHz thông thoáng.
   - Cập nhật driver card mạng Intel Wi-Fi lên phiên bản mới nhất.
2. Phối hợp với Network Admin tinh chỉnh Access Point:
   - Phân chia lại kênh phát sóng 2.4GHz không chồng lấn: AP1 dùng Kênh 1, AP2 dùng Kênh 6, AP3 dùng Kênh 11.
   - Bật chuẩn hỗ trợ chuyển vùng nhanh 802.11k/r/v trên Wi-Fi Controller.

---

## 5. NGHIỆM THU
Cùng người dùng thực hiện cuộc gọi test vừa đi bộ dọc hành lang tầng 3 -> Cuộc gọi thông suốt, không gián đoạn, thời gian chuyển vùng (Roaming handoff) giảm xuống dưới 50ms, người dùng không hề nhận thấy sự ngắt quãng.
