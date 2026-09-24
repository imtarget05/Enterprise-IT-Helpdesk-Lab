# 09 — Monitoring và Incident Runbook

## Mục tiêu
Phát hiện sớm lỗi hạ tầng/dịch vụ, chuyển thành ticket có correlation rõ ràng và tự động phục hồi khi service trở lại.

## Check contract
Portal hỗ trợ `HTTP`, `TCP`, `DNS`. Mỗi check có `failureThreshold`; probe `DOWN/DEGRADED` tăng counter, `UP` reset counter. Khi counter đạt threshold và chưa có incident mở, Portal tạo ticket source `MONITORING` với `monitorCheckId`.

## Lớp chẩn đoán
1. **Power/host**: VM còn chạy, disk không đầy, service/process có sống.
2. **Network**: link, VLAN, gateway, ARP, firewall.
3. **DNS/AD**: query forward, port 53/88/389, domain join.
4. **Application**: health endpoint, dependency, queue/database.
5. **Service desk**: assign, work note, transition, verify, close.

## Runbook ticket
1. Tạo ticket với service, impact/urgency và mô tả lỗi.
2. Gán `assignee`/nhóm, ghi work note có timestamp.
3. Chuyển `IN_PROGRESS` khi bắt đầu kiểm tra.
4. Khi tìm nguyên nhân, ghi RCA/work note; khi khắc phục, transition `RESOLVED` với `resolutionCode` và `resolutionSummary`.
5. Chỉ `CLOSED` sau verification và xác nhận SLA/monitoring đã phục hồi.

## Dedupe và recovery
- Nhiều lần fail khi incident đang mở không tạo ticket trùng.
- History lưu `checkId`, status, message, `consecutiveFailures`, `correlationId`.
- Probe `UP` tự resolve ticket monitoring, ghi `MONITOR_RECOVERED` và xóa active incident.
- Không xóa history để phục vụ RCA và capacity review.

## Threshold gợi ý
| Dịch vụ | Threshold mặc định | Escalation |
|---|---:|---|
| DC/DNS/AD | 2–3 | P1 nếu toàn domain |
| Portal health | 3 | P1 nếu mất toàn bộ portal |
| ERP/MiniERP | 3 | P1/P2 theo impact |
| Printer | 5 | L2 sau 15 phút |

## Evidence
- JSON `/api/monitoring/status`, `/api/monitoring/history`.
- Ticket ID và `monitorCheckId` trong timeline.
- Log probe/status trước, trong và sau recovery.
- `Test-NetworkHealth.ps1` hoặc `Test-PrintScanHealth.ps1` output.
