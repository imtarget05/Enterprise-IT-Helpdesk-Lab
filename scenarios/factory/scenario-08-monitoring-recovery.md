# Scenario 08 — Monitoring dedupe và recovery

## Mục tiêu
Chứng minh threshold tạo incident và retry không tạo ticket trùng.

## Điều kiện
- Có monitoring check với `failureThreshold=3`.
- Test probe trả `DOWN` rồi `UP`.

## Thao tác
1. Tạo check.
2. Run fail bốn lần.
3. Query ticket source `MONITORING` và history.
4. Run `UP`.
5. Kiểm tra incident resolve, `MONITOR_RECOVERED` và counter reset.

## Kết quả mong đợi
Chỉ một active incident, history đủ số lần run, recovery đóng đúng ticket.

## Evidence
`/api/monitoring/status`, history JSON, ticket ID, correlation ID và log probe.
