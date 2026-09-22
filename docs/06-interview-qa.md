# Enterprise IT Helpdesk Lab — 30 Classic Technical Interview Questions & Answers

Tổng hợp 30 câu hỏi phỏng vấn kỹ thuật và xử lý tình huống thực tế dành riêng cho vị trí **IT Helpdesk, IT Support Engineer và Nhân viên IT Quản trị Hệ thống** (chuẩn bị cho OKIA và BMC Việt Nam).

---

## PHẦN 1: MẠNG CĂN BẢN & GIAO THỨC (TCP/IP, DNS, DHCP)

### Câu 1: Em hãy giải thích quá trình máy tính xin cấp phát IP từ DHCP Server (D.O.R.A)?
- **Trả lời:** Quá trình xin cấp IP động diễn ra qua 4 bước:
  1. **Discover (Broadcast):** Máy client khởi động, chưa có IP, gửi gói tin UDP broadcast `DHCP Discover` tới cổng 67/68 tìm kiếm DHCP server trong mạng LAN.
  2. **Offer (Unicast/Broadcast):** DHCP Server nhận được, chọn một địa chỉ IP chưa sử dụng trong Scope và gửi gói `DHCP Offer` kèm Subnet mask, Gateway, DNS, thời hạn thuê (Lease time).
  3. **Request (Broadcast):** Client nhận offer (nếu có nhiều server, thường chọn gói đến trước) và gửi bản tin `DHCP Request` công bố công khai rằng nó chấp nhận địa chỉ IP này.
  4. **Acknowledge (Unicast/Broadcast):** DHCP Server gửi lại bản tin `DHCP ACK` xác nhận chính thức khóa IP đó cho client và lưu vào bảng danh bạ cấp phát.

### Câu 2: Địa chỉ APIPA là gì? Khi nào máy tính nhận địa chỉ này?
- **Trả lời:** APIPA (Automatic Private IP Addressing) là dải địa chỉ từ `169.254.0.1` đến `169.254.255.254` với subnet `255.255.0.0`. Khi máy tính được cấu hình nhận IP tự động nhưng không nhận được phản hồi DHCP ACK từ bất kỳ máy chủ DHCP nào sau nhiều lần thử, hệ điều hành Windows sẽ tự động gán một IP ngẫu nhiên trong dải này để các máy trong cùng mạng LAN vẫn có thể nói chuyện tạm thời với nhau nhưng không thể ra Internet hay kết nối Gateway.

### Câu 3: Một máy tính ping được IP 8.8.8.8 nhưng không thể truy cập website google.com, em xử lý ra sao?
- **Trả lời:** Ping được 8.8.8.8 chứng minh card mạng, cáp mạng, router gateway và đường truyền Internet quốc tế hoàn toàn thông suốt. Vấn đề nằm ở Layer 7 dịch vụ phân giải tên miền (DNS). Em sẽ:
  1. Chạy `nslookup google.com` để kiểm tra máy chủ DNS nào đang trả về kết quả lỗi hoặc timeout.
  2. Kiểm tra `ipconfig /all` xem card mạng có bị gán nhầm DNS Server sai không.
  3. Xóa cache DNS bằng lệnh `ipconfig /flushdns`.
  4. Kiểm tra file `C:\Windows\System32\drivers\etc\hosts` xem có bản ghi độc hại nào ghi đè chuyển hướng không.

### Câu 4: Sự khác nhau giữa TCP và UDP? Cho ví dụ ứng dụng văn phòng của từng giao thức?
- **Trả lời:**
  - **TCP (Transmission Control Protocol):** Hướng kết nối (Connection-oriented), thực hiện bắt tay 3 bước (SYN, SYN-ACK, ACK), đảm bảo dữ liệu gửi đi không bị mất mát và đúng thứ tự (tin cậy 100%), có kiểm soát tắc nghẽn nhưng độ trễ cao hơn. *Ví dụ:* Duyệt web (HTTP/HTTPS), gửi email (SMTP/IMAP), truyền file (FTP/SMB Share).
  - **UDP (User Datagram Protocol):** Không kết nối (Connectionless), bắn gói tin đi mà không chờ xác nhận ACK, tốc độ cực nhanh, chấp nhận rớt vài gói. *Ví dụ:* Cuộc gọi VoIP/Hội nghị truyền hình Teams/Zoom, DNS query, truyền phát video trực tiếp.

