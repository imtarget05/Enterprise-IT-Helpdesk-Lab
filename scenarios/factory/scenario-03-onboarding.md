# Scenario 03 — Onboarding nhân viên mới

## Mục tiêu
Kiểm tra chuỗi account → group → asset → handoff có kiểm soát.

## Điều kiện
- HR request hợp lệ có employee ID và phòng ban.
- Có CSV onboarding đã kiểm tra, không chứa password.

## Thao tác
1. Tạo access request `ONBOARDING` qua Portal.
2. Approve và lấy JSON handoff.
3. Chạy `New-CompanyUser.ps1 -CsvPath ...` trên DC.
4. Kiểm tra OU, UPN, group, forced password change.
5. Cấp asset qua API/UI và hoàn tất request.

## Kết quả mong đợi
User đăng nhập được, vào đúng OU/group, có mapped drive và asset assignment được audit.

## Evidence
CSV sanitized, handoff JSON, output New-CompanyUser, ảnh OU/group, asset ID và audit event.
