# Incident Ticket #INC-1010 — Low Disk Space on System Drive C:

- **Ticket ID:** INC-1010
- **Requester:** Hoang Anh Tuan (Phòng Kế hoạch)
- **Department:** Planning & Operations
- **Priority:** Medium
- **Category:** Storage / Operating System
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Người dùng mở máy tính thấy thanh hiển thị dung lượng ổ đĩa `C:` chuyển sang màu đỏ báo động, dung lượng trống chỉ còn **450 MB trên tổng số 256 GB SSD**. Hệ thống liên tục hiện popup cảnh báo: *"Low Disk Space"*, các file Excel mở lên bị treo và người dùng không thể lưu được file công việc.

---

## 2. CHẨN ĐOÁN
1. Khởi động công cụ phân tích không gian đĩa `TreeSize Free` với quyền Administrator để quét chi tiết toàn bộ cây thư mục ổ C.
2. Bảng phân tích phát hiện các vùng chiếm dụng bất thường:
   - `C:\Windows\SoftwareDistribution\Download`: Chiếm **42 GB** (Chứa hàng chục gói cập nhật Windows Update tích lũy qua nhiều năm bị lỗi tải dở).
   - `C:\Users\tuan.hoang\AppData\Local\Temp`: Chiếm **28 GB** (File rác tạm của các phần mềm văn phòng và trình duyệt chưa được dọn dẹp).
   - `C:\hiberfil.sys`: Chiếm **16 GB** (File lưu trạng thái ngủ đông Hibernate).
   - `C:\System Volume Information`: Chiếm **35 GB** (Các bản sao lưu bóng Volume Shadow Copies tự động sinh ra hàng ngày).

---

## 3. NGUYÊN NHÂN GỐC RỄ
Máy tính của người dùng không được cấu hình chính sách dọn dẹp ổ đĩa định kỳ. Quá trình Windows Update từng nhiều lần bị tắt ngang khi người dùng rút nguồn đột ngột, khiến các file cài đặt tạm không tự động giải phóng.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. **Dọn dẹp Windows Update Cache:**
   - Mở CMD bằng quyền Administrator:
     ```cmd
     net stop wuauserv
     net stop bits
     del /f /s /q C:\Windows\SoftwareDistribution\Download\*.*
     net start wuauserv
     net start bits
     ```
   - Giải phóng ngay: **42 GB**.
2. **Dọn dẹp thư mục tạm hệ thống & người dùng:**
   ```cmd
   del /f /s /q %temp%\*.*
   del /f /s /q C:\Windows\Temp\*.*
   ```
   - Giải phóng: **28 GB**.
3. **Quản lý Shadow Copies (VSSAdmin):**
   - Giới hạn kích thước tối đa dành cho điểm khôi phục hệ thống (System Restore Point) xuống 5% dung lượng ổ:
     ```cmd
     vssadmin resize shadowstorage /for=C: /on=C: /maxsize=10GB
     ```
   - Giải phóng: **25 GB**.
4. **Tắt tính năng ngủ đông Hibernate (vì đây là máy tính bàn để bàn, không cần thiết):**
   ```cmd
   powercfg -h off
   ```
   - Tự động xóa file `hiberfil.sys`, giải phóng ngay: **16 GB**.
5. Chạy công cụ Disk Cleanup chuyên sâu:
   ```cmd
   cleanmgr /VERYLOWDISK
   ```

---

## 5. NGHIỆM THU
Kiểm tra lại ổ đĩa `C:` sau khi dọn dẹp:
- Dung lượng khả dụng trống tăng từ **450 MB lên 118 GB** (vạch hiển thị trở lại màu xanh bình thường).
- Máy tính khởi động nhanh, ứng dụng Office lưu file mượt mà, không còn cảnh báo lỗi.

---

## 6. PHÒNG NGỪA
- Triển khai tác vụ lập lịch (Task Scheduler) qua GPO hàng tháng tự động chạy script dọn dẹp các thư mục Temp cho toàn bộ máy trạm trong công ty.
