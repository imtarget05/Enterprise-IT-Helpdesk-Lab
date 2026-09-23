# 🖥️ Enterprise IT Helpdesk Lab

> **Dự án portfolio** mô phỏng môi trường IT doanh nghiệp (50–120 nhân viên),  
> bao gồm **Windows Server 2022, Active Directory, Helpdesk Portal** và **PowerShell automation**.

<p align="center">
  <a href="https://github.com/imtarget05/Enterprise-IT-Helpdesk-Lab/actions/workflows/ci.yml">
    <img src="https://github.com/imtarget05/Enterprise-IT-Helpdesk-Lab/actions/workflows/ci.yml/badge.svg" alt="CI"/>
  </a>
  <img src="https://img.shields.io/badge/Tests-106%2F106%20Passing-brightgreen?logo=checkmarx&logoColor=white" alt="Tests"/>
  <img src="https://img.shields.io/badge/API%20Checks-68%2F68%20Passing-brightgreen?logo=curl&logoColor=white" alt="API Checks"/>
  <img src="https://img.shields.io/badge/Node.js-18%20%7C%2020%20%7C%2022-339933?logo=nodedotjs&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/PowerShell-AST%20Verified-5391FE?logo=powershell&logoColor=white" alt="PowerShell"/>
  <img src="https://img.shields.io/badge/Docker-Hardened-2496ED?logo=docker&logoColor=white" alt="Docker"/>
  <img src="https://img.shields.io/badge/Windows_Server-2022-0078D4?logo=windows&logoColor=white" alt="Windows Server 2022"/>
  <img src="https://img.shields.io/badge/Active_Directory-Configured-0078D4?logo=microsoft&logoColor=white" alt="Active Directory"/>
  <img src="https://img.shields.io/badge/ITIL-20%20Tickets-orange?logo=itil&logoColor=white" alt="ITIL"/>
</p>

---

## Dự án này làm được gì?

Một bộ phận IT nhỏ (1–3 người) thường loay hoay với 3 bài toán:

1. **Không biết ai đang dùng máy nào** — tài sản IT quản lý bằng Excel, thường xuyên sai lệch.
2. **Xử lý sự cố mất thời gian** — mỗi lần gặp lỗi cũ phải chẩn đoán lại từ đầu vì không có tài liệu.
3. **Tạo tài khoản nhân viên mới mất 20 phút** — làm thủ công, dễ nhầm OU, thiếu group phân quyền.

Dự án này giải quyết cả 3:

- ✅ **Portal quản lý tài sản & ticket** — web app nội bộ để theo dõi máy tính, phiếu sự cố, bản quyền phần mềm.
- ✅ **20 kịch bản sự cố thực tế** — mỗi ticket có đầy đủ: triệu chứng → chẩn đoán → nguyên nhân → cách sửa → cách phòng tránh.
- ✅ **PowerShell tự động hóa** — tạo hàng loạt user AD từ file CSV, kiểm kê phần cứng, chẩn đoán mạng.

---

## Tôi đã xây dựng những gì?

### 🏗️ 1. Lab Windows Server 2022 (VMware)

Môi trường lab mô phỏng hệ thống IT thực tế tại văn phòng doanh nghiệp:

| Thành phần | Mô tả |
|---|---|
| 🏢 **Active Directory** | Domain `COMPANY.LOCAL`, cấu trúc OU theo phòng ban, tài khoản user/group |
| 🌐 **DNS & DHCP** | Phân giải tên nội bộ, cấp IP tự động, xử lý sự cố APIPA |
| 🔒 **Group Policy (GPO)** | Chính sách bảo mật: chặn USB, bắt buộc đổi mật khẩu, map ổ đĩa mạng |
| 📁 **File Server** | Phân quyền NTFS + Share Permission, Shadow Copy để khôi phục file bị xóa |

### 🌐 2. Portal nội bộ IT (Node.js web app)

Web app chạy trong Docker, dành cho nhân viên IT dùng hàng ngày:

| Tính năng | Mô tả |
|---|---|
| 💻 **Quản lý tài sản** | Danh sách máy tính, trạng thái (đang dùng / kho / bảo trì / thanh lý), xuất Excel/CSV |
| 🎫 **Quản lý ticket** | Tạo, theo dõi, đóng phiếu sự cố theo quy trình ITIL |
| 🚨 **Cảnh báo tự động** | Ticket ưu tiên Cao/Khẩn → nhận thông báo tức thì, ghi audit log |
| 📊 **Dashboard** | Tổng quan: số thiết bị, số ticket đang mở, tỉ lệ giải quyết đúng hạn |
| 🤖 **Trợ lý AI (tùy chọn)** | Tích hợp LLM local (Ollama — không dùng ChatGPT/cloud) để gợi ý hướng chẩn đoán |

### 📋 3. 20 kịch bản sự cố thực chiến

Mỗi ticket trong `tickets/` viết theo khung chuẩn ITIL:

> **Triệu chứng** → **Chẩn đoán từng bước** → **Nguyên nhân gốc rễ** → **Cách sửa** → **Cách phòng tránh**

| # | Sự cố | Nội dung |
|---|---|---|
| 001 | 🌐 Không vào được internet | APIPA, DHCP, gateway, DNS — chẩn đoán theo 6 lớp |
| 003 | 🔐 Tài khoản AD bị khóa | Unlock, đặt lại mật khẩu, tìm nguyên nhân lockout |
| 011 | 🦠 Máy tính nhiễm malware | Cô lập máy, quét, vá lỗ hổng, báo cáo sự cố |
| 012 | 🗂️ Xóa nhầm file quan trọng | Khôi phục từ Shadow Copy của Windows Server |
| 015 | 👋 Nhân viên nghỉ việc | Offboarding: vô hiệu AD, thu hồi tài sản, thu hồi bản quyền |
| 018 | 📁 Không vào được shared folder | Phân biệt NTFS Permission vs Share Permission |

