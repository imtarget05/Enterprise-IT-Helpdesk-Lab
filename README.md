# 05-Enterprise-IT-Helpdesk-Lab

[![Environment](https://img.shields.io/badge/Environment-VMware%20%7C%20VirtualBox-blue.svg)]()
[![Platform](https://img.shields.io/badge/OS-Windows%20Server%202022%20%7C%20Win11-0078D6.svg)]()
[![ITIL](https://img.shields.io/badge/Framework-ITIL%20v4%20Aligned-green.svg)]()
[![Target](https://img.shields.io/badge/Target-OKIA%20Helpdesk%20%7C%20BMC%20IT-orange.svg)]()

Hệ thống phòng Lab thực hành Doanh nghiệp ảo hóa (Enterprise IT Lab) và Cổng quản lý Tài sản & Hỗ trợ nội bộ (IT Asset & Helpdesk Portal). Dự án được thiết kế chuyên biệt để đáp ứng 100% yêu cầu công việc cho hai vị trí:
1. **OKIA Việt Nam:** IT Helpdesk / IT Support / System & Network (1–2 năm kinh nghiệm).
2. **BMC Việt Nam:** Nhân viên IT (Phát triển phần mềm nội bộ + Hỗ trợ kỹ thuật văn phòng + Quản trị hạ tầng).

---

## 1. MÔ HÌNH HẠ TẦNG PHÒNG LAB (ENTERPRISE LAB TOPOLOGY)

```text
                           [INTERNET / WAN]
                                  │
                                  ▼
               +---------------------------------------+
               |     Virtual Router / Host Gateway     |
               |         (Subnet: 192.168.10.0/24)     |
               +---------------------------------------+
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
         ▼                        ▼                        ▼
+-----------------+      +-----------------+      +-----------------+
|   DC01-SERVER   |      |   FS01-SERVER   |      |   CL01-WIN11    |
| Windows Server  |      | Windows Server  |      | Windows 11 Pro  |
| 2022 Datacenter |      | 2022 Datacenter |      | Enterprise      |
| IP: 192.168.10.10|      | IP: 192.168.10.15|      | IP: DHCP Lease  |
|                 |      |                 |      |                 |
| Roles & Services|      | Roles & Services|      | User Client     |
| - AD DS (DC)    |      | - File Server   |      | - Domain Joined |
| - DNS Server    |      | - Shadow Copies |      | - Mapped Drives |
| - DHCP Server   |      | - Print Server  |      | - Outlook M365  |
| - GPO Manager   |      | - NTFS Shares   |      | - Endpoint EDR  |
+-----------------+      +-----------------+      +-----------------+
```

---

## 2. BỘ DANH MỤC 20 KỊCH BẢN SỰ CỐ THỰC CHIẾN (ITIL TICKETS)

Toàn bộ 20 tickets được biên soạn chi tiết theo tiêu chuẩn ITIL (Mô tả sự cố -> Chẩn đoán -> Phân tích nguyên nhân gốc rễ RCA -> Khắc phục từng bước -> Nghiệm thu & Phòng ngừa) tại thư mục `tickets/`:

| Ticket ID | Tiêu đề sự cố | Phân loại | Mức độ | Kỹ năng kỹ thuật chứng minh |
|---|---|---|---|---|
| [INC-1001](tickets/ticket-001-cannot-access-internet.md) | Cannot Access Internet (APIPA IP 169.254.x.x) | Network | High | Khắc phục lỗi DHCP Client, reset TCP/IP stack, renew IP. |
| [INC-1002](tickets/ticket-002-cannot-resolve-dns.md) | Cannot Resolve DNS (Localhost Loopback) | DNS | Medium | Chẩn đoán nslookup, khôi phục DNS DHCP, flushdns. |
| [INC-1003](tickets/ticket-003-account-locked-password-reset.md) | Account Locked Out & Credential Sync | Active Directory | High | Tra cứu Event Viewer ID 4740, mở khóa tài khoản, xử lý Wi-Fi mobile. |
| [INC-1004](tickets/ticket-004-cannot-access-network-share.md) | Access Denied on Shared Folder `\\FS01\HR` | File Server | Medium | Phân quyền Security Groups, cơ chế cập nhật vé Kerberos TGT. |
| [INC-1005](tickets/ticket-005-network-printer-offline.md) | Network Printer Offline after Power Outage | Printing | High | Xử lý kẹt IP máy in, tạo DHCP Reservation theo MAC, Print Spooler. |
| [INC-1006](tickets/ticket-006-dhcp-ip-conflict-apipa.md) | DHCP IP Conflict & Scope Exhaustion | Network | High | Bắt gói ARP, xử lý IP tĩnh đè động, mở rộng Scope DHCP. |
| [INC-1007](tickets/ticket-007-wifi-dropping-connection.md) | Wi-Fi Dropping & Roaming Disconnects | Wireless | Medium | Tối ưu Roaming Aggressiveness, ưu tiên băng tần 5GHz AX. |
| [INC-1008](tickets/ticket-008-outlook-cannot-connect-exchange.md) | Outlook Disconnected & Credential Cache Loop | M365 / Mail | High | Dọn dẹp Windows Credential Manager, reset Modern Auth Token. |
| [INC-1009](tickets/ticket-009-bsod-system-crash-analysis.md) | BSOD MEMORY_MANAGEMENT (0x1A) | Hardware | High | Đọc file Minidump bằng BlueScreenView, chạy MemTest86 thay RAM. |
| [INC-1010](tickets/ticket-010-disk-full-c-drive-cleanup.md) | Low Disk Space on Drive C: (450MB left) | Storage | Medium | Dọn SoftwareDistribution, VSSAdmin shadowstorage, hiberfil.sys. |
| [INC-1011](tickets/ticket-011-malware-quarantine-incident.md) | Trojan Dropper Malware Quarantine | Security | Critical | Cô lập mạng vật lý, ngắt cổng switch, dọn Registry run keys. |
| [INC-1012](tickets/ticket-012-accidental-file-deletion-shadow-copy.md) | Shift+Delete File Recovery via Shadow Copies | Data Recovery | High | Khôi phục file thuế kế toán qua Volume Shadow Copies (VSS). |
| [INC-1013](tickets/ticket-013-vpn-connection-failure.md) | Remote Access VPN Blocked at Hotel Wi-Fi | Network / VPN | High | Chẩn đoán Test-NetConnection, mở cổng dự phòng TCP 443. |
| [REQ-2014](tickets/ticket-014-new-laptop-onboarding-provision.md) | New Laptop Provisioning & Onboarding | Onboarding | Medium | Script tạo AD User, gán license M365, dán Asset Tag, bàn giao. |
| [REQ-2015](tickets/ticket-015-employee-termination-offboarding.md) | Employee Termination & IT Offboarding | Security | High | Khóa tài khoản tức thời, chuyển Shared Mailbox, thu hồi laptop. |
| [INC-1016](tickets/ticket-016-usb-storage-blocked-by-gpo.md) | USB Storage Blocked by Group Policy | Security GPO | Medium | Cấu hình ngoại lệ GPO Security Filtering cho phòng Marketing. |
| [INC-1017](tickets/ticket-017-slow-pc-performance-troubleshooting.md) | Slow PC Performance & Thermal Throttling | Hardware | Low | Tra keo tản nhiệt, vệ sinh quạt, khắc phục xung nhịp 0.79GHz. |
| [INC-1018](tickets/ticket-018-shared-folder-ntfs-vs-share-perms.md) | Shared Folder Read-Only Permissions Conflict | File Server | Medium | Khắc phục xung đột Share Permissions (Read) vs NTFS (Modify). |
| [INC-1019](tickets/ticket-019-voip-ip-phone-registration-failure.md) | VoIP IP Phone SIP Registration Failed | Telephony | High | Cấu hình Voice VLAN 20 trên Switch Cisco, mở cổng SIP UDP 5060. |
| [INC-1020](tickets/ticket-020-backup-failure-and-recovery-test.md) | Nightly Backup Failure & Recovery Drill | Backup / DR | Critical | Reset VSS Writers treo, dọn dẹp kho lưu trữ NAS, diễn tập restore. |

---

## 3. CÔNG CỤ TỰ ĐỘNG HÓA POWERSHELL (SCRIPTS)

- **`scripts/New-CompanyUser.ps1`:** Đọc file danh sách nhân viên mới dạng CSV, tự động khởi tạo tài khoản Active Directory, đưa vào đúng OU phòng ban, gán mật khẩu ngẫu nhiên an toàn và tự động cấp nhóm bảo mật.
- **`scripts/Export-ITAssetAudit.ps1`:** Tự động truy vấn WMI / CIM trên máy trạm để trích xuất đầy đủ thông số phần cứng (CPU, RAM, ổ đĩa, địa chỉ MAC, serial BIOS) và xuất báo cáo JSON phục vụ kiểm kê tài sản.
- **`scripts/Test-NetworkHealth.ps1`:** Bộ công cụ kiểm tra tự động 9 bước từ Loopback, Gateway, DNS nội bộ, cổng xác thực Kerberos/LDAP Domain Controller đến đường truyền internet quốc tế.
- **`scripts/verify-ps1-syntax.sh`:** Kiểm tra cú pháp 3 script ở trên bằng **AST parser chính thức của PowerShell** (`Language.Parser::ParseFile`), chạy qua `pwsh` local hoặc container `mcr.microsoft.com/powershell` — dùng được trên macOS/Linux nơi không có PowerShell.

> Đã sửa 1 lỗi parse có thật tìm thấy nhờ kiểm thử này: `New-CompanyUser.ps1` dùng `"$username:"` (PowerShell hiểu nhầm là scope/drive → "Variable reference is not valid"), nay viết đúng thành `"${username}:"`.

---

## 4. ỨNG DỤNG NỘI BỘ IT ASSET & HELPDESK PORTAL (DÀNH CHO JD BMC)

Ứng dụng web nội bộ hoàn chỉnh đặt tại thư mục `internal-portal/` (chi tiết: [`internal-portal/README.md`](internal-portal/README.md)):
- **Công nghệ:** Node.js + Express 4 (REST API), HTML5/CSS3 Responsive, Vanilla JavaScript. Persistence file JSON nguyên tử — **không cần database ngoài, 0 dependency native**.
- **Tính năng nổi bật:**
  - **Dashboard tổng quan:** KPI tài sản theo trạng thái, ticket mở/đóng, tỷ lệ SLA, biểu đồ cơ cấu theo loại, hàng đợi cảnh báo.
  - **Quản lý thiết bị (IT Assets):** Đăng ký Laptop/PC/Máy in/Switch, gán Asset Tag (unique — trùng sẽ bị từ chối 409), cấp phát / thu hồi, tìm kiếm + lọc + sắp xếp.
  - **Xuất báo cáo kiểm kê:** Nút **"Xuất Danh Sách Tài Sản (CSV)"** — file `IT-Asset-Audit_YYYYMMDD_HHmm.csv` chuẩn RFC-4180 kèm UTF-8 BOM, mở trực tiếp bằng Excel, tôn theo bộ lọc đang chọn.
  - **Quản lý Ticket hỗ trợ:** Tiếp nhận, phân loại sự cố ITIL, đóng/mở lại ticket; ticket **High/Critical tự động bắn cảnh báo** (mock Telegram/Email → cấu hình `IT_WEBHOOK_URL` để nối Slack/Teams thật).
  - **Quản lý bản quyền (Software Licenses):** Giám sát hạn tái tục, % sử dụng, cảnh báo hết chỗ cấp phát.
  - **Dữ liệu bền vững:** mọi thay đổi ghi vào `data/db.json` (atomic tmp→rename, corrupt-safe), sống sót qua restart process/container; graceful shutdown khi nhận SIGTERM.

### Hướng dẫn chạy Portal:
```bash
cd internal-portal
npm install
npm start                       # → http://localhost:3000
```

Chạy bằng Docker (khuyên dùng cho môi trường máy chủ):
```bash
docker compose up -d --wait     # data mount vào ./data, tự restart nếu treo (healthcheck)
```

Kiểm thử tự động:
```bash
npm test                        # ~93 assertion: unit + integration HTTP + restart persistence + UI contract
./test-api.sh                   # 61 kiểm tra curl phủ 100% REST endpoints, in bảng PASS/FAIL
bash ../scripts/verify-ps1-syntax.sh   # parse 3 script PowerShell bằng AST parser thật (Docker/pwsh)
```
