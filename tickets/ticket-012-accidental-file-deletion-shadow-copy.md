# Incident Ticket #INC-1012 — Accidental File Deletion & Shadow Copy Recovery

- **Ticket ID:** INC-1012
- **Requester:** Nguyen Thi Hong (Kế toán Trưởng)
- **Department:** Accounting & Finance
- **Priority:** High
- **Category:** File Server / Data Recovery
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Kế toán trưởng gọi điện thoại trong trạng thái hoảng loạn: Trong lúc dọn dẹp các bảng tính cũ trên thư mục chia sẻ mạng `\\FS01\Accounting\BaoCaoTaiChinh_2026`, nhân viên đã chọn nhầm và bấm `Shift + Delete` làm mất vĩnh viễn file bảng tính Excel `BaoCao_Thue_Q3_Final.xlsx`. File này chứa toàn bộ số liệu quyết toán thuế của công ty sắp nộp trong ngày mai và không có trong thùng rác Recycle Bin của máy trạm.

---

## 2. CHẨN ĐOÁN
1. Do file được lưu trên ổ đĩa mạng chia sẻ (Network Share), khi xóa từ máy client, giao thức SMB sẽ xóa trực tiếp trên File Server mà **KHÔNG** đưa vào thùng rác cục bộ của máy tính người dùng.
2. Đăng nhập vào máy chủ File Server `FS01-SRV`:
   - Mở ổ đĩa chứa dữ liệu chia sẻ `D:\Shares\Accounting`.
   - Kiểm tra tính năng **Volume Shadow Copies (VSS)** trên ổ `D:`:
     - Tính năng Shadow Copies đã được IT cấu hình chụp bản sao định kỳ tự động 2 lần mỗi ngày: 7h00 sáng và 12h00 trưa.
     - Thời điểm hiện tại là 14h30 chiều. Bản chụp Shadow Copy gần nhất là lúc **12:00 PM** trưa nay (cách thời điểm bị xóa chỉ 2.5 giờ).

---

## 3. NGUYÊN NHÂN GỐC RỄ
Thao tác sơ suất của người dùng khi chọn nhiều file để xóa trên ổ đĩa chia sẻ mạng.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Trên máy chủ File Server `FS01-SRV` (hoặc trực tiếp từ máy trạm của Kế toán trưởng):
   - Mở File Explorer, tìm đến thư mục `\\FS01\Accounting`.
   - Chuột phải vào thư mục con `BaoCaoTaiChinh_2026` -> Chọn `Properties`.
   - Chuyển sang tab **Previous Versions (Phiên bản trước)**.
2. Danh sách các bản sao hiển thị:
   - Bản chụp: `Hôm nay, 23/09/2026 - 12:00 PM`.
3. Bấm nút **Open (Mở)** để duyệt nội dung bên trong bản sao lưu lúc 12h00 trưa:
   - File `BaoCao_Thue_Q3_Final.xlsx` hiển thị nguyên vẹn đầy đủ dung lượng (4.8 MB).
4. Thực hiện copy file từ cửa sổ Previous Versions và dán (Paste) trở lại thư mục làm việc hiện tại:
   - Đặt tên phục hồi: `BaoCao_Thue_Q3_Final_RECOVERED.xlsx`.

---

## 5. NGHIỆM THU
Kế toán trưởng mở file đã phục hồi bằng Excel:
- Toàn bộ công thức, macro và số liệu tính toán đến thời điểm 12h00 trưa nay nguyên vẹn 100%.
- Kế toán trưởng chỉ mất thêm khoảng 15 phút nhập lại vài dòng phát sinh đầu giờ chiều, cứu nguy cho kỳ nộp thuế quan trọng.

---

## 6. PHÒNG NGỪA
- Rà soát lại dung lượng cấp cho Shadow Copies trên `FS01-SRV` để duy trì lưu trữ ít nhất 30 ngày bản sao.
- Bật tính năng thùng rác mạng (Network Recycle Bin) nếu chuyển sang sử dụng thiết bị NAS chuyên dụng.