### Câu 5: Lệnh `traceroute` (hoặc `tracert` trên Windows) hoạt động theo nguyên lý nào?
- **Trả lời:** `tracert` tận dụng trường TTL (Time to Live) trong gói tin IP. Ban đầu nó gửi gói tin với `TTL = 1`. Khi đến router đầu tiên (hop 1), router giảm TTL về 0, hủy gói tin và gửi lại bản tin `ICMP Time Exceeded` cho client, từ đó client biết IP và độ trễ của hop 1. Tiếp tục, `tracert` gửi gói với `TTL = 2`, `TTL = 3`... cho đến khi chạm tới đích đến cuối cùng hoặc đạt giới hạn số hop (mặc định 30). Giúp IT xác định điểm nghẽn mạng nằm ở nhà mạng ISP hay router nội bộ.

---

## PHẦN 2: ACTIVE DIRECTORY, WINDOWS SERVER & GPO

### Câu 6: Active Directory là gì? Thành phần Domain, Tree, Forest khác nhau thế nào?
- **Trả lời:** Active Directory là dịch vụ thư mục của Microsoft dùng để quản lý tập trung danh tính người dùng, máy tính, nhóm bảo mật và chính sách tài nguyên trong mạng doanh nghiệp.
  - **Domain:** Ranh giới quản trị cơ bản (ví dụ `company.local`) chia sẻ chung một cơ sở dữ liệu thư mục.
  - **Tree:** Tập hợp nhiều domain có cùng không gian tên phân cấp (ví dụ: `company.local` và `dev.company.local`).
  - **Forest:** Cấp cao nhất trong AD, tập hợp các domain hoặc tree có thể khác nhau về namespace nhưng chia sẻ chung Schema (cấu trúc thuộc tính) và Global Catalog với các mối quan hệ tin cậy 2 chiều (Transitive Trust).

### Câu 7: Khi máy client không nhận được chính sách GPO mới tạo, em kiểm tra những gì?
- **Trả lời:**
  1. Chạy lệnh ép buộc cập nhật chính sách: `gpupdate /force`.
  2. Xuất kết quả phân tích áp dụng GPO: `gpresult /r` hoặc `gpresult /h C:\gp.html`.
  3. Kiểm tra xem tài khoản User hoặc Máy tính có nằm đúng trong Organizational Unit (OU) được liên kết (Link) GPO đó không.
  4. Kiểm tra phần **Security Filtering**: Xem nhóm của user/máy có quyền "Read" và "Apply Group Policy" đối với GPO đó không.
  5. Kiểm tra tính năng đồng bộ bản sao giữa các Domain Controller (Replication status qua `repadmin /replsummary`).
  6. Kiểm tra DNS của máy client: Nếu client không trỏ đúng DNS về Domain Controller, nó sẽ không thể tải được file template GPO từ thư mục chia sẻ `\\domain\SYSVOL`.

### Câu 8: Sự khác nhau giữa Share Permissions và NTFS Permissions là gì?
- **Trả lời:**
  - **Share Permissions:** Áp dụng khi người dùng truy cập thư mục từ xa qua mạng (qua giao thức SMB: `\\server\share`). Không áp dụng khi người dùng đăng nhập trực tiếp tại máy chủ. Chỉ có 3 mức: Full Control, Change, Read.
  - **NTFS Permissions:** Áp dụng cho cả truy cập qua mạng lẫn truy cập cục bộ trên máy chủ có định dạng ổ đĩa NTFS. Cung cấp phân quyền chi tiết hơn nhiều (Read, Write, Modify, Full Control, Read & Execute, List Folder Contents).
  - **Quy tắc phối hợp:** Khi truy cập qua mạng, quyền hiệu lực cuối cùng là quyền hạn chế nhất (Most Restrictive) giữa hai nhóm quyền. Vì vậy best practice là đặt Share Permissions ở mức rộng (`Authenticated Users = Change/Read` hoặc `Full Control`) và kiểm soát an ninh chi tiết bằng NTFS Permissions.

