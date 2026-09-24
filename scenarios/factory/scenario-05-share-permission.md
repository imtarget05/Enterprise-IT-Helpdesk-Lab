# Scenario 05 — Share permission bị từ chối

## Mục tiêu
Phân biệt quyền Share và NTFS, áp dụng least privilege và verify.

## Điều kiện
- Có user HR và Accounting thuộc group khác nhau.
- Share `\\FS01\HR` và `\\FS01\Accounting`.

## Thao tác
1. Test user HR truy cập share được phép.
2. Test user Accounting vào HR và ghi nhận Access Denied.
3. Kiểm tra Share permissions + NTFS ACE, group membership và group nesting.
4. Sửa đúng group/ACE, chạy `gpupdate` nếu cần.
5. Xác minh cả hai chiều allow/deny.

## Kết quả mong đợi
Không cấp quyền bằng `Everyone`; effective permission là giao điểm hạn chế nhất và test pass.

## Evidence
`icacls`, `Get-SmbShareAccess`, group membership, ticket work note và ảnh Access Denied.
