# Enterprise IT Helpdesk Lab — VMware / VirtualBox Topology

Tài liệu thiết kế mô hình phòng Lab Doanh nghiệp ảo hóa chạy trên VMware Workstation / Fusion hoặc VirtualBox phục vụ thực hành các kỹ năng **IT Helpdesk, System Administrator và Network Operations**.

---

## 1. SƠ ĐỒ MẠNG PHÒNG LAB (NETWORK TOPOLOGY)

```text
                           [INTERNET / WAN]
                                  │
                                  ▼
               +---------------------------------------+
               |     Virtual Router / Host Gateway     |
               |         (VMware NAT: VMnet8)          |
               |         Subnet: 192.168.10.0/24       |
               |         Gateway: 192.168.10.2         |
               +---------------------------------------+
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
         ▼                        ▼                        ▼
+-----------------+      +-----------------+      +-----------------+
|   DC01-SERVER   |      |   FS01-SERVER   |      |   CL01-WIN11    |
| Windows Server  |      | Windows Server  |      | Windows 11 Pro  |
| 2022 Datacenter |      | 2022 Datacenter |      | Enterprise      |
| IP: 192.168.10.10|      | IP: 192.168.10.15|      | IP: 192.168.10.101|
| (Static)        |      | (Static)        |      | (DHCP Lease)    |
|                 |      |                 |      |                 |
| Roles & Services|      | Roles & Services|      | User Client     |
| - AD DS (DC)    |      | - File Server   |      | - Joined Domain |
| - DNS Server    |      | - NTFS Shares   |      | - Outlook M365  |
| - DHCP Server   |      | - Shadow Copies |      | - Network Drives|
| - GPO Manager   |      | - Print Server  |      | - Endpoint AV   |
+-----------------+      +-----------------+      +-----------------+
```

---

## 2. BẢNG THÔNG SỐ CẤU HÌNH CÁC MÁY ẢO (VM SPECIFICATIONS)

| VM Name | Hệ điều hành | CPU / RAM / Disk | Cấu hình IP | Vai trò chính |
|---|---|---|---|---|
| **DC01-SRV** | Windows Server 2022 | 2 vCPU, 4GB RAM, 60GB Disk | IP: `192.168.10.10`<br>Subnet: `255.255.255.0`<br>Gateway: `192.168.10.2`<br>DNS: `127.0.0.1` | Primary Domain Controller quản lý domain `COMPANY.LOCAL`, Active Directory, DNS Server nội bộ, DHCP Server cấp IP dải động. |
| **FS01-SRV** | Windows Server 2022 | 2 vCPU, 4GB RAM, 80GB Disk | IP: `192.168.10.15`<br>Subnet: `255.255.255.0`<br>Gateway: `192.168.10.2`<br>DNS: `192.168.10.10` | File & Print Server: Chia sẻ thư mục dùng chung (`\\FS01\HR`, `\\FS01\Accounting`, `\\FS01\Public`), cấu hình Shadow Copies và Print Queue. |
| **CL01-WIN11** | Windows 11 Pro | 2 vCPU, 4GB RAM, 50GB Disk | IP: `DHCP` (Nhận từ DC01 dải `192.168.10.100-200`)<br>DNS: `192.168.10.10` | Client PC của nhân viên, Join Domain `COMPANY.LOCAL`, kiểm thử các chính sách GPO, quyền truy cập thư mục và sự cố mạng. |

---

## 3. CẤU HÌNH VMWARE NETWORK ADAPTER
- **Network Mode:** Custom: Specific virtual network (`VMnet8 - NAT`).
- **Lưu ý quan trọng:** Tắt tính năng DHCP mặc định của VMware trên VMnet8 (*Virtual Network Editor -> bỏ tích "Use local DHCP service to distribute IP address to VMs"*) để máy chủ **DC01-SRV** đảm nhận độc quyền việc cấp phát IP qua DHCP Server của Windows Server, tránh xung đột cấp phát IP ảo.
