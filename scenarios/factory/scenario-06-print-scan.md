# Scenario 06 — Printer và scanner offline

## Mục tiêu
Kiểm tra thiết bị nhà máy theo lớp network, print queue, driver và scanner input.

## Điều kiện
- Print server `FS01`, label printer và scanner test.
- Có script `Test-PrintScanHealth.ps1`.

## Thao tác
1. Chạy script kiểm tra SMB 445, TCP 9100, MiniERP health và USB wedge.
2. Kiểm tra queue, driver, IP/VLAN, port và nguồn điện.
3. Xử lý lỗi đầu tiên tìm thấy; không cài driver tùy tiện.
4. In test page và quét barcode/ID.
5. Đóng ticket sau verification.

## Kết quả mong đợi
Thiết bị online, test page/barcode đúng; ticket ghi rõ lớp lỗi.

## Evidence
JSON/script output, print queue log, test page/scanner artifact và asset ID.