### Câu 9: Kerberos và NTLM khác nhau thế nào trong môi trường Windows Domain?
- **Trả lời:**
  - **Kerberos:** Giao thức xác thực bảo mật mặc định hiện đại của Active Directory sử dụng cơ chế phát vé (Tickets - Ticket Granting Ticket - TGT) qua Key Distribution Center (KDC trên Domain Controller), có xác thực 2 chiều (Mutual authentication - client biết server chuẩn, server biết client chuẩn) và hỗ trợ delegation an toàn. Yêu cầu thời gian đồng hồ giữa Client và DC không được lệch quá 5 phút.
  - **NTLM (NT LAN Manager):** Giao thức xác thực cũ dựa trên cơ chế thách thức - phản hồi (Challenge-Response hash). Dễ bị tấn công chuyển tiếp (Pass-the-Hash / NTLM Relay) và chỉ được dùng dự phòng khi không phân giải được tên miền hoặc qua địa chỉ IP thô.

### Câu 10: Người dùng báo bị khóa tài khoản (Account Locked), em xử lý thế nào và làm sao tìm nguyên nhân?
- **Trả lời:**
  - **Xử lý nhanh:** Mở Active Directory Users and Computers -> Tìm User -> Properties -> Account -> Tích chọn "Unlock account" -> Apply.
  - **Tìm nguyên nhân gốc rễ (Tránh bị khóa lại liên tục):**
    1. Hỏi người dùng vừa đổi mật khẩu gần đây không. Thông thường, người dùng đổi pass trên máy tính, nhưng điện thoại (kết nối Wi-Fi văn phòng bằng tài khoản AD), Outlook mobile hoặc ứng dụng VPN trên laptop ở nhà vẫn lưu mật khẩu cũ và tự động gửi yêu cầu đăng nhập liên tục làm vượt ngưỡng 5 lần khóa của GPO.
    2. Kiểm tra Event Viewer trên Domain Controller: Mở `Security Log`, lọc Event ID `4740` (A user account was locked out) để xem trường "Caller Computer Name" — cho biết chính xác tên máy tính hoặc thiết bị nào đang gửi mật khẩu sai.

---

## PHẦN 3: HỆ ĐIỀU HÀNH, PHẦN CỨNG & ỨNG DỤNG VĂN PHÒNG

### Câu 11: Em xử lý lỗi màn hình xanh (BSOD) như thế nào?
- **Trả lời:** Em xử lý theo 4 bước logic:
  1. **Ghi nhận mã lỗi:** Chụp ảnh mã lỗi hiển thị (ví dụ `CRITICAL_PROCESS_DIED`, `PAGE_FAULT_IN_NONPAGED_AREA`, `DRIVER_IRQL_NOT_LESS_OR_EQUAL`).
  2. **Đọc Minidump:** Dùng công cụ `BlueScreenView` hoặc `WinDbg` mở file `.dmp` trong thư mục `C:\Windows\Minidump` để xác định chính xác driver file nào gây crash (ví dụ driver card đồ họa `nvlddmkm.sys` hay driver Wi-Fi).
  3. **Khắc phục phần mềm:** Khởi động vào Safe Mode, rollback hoặc update driver bị lỗi; chạy `sfc /scannow` và `DISM /Online /Cleanup-Image /RestoreHealth` để phục hồi file hệ thống bị lỗi.
  4. **Kiểm tra phần cứng:** Nếu vẫn lặp lại, chạy công cụ Windows Memory Diagnostic kiểm tra lỗi RAM và phần mềm CrystalDiskInfo kiểm tra sức khỏe ổ cứng (Bad sector).

