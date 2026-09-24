# Scenario 10 — Problem/Change approval

## Mục tiêu
Kiểm tra ITSM change có risk, approval, implement, verify và rollback plan.

## Điều kiện
- Có ticket liên quan và user có role phù hợp.
- Có snapshot/config backup trước thay đổi.

## Thao tác
1. Tạo problem và link ticket.
2. Tạo change high risk thiếu rollback plan để kiểm tra 422.
3. Tạo lại với rollback plan.
4. Approve, implement, kiểm tra service rồi close.
5. Đọc audit trail.

## Kết quả mong đợi
High-risk change không bypass approval; mọi state transition và rollback plan được ghi.

## Evidence
Problem/change JSON, linked ticket, approval actor, verification output và audit.
