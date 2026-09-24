# Scenario 02 — DNS nội bộ thất bại

## Mục tiêu
Chẩn đoán đúng lỗi DNS khi IP vẫn hoạt động nhưng không phân giải tên.

## Điều kiện
- Client có IP hợp lệ và ping được gateway.
- DC01 đang chạy DNS/AD.

## Thao tác
1. Chạy `nslookup dc01.company.local` và `nslookup google.com`.
2. Kiểm tra DNS client, port 53, forwarder, cache và firewall.
3. So sánh query trực tiếp tới DC với query qua resolver.
4. Khôi phục DNS/flush cache, xác minh join domain và Internet.

## Kết quả mong đợi
Phân giải nội bộ trở lại; ticket nêu rõ lớp lỗi và có prevention (đặt cảnh báo DNS).

## Evidence
Output `nslookup`, `Resolve-DnsName`/`ipconfig /dns`, ticket timeline và monitoring health.
