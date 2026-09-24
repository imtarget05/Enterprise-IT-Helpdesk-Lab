# 10 — Backup, Restore và Disaster Recovery

## Mục tiêu
Bảo đảm có thể phục hồi Portal, cấu hình AD/GPO và dữ liệu vận hành mà không ghi đè bản đang chạy.

## Phạm vi backup
| Đối tượng | Công cụ | Tần suất lab | Retention |
|---|---|---:|---:|
| `internal-portal/data/db.json` | `Backup-HelpdeskData.ps1` hoặc `src/backup.js` | Mỗi ngày | 14 bản |
| GPO | `Backup-ADConfiguration.ps1` | Trước thay đổi + hàng tuần | 14 bản |
| DHCP | `Export-DhcpServer` trong script AD backup | Hàng tuần | 14 bản |
| Cấu hình portal | Git + OpenAPI + README | Mỗi release | Theo Git |

## RPO/RTO
- RPO lab: tối đa 24 giờ cho Portal; backup trước mỗi thay đổi quan trọng.
- RTO mục tiêu: 30 phút để phục hồi JSON vào test path; production restore cần approval.
- Không coi file backup là hợp lệ nếu chưa kiểm tra JSON và SHA-256.

## Quy trình backup
1. Dừng mutation hoặc ghi nhận maintenance window.
2. Chạy `Backup-HelpdeskData.ps1 -DataDir ./data -Retention 14`.
3. Lưu file `.sha256` cùng backup.
4. Chạy `Backup-ADConfiguration.ps1`; đọc `manifest.json` xác nhận GPO/DHCP/DNS.
5. Lưu output vào evidence directory, không commit secret.

## Quy trình restore an toàn
1. Tạo target path riêng, ví dụ `data/restore-test/db.json`; không ghi đè live DB ở lần đầu.
2. Chạy `Restore-HelpdeskData.ps1 -BackupFile ... -TargetFile ...`.
3. Xác minh checksum và parse JSON.
4. Khởi động test instance trỏ target path; kiểm tra `/api/health`, counts và một ticket/asset.
5. Chỉ dùng `-Force` sau khi có approval, backup mới và evidence ghi rõ thời điểm cutover.

## DR decision
- Sự cố dữ liệu: restore bản gần nhất, so sánh checksum/counts, ghi ticket.
- Sự cố host: dựng VM theo topology, restore AD/GPO trước, restore Portal sau.
- Sự cố toàn lab: dùng snapshot đã tạo trước thay đổi; không xóa snapshot gần nhất cho tới khi P1/P2 đóng.

## Evidence
- File backup, `.sha256`, `manifest.json`.
- Output validation và smoke test trên target path.
- `db.json` diff/counts, thời gian bắt đầu/kết thúc.
- Ticket recovery/change kèm approval và rollback plan.