### Câu 12: Outlook không gửi/nhận được email và báo "Disconnected" hoặc "Need Password", em làm gì?
- **Trả lời:**
  1. Kiểm tra mạng internet của máy xem có lướt web bình thường không.
  2. Yêu cầu người dùng đăng nhập Outlook trên trình duyệt web (OWA / Outlook Web App): Nếu web vẫn vào được, lỗi nằm ở client máy tính; nếu web cũng không vào được, tài khoản bị khóa hoặc hết hạn mật khẩu.
  3. Với client: Vào Windows `Credential Manager` (Quản lý thông tin xác thực) -> Windows Credentials -> Xóa các bản ghi liên quan đến `MicrosoftOffice16` và `Outlook` rồi mở lại Outlook để nhập lại mật khẩu chuẩn xác thực OAuth2/MFA.
  4. Nếu file dữ liệu mail bị lỗi, dùng công cụ `scanpst.exe` để quét sửa chữa file `.ost` hoặc `.pst`, hoặc tạo lại Outlook Profile mới trong Control Panel -> Mail.

### Câu 13: Làm thế nào để cài đặt và chia sẻ máy in qua mạng cho nhiều phòng ban?
- **Trả lời:**
  - Có 2 cách chính:
    1. **Qua Print Server tập trung (Chuẩn doanh nghiệp):** Cài máy in lên máy chủ `FS01-SRV` bằng Standard TCP/IP Port trỏ tới IP tĩnh của máy in. Cài đầy đủ driver x64 và x86. Sau đó cấu hình GPO Print Management (Deploy with Group Policy) để tự động đẩy máy in xuống từng máy tính theo phòng ban.
    2. **Cài trực tiếp qua IP tĩnh tại từng máy con:** Vào Settings -> Printers & Scanners -> Add device manually -> Add a printer using an IP address or hostname -> Nhập IP cố định của máy in.

### Câu 14: Một máy tính chạy cực kỳ chậm và ổ C báo dung lượng đỏ, các bước dọn dẹp an toàn của em là gì?
- **Trả lời:**
  1. Chạy công cụ Disk Cleanup với quyền Administrator (`Cleanmgr /sageset:1`), tích chọn dọn dẹp "Windows Update Cleanup", "Temporary Files", "Recycle Bin".
  2. Dừng dịch vụ `Windows Update` (`net stop wuauserv`), vào `C:\Windows\SoftwareDistribution\Download` xóa toàn bộ các bản vá tải dở, sau đó bật lại dịch vụ.
  3. Dọn dẹp thư mục tạm của người dùng: `C:\Users\%username%\AppData\Local\Temp` và `C:\Windows\Temp`.
  4. Nếu máy có RAM lớn, xem xét giảm dung lượng hoặc tắt tính năng ngủ đông (`powercfg -h off`) để giải phóng hàng chục GB của file `hiberfil.sys`.
  5. Dùng công cụ `TreeSize Free` quét trực quan để tìm xem có file video cá nhân hay file Outlook Archive `.pst` khổng lồ nào đặt nhầm trên ổ C không và chuyển sang ổ phụ D.

### Câu 15: Ransomware là gì? Nếu phát hiện một máy trạm trong công ty bị nhiễm mã độc tống tiền, hành động khẩn cấp đầu tiên của em là gì?
- **Trả lời:** Ransomware là mã độc mã hóa toàn bộ dữ liệu trên máy tính nạn nhân và lan truyền qua các ổ đĩa mạng chia sẻ đòi tiền chuộc để giải mã.
  - **HÀNH ĐỘNG ĐẦU TIÊN KHẨN CẤP:** **Rút ngay dây cáp mạng và ngắt kết nối Wi-Fi** của máy tính bị nhiễm ngay lập tức! (Không tắt nguồn máy vội để giữ bộ nhớ RAM phục vụ phân tích điều tra mã độc, nhưng phải cô lập cách ly mạng 100% để ngăn mã độc quét và mã hóa các thư mục chia sẻ chung trên File Server và các máy tính khác trong subnet).
  - Sau đó: Báo cáo ngay cho Trưởng phòng IT, kiểm tra các thư mục chia sẻ trên Server, quét toàn bộ hệ thống bằng phần mềm Endpoint Antivirus và chuẩn bị phương án khôi phục dữ liệu từ bản sao lưu Backup định kỳ.