### ⚡ 4. Tự động hóa PowerShell

| Script | Làm gì |
|---|---|
| `New-CompanyUser.ps1` | Đọc file CSV → tạo hàng loạt user AD, đặt vào đúng OU, gán group phòng ban |
| `Export-ITAssetAudit.ps1` | Quét thông tin phần cứng (CPU, RAM, ổ đĩa) → xuất file kiểm kê |
| `Test-NetworkHealth.ps1` | Chẩn đoán mạng 6 lớp: loopback → gateway → domain → DNS → internet |

---

## Screenshots

![Dashboard](docs/images/portal-dashboard.png)
*Dashboard: tổng quan tài sản, ticket đang xử lý, cảnh báo*

![Tickets](docs/images/portal-tickets.png)
*Helpdesk Tickets: danh sách phiếu sự cố + nút phân tích AI*

![Assets](docs/images/portal-assets.png)
*IT Assets: quản lý thiết bị, lọc trạng thái, xuất CSV*

![AI Analysis](docs/images/portal-ai-analysis.png)
*AI gợi ý chẩn đoán sự cố (offline playbook, không cần internet)*

---

## Tại sao làm dự án này?

Dự án nhắm vào vị trí **IT Helpdesk / IT Support / Junior SysAdmin** tại doanh nghiệp vừa và nhỏ — đặc biệt là môi trường dùng Windows Server và Active Directory.

Công việc Helpdesk hàng ngày bao gồm:
- 🛠️ Tiếp nhận và xử lý sự cố người dùng (mạng, máy tính, email, tài khoản)
- 📦 Quản lý thiết bị IT, cấp phát và thu hồi khi có người vào/ra
- 👤 Tạo tài khoản, phân quyền cho nhân viên mới

Tôi đã thực hành đúng các kịch bản đó và ghi lại thành tài liệu để có thể giải thích rõ ràng trong buổi phỏng vấn.

---

## Chạy thử ngay (dưới 2 phút)

**Yêu cầu:** Node.js 18+ hoặc Docker.

```bash
# Option 1: Docker (khuyến nghị)
cd internal-portal
docker compose up -d --wait
# → Mở http://localhost:3000
```

```bash
# Option 2: Node.js
git clone https://github.com/imtarget05/Enterprise-IT-Helpdesk-Lab.git
cd Enterprise-IT-Helpdesk-Lab/internal-portal
npm install && npm start
# → Mở http://localhost:3000
```

**Chạy test:**
```bash
cd internal-portal
npm test          # 106 test cases — tất cả pass ✅
./test-api.sh     # 68 curl API checks — tất cả pass ✅
```

---

## Demo nhanh (cho buổi phỏng vấn)

**Demo 1 — Ticket khẩn cấp gửi cảnh báo tự động:**
```
Vào tab Tickets → tạo ticket mới với priority = "High"
→ Hệ thống tự ghi vào audit log, hiển thị trong Notifications
```

**Demo 2 — Xuất danh sách tài sản ra Excel:**
```
Vào tab IT Assets → lọc theo trạng thái → nhấn "Xuất Danh Sách (CSV)"
→ File CSV mở được trong Excel, tiếng Việt hiển thị đúng
```

**Demo 3 — Trợ lý AI gợi ý chẩn đoán sự cố:**
```
Vào tab Tickets → nhấn nút "AI" trên bất kỳ ticket nào
→ Hiển thị: tóm tắt sự cố, các bước chẩn đoán, nguyên nhân, cách phòng tránh
(Hoạt động cả khi không có Ollama — dùng playbook offline)
```

---

## Cấu trúc project

```
05-Enterprise-IT-Helpdesk-Lab/
├── 📁 tickets/              ← 20 kịch bản sự cố ITIL thực chiến
├── 📁 docs/                 ← Tài liệu lab: topology, AD setup, GPO, onboarding SOP
├── 📁 scripts/              ← PowerShell automation + CI helper scripts
└── 📁 internal-portal/      ← Web app Node.js
    ├── 📁 src/              ← API server (Express)
    ├── 📁 public/           ← Giao diện web (HTML/JS)
    └── 📁 test/             ← 106 test cases
```

---

## Tech stack

<p>
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white"/>
  <img src="https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white"/>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black"/>
  <img src="https://img.shields.io/badge/PowerShell-5391FE?style=for-the-badge&logo=powershell&logoColor=white"/>
  <img src="https://img.shields.io/badge/Windows_Server_2022-0078D4?style=for-the-badge&logo=windows&logoColor=white"/>
  <img src="https://img.shields.io/badge/Active_Directory-0078D4?style=for-the-badge&logo=microsoft&logoColor=white"/>
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white"/>
  <img src="https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=githubactions&logoColor=white"/>
</p>

---

## Tài liệu tham khảo

- [🗺️ Topology & cấu hình VM](docs/01-lab-topology-vmware.md)
- [🖥️ Cài đặt AD / DNS / DHCP](docs/02-ad-dns-dhcp-setup.md)
- [🔒 Ma trận GPO bảo mật](docs/03-gpo-security-matrix.md)
- [🎫 20 ticket sự cố](tickets/)
- [❓ Câu hỏi phỏng vấn Helpdesk](docs/06-interview-qa.md)

---

**MIT License** — *Dự án portfolio của **Mai Nguyễn Bình Tân*** — GitHub: [@imtarget05](https://github.com/imtarget05)
