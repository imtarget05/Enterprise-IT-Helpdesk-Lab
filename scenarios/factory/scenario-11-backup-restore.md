# Scenario 11 — Backup restore vào test path

## Mục tiêu
Chứng minh backup có checksum và restore không làm hỏng dữ liệu live.

## Điều kiện
- Có `data/db.json` hợp lệ.
- Có thư mục restore-test riêng.

## Thao tác
1. Chạy `Backup-HelpdeskData.ps1` hoặc `backupPortalData`.
2. Kiểm tra file `.sha256` và JSON.
3. Restore vào target path riêng.
4. Boot app/test client với target path và gọi health.
5. So sánh counts/một record với backup.

## Kết quả mong đợi
Live DB không đổi; target parse được, checksum khớp và health trả 200.

## Evidence
Backup/checksum, restore output, target health/counts, thời gian và diff.
