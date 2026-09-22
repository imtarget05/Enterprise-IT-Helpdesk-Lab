# Incident Ticket #INC-1016 — USB Storage Blocked by Group Policy (Exception Handling)

- **Ticket ID:** INC-1016
- **Requester:** Nguyen Thi Kim Oanh (Chuyên viên Thiết kế Marketing)
- **Department:** Marketing
- **Priority:** Medium
- **Category:** Security Policy / GPO
- **Status:** Resolved
- **Assigned To:** IT Helpdesk Specialist

---

## 1. MÔ TẢ SỰ CỐ
Nhân viên Marketing cắm ổ cứng di động SSD ngoài vào máy tính để sao chép video clip sự kiện dung lượng 35 GB vừa quay từ máy ảnh chuyên dụng về để dựng clip. Tuy nhiên, khi nhấp đúp vào ổ đĩa `E:`, Windows hiện cảnh báo lỗi:
*"E:\ is not accessible. Access is denied."*
Nhân viên nghĩ rằng ổ cứng bị hỏng và cần IT kiểm tra gấp.

---

## 2. CHẨN ĐOÁN
1. Cắm ổ cứng di động sang máy tính IT: Ổ đĩa nhận ngay lập tức, đọc/ghi dữ liệu hoàn toàn bình thường -> Ổ cứng và dây cáp cáp kết nối vật lý không có lỗi.
2. Cắm lại vào máy tính người dùng:
   - Trong Device Manager: Thiết bị nhận đúng tên `SanDisk Extreme SSD`.
   - Trong Disk Management: Ổ đĩa hiển thị phân vùng NTFS, trạng thái `Healthy`, gán ký tự ổ `E:`.
   - Nhưng trong File Explorer: Không cho phép đọc hay ghi.
3. Kiểm tra chính sách GPO đang áp dụng trên máy tính:
   - Mở CMD chạy lệnh: `gpresult /r`.
   - Phát hiện GPO mang tên **`GPO_Restrict_USB_Storage`** đang được kích hoạt trên máy tính này.
   - Thiết lập trong GPO: *Computer Configuration -> Administrative Templates -> System -> Removable Storage Access -> All Removable Storage classes: Deny all access = Enabled*.

---

## 3. NGUYÊN NHÂN GỐC RỄ
Công ty áp dụng chính sách an toàn thông tin GPO chặn toàn bộ thiết bị lưu trữ ngoài (USB, thẻ nhớ, ổ cứng gắn ngoài) trên tất cả các máy trạm nhân viên để ngăn chặn rò rỉ dữ liệu mật và ngăn chặn lây nhiễm virus mã độc qua cổng USB. Tuy nhiên, tính chất công việc của phòng Marketing thường xuyên phải làm việc với các file video thô từ máy ảnh nên cần được áp dụng chính sách ngoại lệ (Exception Policy).

---

## 4. CÁC BƯỚC KHẮC PHỤC
1. Yêu cầu Trưởng phòng Marketing gửi email phê duyệt chính thức yêu cầu mở quyền truy cập USB cho nhân sự này.
2. Trên máy chủ Domain Controller `DC01-SRV`:
   - Tạo một nhóm bảo mật mới: **`SG_USB_Allowed_Users`**.
   - Thêm tài khoản `oanh.nguyen` vào nhóm `SG_USB_Allowed_Users`.
   - Mở `Group Policy Management Console` (`gpmc.msc`):
     - Chọn chính sách `GPO_Restrict_USB_Storage` -> Chuyển sang tab **Delegation** -> Bấm nút **Advanced**.
     - Thêm nhóm `SG_USB_Allowed_Users` -> Tại cột Permissions, tích chọn **Deny** ở mục **Apply Group Policy** (Từ chối áp dụng chính sách chặn USB cho các thành viên nhóm này).
3. Trên máy tính của người dùng:
   - Chạy lệnh ép buộc cập nhật chính sách:
     ```cmd
     gpupdate /force
     ```
   - Rút ổ cứng di động ra và cắm lại vào cổng USB.
4. Kiểm tra mở lại ổ đĩa `E:`: Toàn bộ danh mục video mở ra ngay lập tức, tốc độ đọc/ghi đạt 450 MB/s.

---

## 5. PHÒNG NGỪA
- Đăng ký số Serial của ổ cứng chuyên dụng này vào danh sách thiết bị được phê duyệt của phòng IT để tiện kiểm soát tài sản.
