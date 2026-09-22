# Incident Ticket #INC-1009 — BSOD System Crash Analysis (MEMORY_MANAGEMENT)

- **Ticket ID:** INC-1009
- **Requester:** Doan Minh Tri (Phòng Thiết Kế Đồ Họa)
- **Department:** Graphic Design & Multimedia
- **Priority:** High
- **Category:** Hardware / System Stability
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Máy trạm đồ họa (Dell Precision Tower) của nhà thiết kế liên tục bị sập nguồn đột ngột, hiện màn hình xanh chết chóc (BSOD) từ 2 đến 3 lần mỗi ngày, đặc biệt là khi đang kết xuất (render) video 4K trên phần mềm Adobe Premiere và After Effects. Người dùng bị mất dữ liệu chỉnh sửa nhiều lần.

---

## 2. CHẨN ĐOÁN
1. Khởi động máy trạm, mở thư mục `C:\Windows\Minidump` để tìm các file bản ghi sự cố crash dump gần nhất.
2. Sao chép file `092226-14520-01.dmp` và sử dụng công cụ phân tích chuyên dụng `BlueScreenView` / `WinDbg`:
   - Bug Check String: `MEMORY_MANAGEMENT`
   - Bug Check Code: `0x0000001A`
   - Caused By Driver: `ntoskrnl.exe` (Thành phần nhân hệ điều hành xử lý phân phối bộ nhớ RAM).
3. Kiểm tra toàn vẹn file hệ thống Windows:
   - Chạy `sfc /scannow` -> *Windows Resource Protection did not find any integrity violations.* (Hệ điều hành không bị lỗi file).
4. Kiểm tra bộ nhớ vật lý (RAM Diagnostic):
   - Mở công cụ `Windows Memory Diagnostic` (`mdsched.exe`), chọn khởi động lại máy để quét sâu kiểm tra bộ nhớ.
   - Kết quả hiển thị sau khi quét 15%: *"Hardware problems were detected. To identify and repair these problems, you will need to contact the computer manufacturer."* -> Khẳng định có lỗi phần cứng trên thanh RAM!

---

## 3. NGUYÊN NHÂN GỐC RỄ
Máy trạm được trang bị 2 thanh RAM DDR4 16GB chạy chế độ Dual Channel. Một trong 2 thanh RAM (thanh cắm tại Slot DIMM 2) đã bị lỗi ô nhớ vật lý (Memory Bit Flip). Khi ứng dụng đồ họa Premiere yêu cầu dung lượng RAM vượt quá 16GB, hệ điều hành ghi dữ liệu vào vùng ô nhớ hỏng trên thanh RAM thứ 2 dẫn đến sập kernel và kích hoạt mã lỗi BSOD 0x1A để bảo vệ dữ liệu đĩa.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Tắt nguồn máy tính, rút dây điện nguồn, xả tĩnh điện trên tay bằng vòng chống tĩnh điện (ESD Wrist Strap).
2. Mở nắp thùng máy, tháo thanh RAM ở Slot DIMM 2 ra.
3. Chạy lại công cụ kiểm tra bộ nhớ sâu `MemTest86` với riêng từng thanh RAM:
   - Thanh RAM 1 (Slot 1): Pass 4/4 vòng test với 0 lỗi.
   - Thanh RAM 2 (Slot 2): Báo 128 lỗi ô nhớ chỉ sau 2 phút chạy test -> Xác nhận thanh RAM 2 bị hỏng.
4. Lấy thanh RAM dự phòng cùng thông số kỹ thuật (DDR4 3200MHz 16GB Samsung ECC) từ kho linh kiện IT ra thay thế vào Slot 2.
5. Vệ sinh khe cắm RAM bằng bình xịt khí nén chuyên dụng và cắm chặt thanh RAM mới (nghe 2 tiếng "click" chắc chắn).
6. Khởi động lại máy trạm, chạy kiểm tra `MemTest86` đủ 2 thanh: Pass 100% không còn lỗi nào.

---

## 5. NGHIỆM THU
Giao máy cho nhân viên thiết kế mở file dự án After Effects nặng và chạy render liên tục trong 2 giờ -> CPU tải 100%, RAM sử dụng 28/32GB, máy hoạt động mát mẻ ổn định, nhiệt độ trong ngưỡng an toàn (65°C), không còn hiện tượng crash màn hình xanh.