---

## PHẦN 4: HỆ THỐNG NỘI BỘ, WEBSITE & QUẢN TRỊ TÀI SẢN (JD BMC VIỆT NAM)

### Câu 16: Em có kinh nghiệm gì về việc quản trị website, tên miền (Domain) và hosting?
- **Trả lời:** Em nắm vững toàn bộ quy trình vận hành web doanh nghiệp:
  1. **DNS & Tên miền:** Quản trị các bản ghi DNS tại nhà cung cấp (A record trỏ IP máy chủ, CNAME cho subdomain, MX record cho hệ thống mail Google Workspace/M365, TXT/SPF/DKIM/DMARC chống giả mạo email).
  2. **Máy chủ Web (Web Server):** Thành thạo cấu hình Nginx / Apache / IIS, cấu hình Reverse Proxy, giới hạn kích thước upload, cấu hình nén gzip và chặn truy cập trái phép.
  3. **Chứng chỉ bảo mật SSL:** Kích hoạt và gia hạn tự động chứng chỉ Let's Encrypt qua công cụ `certbot`, hoặc cấu hình chứng chỉ số trả phí (Comodo/DigiCert).
  4. **Sao lưu định kỳ:** Lập script sao lưu tự động mã nguồn website và cơ sở dữ liệu hàng đêm, nén và đẩy về kho lưu trữ an toàn.

### Câu 17: Tại sao cần quản lý vòng đời tài sản CNTT (IT Asset Management)? Em đã từng xây dựng công cụ này thế nào?
- **Trả lời:** Quản lý tài sản CNTT giúp doanh nghiệp kiểm soát chặt chẽ số lượng thiết bị phần cứng (Laptop, PC, Màn hình, Máy in), quản lý bản quyền phần mềm (tránh bị phạt khi thanh tra kiểm toán license), và nắm rõ lịch sử bảo hành bảo trì.
  - Trong dự án của mình, em đã phát triển ứng dụng **IT Asset & Helpdesk Portal**: Cho phép gán mã tài sản (Asset Tag), theo dõi thiết bị đang được nhân viên nào sử dụng, lịch sử hỏng hóc, cảnh báo hạn bảo hành và tích hợp trực tiếp với module phiếu hỗ trợ (Ticket).

### Câu 18: Sự khác biệt giữa mô hình Monolith và Microservices? Với ứng dụng nội bộ doanh nghiệp vừa và nhỏ, tại sao Monolith thường là lựa chọn tối ưu hơn?
- **Trả lời:**
  - **Monolith:** Toàn bộ thành phần (Giao diện, Xử lý nghiệp vụ, Kết nối CSDL) nằm chung trong một ứng dụng duy nhất.
  - **Microservices:** Hệ thống chia nhỏ thành hàng chục service độc lập giao tiếp qua mạng/message broker.
  - **Với ứng dụng nội bộ SME:** Monolith sạch sẽ là lựa chọn vượt trội vì: chi phí triển khai thấp, chỉ cần 1 máy chủ duy nhất, triển khai đơn giản không cần cụm Kubernetes phức tạp, dễ bảo trì, dễ debug sửa lỗi và phù hợp với quy mô vài chục đến vài trăm nhân viên nội bộ mà không gặp gánh nặng vận hành hạ tầng phân tán.

