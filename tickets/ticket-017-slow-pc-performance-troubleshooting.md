# Incident Ticket #INC-1017 — Slow PC Performance & Thermal Throttling

- **Ticket ID:** INC-1017
- **Requester:** Tran Quoc Khanh (Phòng Pháp Chế)
- **Department:** Legal & Compliance
- **Priority:** Low
- **Category:** Hardware / Performance Optimization
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Nhân viên phàn nàn laptop Dell Latitude làm việc rất chậm, mất hơn 3 phút mới khởi động xong Windows, gõ văn bản trên Microsoft Word bị giật lag trễ phím (Input Lag) và quạt tản nhiệt của máy liên tục hú to ở tốc độ tối đa phát ra tiếng ồn lớn, mặt đáy máy rất nóng.

---

## 2. CHẨN ĐOÁN
1. Mở Task Manager (`Ctrl + Shift + Esc`) kiểm tra tài nguyên:
   - Tab Performance -> CPU: Xung nhịp CPU bị kẹt cứng ở mức cực thấp **0.79 GHz** (trong khi xung nhịp gốc là 2.60 GHz Boost 4.40 GHz). Mức sử dụng CPU luôn hiển thị 100%.
   - Đây là dấu hiệu kinh điển của cơ chế bảo vệ nhiệt độ: **CPU Thermal Throttling** (Hệ thống tự động hạ xung nhịp CPU xuống mức tối thiểu để tránh quá nhiệt làm cháy chip).
2. Sử dụng phần mềm `HWMonitor` kiểm tra cảm biến nhiệt độ:
   - Nhiệt độ CPU đạt **98°C - 100°C** ngay cả khi không chạy ứng dụng nặng nào.
3. Kiểm tra mục `Startup apps` trong Task Manager:
   - Có 14 ứng dụng tự động khởi động cùng Windows (Spotify, Zalo, Viber, Skype, Cortana, Adobe Updater, Steam...).

---

## 3. NGUYÊN NHÂN GỐC RỄ
1. Laptop đã sử dụng liên tục hơn 2 năm tại văn phòng nhưng chưa từng được bảo dưỡng vệ sinh định kỳ. Khe tản nhiệt bằng đồng và cánh quạt bị bám một lớp bụi dày đặc bít kín luồng khí lưu thông. Lớp keo tản nhiệt gốc của CPU đã bị khô cứng, mất hoàn toàn khả năng truyền nhiệt lên ống đồng tản nhiệt.
2. Quá nhiều phần mềm rác chạy ngầm cùng Windows làm ngốn bộ nhớ RAM và chu kỳ xử lý CPU.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. **Bảo dưỡng phần cứng chuyên sâu:**
   - Tắt nguồn, tháo nắp lưng laptop, ngắt kết nối giắc cắm Pin (Battery connector).
   - Tháo cụm ống đồng tản nhiệt (Heatpipe) và quạt.
   - Dùng cọ mềm và bình xịt khí nén làm sạch toàn bộ bụi bẩn bám trên cánh quạt và khe gió tản nhiệt.
   - Dùng cồn Isopropyl Alcohol (IPA 99%) lau sạch lớp keo tản nhiệt cũ đã khô trên mặt lưng CPU die.
   - Bôi lớp keo tản nhiệt cao cấp mới (Thermal Grizzly / Arctic MX-4) theo lượng vừa đủ bằng hạt đậu xanh.
   - Lắp lại cụm tản nhiệt, siết ốc đối xứng theo thứ tự số in trên khung đồng (1-2-3-4).
2. **Tối ưu hóa hệ điều hành Windows:**
   - Mở Task Manager -> Tab `Startup apps`: Tắt (Disable) toàn bộ các phần mềm không cần thiết khi khởi động máy.
   - Chạy lệnh tối ưu hóa ổ cứng SSD (TRIM command):
     ```powershell
     Optimize-Volume -DriveLetter C -Defrag -Verbose
     ```

---

## 5. NGHIỆM THU
- Khởi động lại máy: Thời gian nạp Windows từ lúc bấm nguồn đến màn hình Desktop chỉ còn **12 giây** (giảm từ 3 phút).
- Kiểm tra nhiệt độ CPU bằng `HWMonitor`: Khi chạy văn phòng chỉ dao động từ **42°C đến 48°C** (giảm hơn 50°C).
- Xung nhịp CPU tự động tăng vọt linh hoạt lên **3.80 - 4.20 GHz** khi mở ứng dụng, gõ phím Word hoàn toàn không còn độ trễ, quạt máy quay êm ái không phát ra tiếng ồn.
