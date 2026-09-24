# 11 — MiniERP Integration Contract

## Mục tiêu
Nhận incident từ MiniERP an toàn, chống duplicate, sanitize payload và tạo ticket Helpdesk có thể truy vết ngược.

## Authentication
- Endpoint: `POST /api/integrations/minierp/incidents`.
- Header: `Authorization: Bearer <MINIERP_INTEGRATION_KEY>`.
- Key phải lấy từ secret store/environment variable, không commit vào repo.
- Key sai hoặc thiếu trả `401`; không tạo ticket.

## Payload bắt buộc

```json
{
  "externalRef": "ERP-2026-0001",
  "title": "ERP transaction failed",
  "severity": "HIGH",
  "service": "MiniERP",
  "description": "Sanitized text only",
  "referenceType": "ORDER",
  "referenceNo": "SO-001"
}
```

## Idempotency
1. Receiver chỉ chấp nhận `source=MINIERP`; khóa tìm ticket là `MINIERP + externalRef`.
2. Payload đầu tiên tạo ticket `201` và lưu fingerprint.
3. Retry cùng payload trả ticket cũ `200`, kèm `idempotent=true`.
4. Cùng `externalRef` nhưng payload khác trả `409`; không overwrite ticket.
5. `correlationId`, `referenceType`, `referenceNo` được lưu để đối chiếu vận hành.

## Mapping severity
| Severity | Impact | Priority path |
|---|---|---|
| LOW | LOW | P4 |
| MEDIUM | MEDIUM | P3 |
| HIGH | HIGH | P2/P1 theo context |
| CRITICAL | HIGH | P1 |

## Retry và failure handling
- Retry 5xx/backoff ở phía MiniERP với cùng `externalRef`.
- Không retry 400/401/409; sửa payload/key trước.
- Portal không gọi MiniERP ngược lại trong luồng nhận incident.
- Alert webhook của Portal là fail-soft; lỗi notifier không làm mất ticket đã commit.

## Security/privacy
- Strip control/HTML khỏi description trước khi lưu.
- Không gửi password, token, SQL hoặc dữ liệu khách hàng nhạy cảm vào payload.
- Audit integration key rejection, không ghi key vào audit details.
- Kiểm tra payload size và external reference length.

## Evidence
- Request đầu tiên, retry cùng payload và retry payload khác.
- ID ticket, `idempotent=true`/`409` và timeline.
- Audit event `TICKET_CREATED` với `source=MINIERP`.
- OpenAPI path `/api/integrations/minierp/incidents` và test enterprise upgrade.