### Câu 19: Quy trình thiết lập VPN từ xa (Remote Access VPN) cho nhân viên làm việc tại nhà như thế nào?
- **Trả lời:**
  1. Cấu hình máy chủ VPN (IPsec/OpenVPN/WireGuard hoặc tính năng VPN trên Firewall Fortinet/PFSense).
  2. Tích hợp xác thực với Active Directory qua giao thức RADIUS / NPS (Network Policy Server): Chỉ cho phép các tài khoản thuộc nhóm bảo mật `SG_VPN_RemoteAccess` được đăng nhập.
  3. Bật bắt buộc xác thực 2 bước (MFA) để chống lộ mật khẩu.
  4. Cài đặt và cấu hình phần mềm VPN Client trên máy tính nhân viên, bàn giao file profile mã hóa và hướng dẫn sử dụng.

### Câu 20: Chiến lược sao lưu dữ liệu theo quy tắc 3-2-1 là gì?
- **Trả lời:** Quy tắc sao lưu kinh điển chuẩn thế giới:
  - **3 bản sao dữ liệu:** Gồm 1 bản chính đang hoạt động và ít nhất 2 bản sao lưu (Backup copies).
  - **2 phương tiện lưu trữ khác nhau:** Lưu trên 2 loại thiết bị khác nhau (ví dụ: 1 bản trên ổ cứng máy chủ File Server cục bộ, 1 bản trên ổ đĩa NAS hoặc Băng từ LTO).
  - **1 bản lưu ngoại vi (Offsite):** Ít nhất 1 bản sao phải được chuyển ra ngoài vị trí tòa nhà văn phòng (lưu trên Cloud AWS S3/Azure Blob hoặc trung tâm dữ liệu thứ hai) để chống rủi ro cháy nổ, thiên tai hoặc trộm cắp tại chỗ.

---

## PHẦN 5: XỬ LÝ TÌNH HUỐNG & KỸ NĂNG MỀM (SCENARIO & SOFT SKILLS)

### Câu 21: Một Giám đốc gọi điện yêu cầu hỗ trợ gấp vì không thể mở slide thuyết trình trước cuộc họp quan trọng với đối tác sau 10 phút nữa, em xử lý tình huống này thế nào?
- **Trả lời:**
  1. **Giữ thái độ bình tĩnh, trấn an và lắng nghe:** Xác nhận em hiểu tính cấp bách của cuộc họp và sẽ tập trung ưu tiên xử lý ngay lập tức.
  2. **Giải pháp nhanh tức thời (Workaround):** Hỏi nhanh file slide đang lưu ở đâu (máy tính, email hay USB). Nếu PowerPoint trên máy bị treo hoặc crash, em hướng dẫn mở nhanh file qua trình duyệt web (Office Online / Google Slides) hoặc gửi file qua Zalo/Email nội bộ để em xuất nhanh sang định dạng PDF trình chiếu dự phòng chỉ mất 1-2 phút.
  3. **Xử lý triệt để:** Sau khi cuộc họp kết thúc thành công, em sẽ liên hệ lại để kiểm tra và sửa lỗi phần mềm Office trên máy của Giám đốc.

### Câu 22: Khi có nhiều người dùng cùng tạo ticket yêu cầu hỗ trợ cùng một lúc, em ưu tiên thứ tự xử lý dựa trên tiêu chí nào?
- **Trả lời:** Em áp dụng ma trận ưu tiên chuẩn ITIL dựa trên 2 yếu tố: **Mức độ tác động (Impact)** và **Mức độ khẩn cấp (Urgency)**:
  1. **Ưu tiên 1 (Critical):** Sự cố diện rộng làm gián đoạn toàn bộ hoạt động kinh doanh (Server sập, mạng toàn công ty mất kết nối, hệ thống ERP dừng hoạt động). Phải xử lý ngay lập tức.
  2. **Ưu tiên 2 (High):** Sự cố ảnh hưởng đến cả một phòng ban quan trọng hoặc nhân sự cấp cao trong cuộc họp khẩn (Phòng kế toán không xuất được hóa đơn điện tử cuối tháng, máy in hóa đơn kẹt hàng loạt).
  3. **Ưu tiên 3 (Medium):** Sự cố của cá nhân một nhân viên nhưng cản trở công việc trực tiếp (máy tính không vào được mạng, màn hình hỏng).
  4. **Ưu tiên 4 (Low):** Các yêu cầu hỗ trợ thông thường không khẩn cấp (xin cấp phát chuột mới, cài đặt font chữ, yêu cầu tài liệu hướng dẫn).

