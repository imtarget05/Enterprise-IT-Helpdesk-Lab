# Scenario 04 — Offboarding và thu hồi tài sản

## Mục tiêu
Khóa quyền truy cập, thu hồi asset và chứng minh thao tác idempotent.

## Điều kiện
- Có access request `OFFBOARDING`.
- User test và asset test đã được tạo.

## Thao tác
1. Chạy `Disable-CompanyUser.ps1 -SamAccountName ... -WhatIf`.
2. Xem xét group/asset evidence rồi apply.
3. Gọi `POST /api/access-requests/{id}/offboard` lần đầu và lần hai.
4. Kiểm tra account disabled, group bị gỡ, asset về kho.

## Kết quả mong đợi
Lần hai trả `idempotent=true`, không xóa account, asset có `IN_STOCK`/`Unassigned`, audit đầy đủ.

## Evidence
Output `-WhatIf`/apply, access request history, asset JSON và audit event.
