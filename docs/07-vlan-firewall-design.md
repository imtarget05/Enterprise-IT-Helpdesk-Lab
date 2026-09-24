# 07 — VLAN, Firewall và Segment Network

## Mục tiêu
Thiết kế mạng phòng lab theo nguyên tắc segment theo vai trò, giới hạn blast radius và ghi rõ đường đi của traffic.

## Mô hình địa chỉ

| VLAN | Dải mạng | Vai trò | Gateway | DNS chính |
|---|---|---|---|---|
| VLAN10 | `192.168.10.0/24` | Office/client | `192.168.10.2` | `192.168.10.10` |
| VLAN20 | `192.168.20.0/24` | Server/AD | `192.168.20.2` | `192.168.20.10` |
| VLAN30 | `192.168.30.0/24` | Management | `192.168.30.2` | `192.168.20.10` |
| VLAN40 | `192.168.40.0/24` | Print/Scanner/OT-ish | `192.168.40.2` | `192.168.20.10` |
| VLAN50 | `192.168.50.0/24` | Quarantine | `192.168.50.2` | `192.168.20.10` |
| VLAN99 | `192.168.99.0/24` | Management jump | `192.168.99.2` | `192.168.20.10` |

## Nguyên tắc triển khai
1. Mỗi VLAN là một broadcast domain riêng; không để client đổi IP tĩnh để né scope DHCP.
2. DHCP relay chỉ nhận request từ interface được phép; Option 03 trỏ gateway đúng VLAN, Option 006 trỏ DC DNS nội bộ.
3. Firewall cho phép DNS từ VLAN10/30 tới DNS server; chỉ cho phép SMB/RDP theo nhu cầu, mặc định chặn lateral movement.
4. Management VLAN99 chỉ nhận SSH/RDP từ jump host, không phải từ toàn bộ Office.
5. Printer VLAN40 chỉ nhận print traffic và DNS; client Office chỉ truy cập được print service cần thiết.
6. Mọi thay đổi ACL phải có ticket, ảnh export cấu hình trước/sau và rollback command.

## Ma trận kiểm tra tối thiểu

| Nguồn | Đích | Cổng | Kết quả mong đợi |
|---|---|---|---|
| VLAN10 | DC DNS | TCP/UDP 53 | Cho phép |
| VLAN10 | Gateway default | ICMP | Theo policy |
| VLAN10 | VLAN20 SMB | TCP 445 | Theo share ACL |
| VLAN10 | VLAN10 | TCP 445 | Cho phép nếu file share nằm cùng segment |
| VLAN99 | VLAN20 | TCP 22/3389 | Chỉ qua jump host |
| VLAN40 | VLAN20 | TCP 80/631/9100 | Theo printer policy |
| VLAN50 | Office/Server | Mặc định | Block |

## Quy trình triển khai và rollback
1. Export cấu hình switch/router hiện tại.
2. Tạo VLAN, port-access/trunk và DHCP helper từng segment.
3. Áp ACL theo ma trận; kiểm tra syntax trước khi apply.
4. Chạy `Test-NetworkHealth.ps1` từ client đại diện mỗi VLAN.
5. Nếu mất kết nối, rollback bằng bản export cũ; không xóa scope/ACL mới trước khi xác nhận không còn phụ thuộc.

## Evidence
- `docs/01-lab-topology-vmware.md` và bản export topology.
- Screenshot hoặc text output kiểm tra từng dòng ma trận.
- Output `Test-NetworkHealth.ps1` trong `artifacts/factory-it-upgrade/evidence/`.
- Ticket change có `rollbackPlan` và ảnh diff cấu hình.