### Câu 23: Nếu một người dùng yêu cầu em cài đặt phần mềm không có bản quyền (phần mềm bẻ khóa/crack), em sẽ phản hồi ra sao?
- **Trả lời:** Em sẽ từ chối một cách lịch sự nhưng kiên quyết:
  1. Giải thích cho người dùng hiểu rằng chính sách bảo mật của công ty nghiêm cấm cài đặt phần mềm không bản quyền vì nguy cơ cao chứa mã độc gián điệp, virus mã hóa tống tiền (Ransomware) và vi phạm pháp luật sở hữu trí tuệ khiến doanh nghiệp có thể bị xử phạt nặng khi thanh tra kiểm toán.
  2. Đề xuất giải pháp thay thế hợp pháp: Cung cấp phần mềm mã nguồn mở/miễn phí có tính năng tương đương (ví dụ dùng 7-Zip thay WinRAR, Notepad++ thay Sublime chưa kích hoạt, Inkscape thay Illustrator cơ bản).
  3. Nếu tính chất công việc bắt buộc phải dùng phần mềm chuyên dụng, em hướng dẫn người dùng làm phiếu đề xuất mua bản quyền chính hãng trình cấp quản lý phê duyệt.

### Câu 24: Khi một nhân viên không rành về máy tính và tỏ ra bực bội, khó chịu khi gặp sự cố, em giao tiếp với họ thế nào?
- **Trả lời:**
  - Không tranh cãi, thể hiện sự đồng cảm: "Em hiểu sự cố này đang làm gián đoạn công việc của anh/chị, em sẽ hỗ trợ xử lý ngay bây giờ".
  - Tránh dùng các thuật ngữ kỹ thuật phức tạp (jargon) khiến họ bối rối; dùng từ ngữ đời thường, ngắn gọn.
  - Chủ động xin phép sử dụng công cụ điều khiển từ xa (UltraViewer/AnyDesk/Quick Assist) để họ thấy rõ từng thao tác và không phải tự mò mẫm.
  - Sau khi xử lý xong, giải thích ngắn gọn nguyên nhân và hướng dẫn họ cách phòng tránh trong tương lai.

### Câu 25: Em hiểu thế nào về khái niệm "Shadow IT" và làm thế nào để giảm thiểu rủi ro này?
- **Trả lời:** Shadow IT là việc nhân viên hoặc phòng ban tự ý sử dụng các thiết bị cá nhân, ứng dụng đám mây (Google Drive, Telegram, Zalo) hoặc phần mềm không được phê duyệt hoặc quản lý bởi phòng CNTT để xử lý dữ liệu công việc.
  - **Rủi ro:** Nguy cơ rò rỉ dữ liệu mật của công ty ra bên ngoài, không kiểm soát được sao lưu và dễ nhiễm mã độc.
  - **Giải pháp:** Áp dụng GPO hạn chế quyền cài đặt phần mềm của User thường (chặn Local Admin); chặn các website lưu trữ đám mây không chính thống trên tường lửa công ty; đồng thời cung cấp giải pháp lưu trữ nội bộ tiện lợi (OneDrive doanh nghiệp, Nextcloud) đáp ứng tốt nhu cầu người dùng để họ không cần tìm công cụ ngoài.

