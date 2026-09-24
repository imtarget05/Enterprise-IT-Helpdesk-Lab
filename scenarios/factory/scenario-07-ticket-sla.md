# Scenario 07 — Ticket P1 và SLA breach

## Mục tiêu
Kiểm tra priority/SLA, assignment, timeline và escalation.

## Điều kiện
- Có ticket impact/urgency cao từ monitoring hoặc người dùng.
- Clock/test hook có thể dùng khi cần.

## Thao tác
1. Tạo ticket impact `HIGH`, urgency `HIGH`.
2. Kiểm tra `priorityCode=P1`, acknowledge/resolve target.
3. Gán assignee, thêm work note và chuyển `IN_PROGRESS`.
4. Kiểm tra ticket sau target time để ghi SLA breach.
5. Resolve với code/summary rồi verify.

## Kết quả mong đợi
Timeline đầy đủ, alert đúng ngưỡng, SLA breach/alert không làm mất ticket.

## Evidence
JSON ticket, timeline, notification log, clock/response và ticket ID.
