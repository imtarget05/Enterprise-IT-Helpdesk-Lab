# Scenario 01 — DHCP client nhận APIPA

## Mục tiêu
Chứng minh có thể phân biệt lỗi DHCP/VLAN với lỗi DNS và khôi phục kết nối client.

## Điều kiện
- Client `CL01-WIN11` trong VLAN10.
- DHCP scope và gateway `192.168.10.2` đã được cấu hình.
- Có quyền mở ticket L1.

## Thao tác
1. Tạm ngắt scope hoặc đặt sai VLAN trên port test.
2. Chạy `ipconfig /all`, ghi nhận `169.254.x.x` và lease time.
3. Kiểm tra link, switchport, DHCP service/scope và firewall.
4. Khôi phục cấu hình, chạy `ipconfig /release` rồi `ipconfig /renew`.
5. Tạo ticket P2/P1 tùy impact và đóng sau khi ping gateway + mở Portal.

## Kết quả mong đợi
Client nhận đúng IP trong `192.168.10.0/24`, gateway/DNS đúng, ticket có work note và RCA là DHCP/VLAN.

## Evidence
`scenario-01-dhcp-apipa.md`; lưu `ipconfig /all`, switchport log, ticket ID và thời điểm `renew`.