### Câu 26: Tại sao tài khoản người dùng thông thường không nên có quyền Local Administrator trên máy tính?
- **Trả lời:** Nguyên tắc đặc quyền tối thiểu (Least Privilege). Nếu người dùng có quyền Local Admin:
  1. Bất kỳ mã độc hoặc virus nào họ bấm nhầm khi duyệt web hoặc mở mail lừa đảo (phishing) sẽ ngay lập tức có quyền Administrator để can thiệp vào Registry, vô hiệu hóa Windows Defender, cài đặt Rootkit và lây nhiễm sang mạng nội bộ.
  2. Người dùng có thể tự ý cài phần mềm lạ gây xung đột hệ thống, đổi cấu hình mạng làm xung đột IP. Khi chỉ là Standard User, phần lớn mã độc bị chặn đứng vì không có quyền ghi vào `C:\Windows` hay `Program Files`.

### Câu 27: VLAN (Virtual Local Area Network) là gì và tại sao trong doanh nghiệp nên chia VLAN?
- **Trả lời:** VLAN là kỹ thuật chia một switch vật lý thành nhiều mạng cục bộ logic độc lập nhau.
  - **Mục đích:**
    1. **Tăng cường an ninh:** Tách biệt lưu lượng mạng phòng Kế toán/Máy chủ khỏi mạng Wi-Fi của khách (Guest Wi-Fi) hoặc máy chấm công/Camera.
    2. **Giảm Broadcast Domain:** Ngăn chặn các gói tin quảng bá làm nghẽn toàn bộ switch.
    3. **Dễ dàng quản lý & áp dụng chính sách:** Áp dụng danh sách kiểm soát truy cập (ACL) hoặc Firewall giữa các VLAN.

### Câu 28: DNS Cache Poisoning (Đầu độc bộ nhớ đệm DNS) là gì và cách phòng chống?
- **Trả lời:** Là hình thức tấn công mạng mà kẻ gian chèn thông tin phân giải DNS giả mạo vào bộ nhớ đệm của máy chủ DNS. Khi người dùng gõ tên miền hợp pháp (ví dụ `ebank.com`), DNS giả mạo sẽ trả về địa chỉ IP của máy chủ lừa đảo của hacker.
  - **Phòng chống:** Sử dụng giao thức bảo mật DNSSEC (DNS Security Extensions) có chữ ký số để xác thực tính toàn vẹn của phản hồi DNS; thường xuyên cập nhật bản vá cho máy chủ DNS Server Windows/BIND; không bật tính năng Open Recursive DNS cho mạng công cộng.

### Câu 29: Kỹ thuật bắt tay 3 bước của TCP (3-Way Handshake) diễn ra như thế nào?
- **Trả lời:**
  1. **Bước 1 (SYN):** Client gửi gói tin có cờ `SYN` kèm số thứ tự khởi tạo ban đầu `ISN = X` tới máy chủ để yêu cầu mở kết nối.
  2. **Bước 2 (SYN-ACK):** Server nhận được, gửi lại gói tin có cả cờ `SYN` và `ACK` với số xác nhận `ACK = X + 1` và số thứ tự của server `ISN = Y`.
  3. **Bước 3 (ACK):** Client nhận được, gửi gói tin có cờ `ACK` với số xác nhận `ACK = Y + 1`. Kết nối TCP chính thức được thiết lập thành công và sẵn sàng truyền tải dữ liệu.

### Câu 30: Mục tiêu nghề nghiệp của em trong 1–3 năm tới trong ngành CNTT là gì?
- **Trả lời:** *"Trong 1 năm đầu tiên, mục tiêu của em là vận hành xuất sắc công việc hỗ trợ kỹ thuật IT Helpdesk / Internal IT, giải quyết nhanh gọn và dứt điểm các sự cố văn phòng, nắm vững toàn diện hạ tầng hệ thống Domain, mạng và phần mềm nội bộ của quý công ty. Trong 2–3 năm tiếp theo, em định hướng phát triển chuyên sâu lên vị trí **System Administrator / DevOps Engineer**, tự động hóa tối đa các quy trình quản trị qua PowerShell/Python, nâng cao năng lực an ninh mạng và hạ tầng đám mây để đóng góp vào sự ổn định và phát triển bền vững của doanh nghiệp."*
