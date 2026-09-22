# Incident Ticket #INC-1020 — Automated Backup Job Failure & Test Recovery Drill

- **Ticket ID:** INC-1020
- **Requester:** Automated Monitoring System (Veeam Backup & Replication)
- **Department:** IT Infrastructure & Operations
- **Priority:** Critical
- **Category:** Backup & Disaster Recovery (DR)
- **Status:** Resolved
- **Assigned To:** IT Helpdesk & System Administrator

---

## 1. MÔ TẢ SỰ CỐ
Vào lúc 03:15 sáng, hệ thống giám sát tự động gửi email cảnh báo đỏ khẩn cấp tới hộp thư `it-alerts@company.local`:
*"CRITICAL ALERT: Nightly Backup Job [Daily_FileServer_FS01] failed with Exit Code: 1. Error: Cannot create VSS snapshot on volume D:. The Volume Shadow Copy Service provider error (0x80042306)."*
Toàn bộ dữ liệu của máy chủ File Server `FS01-SRV` đêm qua không có bản sao lưu nào được tạo ra!

---

## 2. CHẨN ĐOÁN
1. Đăng nhập vào máy chủ File Server `FS01-SRV` với quyền Administrator.
2. Mở `Event Viewer -> Application Log`:
   - Tìm Event Source `VSS` (Volume Shadow Copy Service) và `VSSWriter`.
   - Phát hiện Event ID `8193` và Event ID `12289`: *Volume Shadow Copy Service error: Unexpected error DeviceIoControl... Shadow copy storage exhausted or writer timed out.*
3. Kiểm tra trạng thái các bộ ghi bản sao bóng (VSS Writers) bằng dòng lệnh:
   ```cmd
   vssadmin list writers
   ```
   - Kết quả:
     - `System Writer`: State: [1] Stable, Last error: No error.
     - `Microsoft Hyper-V VSS Writer`: State: [1] Stable.
     - **`Shadow Copy Optimization Writer`**: State: **[5] Waiting for completion**, Last error: **Timed out** (Bị treo!).
4. Kiểm tra dung lượng ổ đĩa lưu trữ bản sao lưu dự phòng (Backup Repository NAS):
   - Ổ cứng NAS chia sẻ qua iSCSI/SMB chỉ còn trống 12 GB, không đủ dung lượng ghi một bản sao lưu vi sai (Incremental Backup) ước tính khoảng 45 GB.

---

## 3. NGUYÊN NHÂN GỐC RỄ
1. VSS Writer trên máy chủ `FS01-SRV` bị rơi vào trạng thái treo (Frozen / Deadlock) do có tiến trình phần mềm quét virus Endpoint chạy quét sâu cùng thời điểm 3h00 sáng.
2. Dung lượng ổ đĩa sao lưu đích (Backup Storage Repository) bị chạm ngưỡng cảnh báo đầy, không còn đủ không gian để tạo metadata snapshot.

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. **Khôi phục trạng thái VSS Writers:**
   - Khởi động lại dịch vụ Volume Shadow Copy và Cryptographic Services:
     ```cmd
     net stop vss
     net stop cryptsvc
     net start cryptsvc
     net start vss
     ```
   - Chạy lại lệnh kiểm tra: `vssadmin list writers` -> Toàn bộ các writer chuyển về trạng thái `[1] Stable` với `No error`.
2. **Giải phóng và tối ưu không gian ổ đĩa sao lưu (Backup Repository):**
   - Đăng nhập vào thiết bị lưu trữ NAS trung tâm:
   - Áp dụng chính sách lưu trữ tự động (Retention Policy GFS - Grandfather-Father-Son): Dọn dẹp và nén các bản sao lưu tuần cũ hơn 60 ngày sang kho lưu trữ đám mây băng lạnh (Cold Archive Cloud S3), giải phóng ngay **380 GB** dung lượng trống trên NAS.
3. **Điều chỉnh lịch quét virus định kỳ:**
   - Đổi giờ quét sâu (Full System Scan) của phần mềm diệt virus sang 23:00 đêm Chủ nhật để không bao giờ bị trùng giờ với job sao lưu dữ liệu lúc 03:00 sáng.
4. **Kích hoạt chạy lại tác vụ sao lưu thủ công (Manual Retry Backup):**
   - Trên bảng điều khiển Veeam / Windows Server Backup: Bấm nút `Start Job`.
   - Tiến trình diễn ra thuận lợi: Snapshot VSS tạo trong 18 giây, truyền tải 42.4 GB dữ liệu nén qua đường mạng 10Gbps trong 14 phút. Trạng thái báo: **Success (Green)**.

---

## 5. DIỄN TẬP PHỤC HỒI THỰC TẾ (TEST RECOVERY DRILL)
Để đảm bảo bản sao lưu không chỉ ghi thành công mà còn đọc và phục hồi được thực sự:
1. Tạo một thư mục kiểm thử: `D:\Shares\TestRestore_Sandbox`.
2. Thực hiện khôi phục ngẫu nhiên một thư mục tài liệu kế toán năm 2025 từ file backup vừa tạo:
   - Thời gian phục hồi: 2 phút 10 giây.
   - So sánh mã kiểm tra băm file (MD5 Hash Verification): Khớp 100% từng bit dữ liệu.
3. Ghi chép kết quả diễn tập vào **Biên bản Kiểm định Sao lưu Hàng tháng (Monthly DR Audit Report)** và đóng ticket thành công.
