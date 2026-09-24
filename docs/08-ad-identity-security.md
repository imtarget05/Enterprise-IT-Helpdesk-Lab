# 08 — Active Directory, Identity và Security

## Mục tiêu
Chuẩn hóa OU, group, role và vòng đời tài khoản để mọi thao tác nhân sự có người phụ trách, quyền tối thiểu và audit trail.

## Domain design
- Domain: `COMPANY.LOCAL`.
- OU gốc: `OU=Company_Enterprise`.
- Department OU: `HR`, `Accounting_Finance`, `IT_Department`, `Sales_Marketing`.
- Workstation OU: `OU=Workstations`.
- Service account tách riêng, không dùng account nhân viên cho backup/service.
- Group nhạy cảm: `SG_IT_Admins`, `SG_VPN_RemoteAccess`, `SG_HR_Users`, `SG_Accounting_Users`.

## RBAC portal

| Role | Quyền chính |
|---|---|
| `IT_ADMIN` | Toàn bộ mutation, monitoring, audit |
| `HELPDESK_L1` | Ticket, asset ghi, problem ghi |
| `HELPDESK_L2` | Như L1 + assign/change/monitor |
| `AUDITOR` | Đọc dữ liệu và audit, không mutation |
| `VIEWER` | Chỉ đọc |
| `INTEGRATION_MINIERP` | Receiver integration, không quyền admin portal |

## Onboarding
1. HR gửi request có `employeeId`, họ tên, phòng ban, nhóm cần thiết.
2. IT admin kiểm tra ticket và tạo access request trong Portal.
3. Chạy `New-CompanyUser.ps1` từ CSV; kiểm tra OU, UPN, group và forced password change.
4. Cấp tài sản qua `POST /api/assets/{id}/assign` và đăng ký serial.
5. Ghi evidence trong access request rồi chuyển `COMPLETED`.
6. Người dùng đăng nhập lần đầu đổi mật khẩu; ticket chỉ đóng sau khi xác minh mapped drive/OU.

## Offboarding
1. Disable account trước; không xóa account để giữ SID/audit.
2. Gỡ nhóm nhạy cảm, VPN, ERP role và thu hồi session/token.
3. Chạy `Disable-CompanyUser.ps1 -WhatIf`, xem evidence rồi mới apply.
4. Thu hồi asset qua `POST /api/assets/{id}/recover`, chuyển kho nếu phù hợp.
5. Hoàn tất `POST /api/access-requests/{id}/offboard`; gọi lần hai phải trả `idempotent=true`.

## Security controls
- Không ghi password/token vào ticket, log hoặc AI context.
- Audit đọc bằng role riêng; mutation nhạy cảm phải có actor, role, timestamp.
- Kiểm tra `gpresult /h` sau khi áp GPO; test bằng user thuộc scope thực tế.
- Backup GPO trước thay đổi; rollback bằng bản `Backup-GPO` gần nhất.

## Evidence
- CSV onboarding đã sanitize, output script và ảnh OU/group.
- JSON response của access request/handoff/offboard.
- `gpresult /h` hoặc `gpresult /r` lưu vào evidence.
- Audit event `ACCESS_REQUEST_*`, `TICKET_*`, `ASSET_*`.
