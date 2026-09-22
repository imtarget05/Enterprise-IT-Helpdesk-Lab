# Enterprise IT Helpdesk Lab — Active Directory, DNS & DHCP Setup Guide

Hướng dẫn chi tiết từng bước cấu hình Domain Controller, Active Directory Domain Services (AD DS), DNS Forwarders, Reverse Lookup và DHCP Scope cho doanh nghiệp giả định `COMPANY.LOCAL`.

---

## 1. THIẾT LẬP ACTIVE DIRECTORY DOMAIN SERVICES (AD DS)

### Cấu hình Domain Root
- **Forest & Domain Name:** `COMPANY.LOCAL`
- **Forest Functional Level:** Windows Server 2016 (tương thích tối đa).
- **Domain Controller Name:** `DC01`

### Cấu trúc Organizational Units (OU) & Phân quyền bảo mật
```text
COMPANY.LOCAL
└── Company_Enterprise (Root OU)
    ├── Departments
    │   ├── Management (BOD, Trưởng phòng)
    │   ├── Human_Resources (Nhân sự)
    │   ├── Accounting_Finance (Kế toán & Tài chính)
    │   ├── IT_Department (Bộ phận CNTT & Helpdesk)
    │   └── Sales_Marketing (Kinh doanh)
    ├── Security_Groups
    │   ├── SG_HR_Users (Nhóm nhân viên nhân sự)
    │   ├── SG_Accounting_Users (Nhóm nhân viên kế toán)
    │   ├── SG_IT_Admins (Nhóm quản trị viên IT)
    │   └── SG_VPN_RemoteAccess (Nhóm được phép kết nối VPN)
    ├── Service_Accounts (Tài khoản chạy dịch vụ sao lưu, SQL)
    └── Workstations (Chứa toàn bộ máy tính bàn và laptop nhân viên)
```

---

## 2. CẤU HÌNH HỆ THỐNG PHÂN GIẢI TÊN MIỀN (DNS SERVER)

### A. Forward Lookup Zones
- **Zone:** `company.local` (Active Directory-Integrated, Secure Dynamic Updates only).
- Bản ghi chủ chốt:
  - `dc01.company.local` -> `192.168.10.10`
  - `fs01.company.local` -> `192.168.10.15`
  - `portal.company.local` -> `192.168.10.10` (CNAME hoặc A record trỏ về web nội bộ)

### B. DNS Forwarders (Truy cập Internet ra ngoài)
Để các máy trong mạng domain vừa phân giải được tên máy nội bộ, vừa lướt web bên ngoài mượt mà, cấu hình DNS Forwarders tại DC01:
- Primary Forwarder: `8.8.8.8` (Google Public DNS)
- Secondary Forwarder: `1.1.1.1` (Cloudflare DNS)

### C. Reverse Lookup Zone
- **Network ID:** `192.168.10.0/24`
- Tự động tạo bản ghi PTR khi client đăng ký IP để phục vụ lệnh `nslookup [IP]` và kiểm tra bảo mật Kerberos.

---

## 3. CẤU HÌNH MÁY CHỦ CẤP PHÁT IP ĐỘNG (DHCP SERVER)

### Cấu hình Scope chính: `LAN_VLAN10_Offices`
- **Dải IP cấp phát:** `192.168.10.100` đến `192.168.10.200`
- **Subnet Mask:** `255.255.255.0`
- **Dải loại trừ (Exclusions):** `192.168.10.1` đến `192.168.10.30` (Dành riêng cho Router, Server, Switch và Máy in tĩnh).
- **Lease Duration:** 8 ngày (chuẩn văn phòng cố định).

### Cấu hình DHCP Options bắt buộc (Scope Options):
- **Option 003 (Router / Default Gateway):** `192.168.10.2`
- **Option 006 (DNS Servers):** `192.168.10.10` (Phải là IP của Domain Controller, không được trỏ thẳng 8.8.8.8 vì client sẽ không thể Join Domain và xác thực Kerberos).
- **Option 015 (DNS Domain Name):** `company.local`

### DHCP Reservation cho Máy in & Thiết bị quan trọng:
- `192.168.10.25`: Máy in văn phòng HP LaserJet Enterprise (MAC Address: `00-11-22-33-44-55`).
