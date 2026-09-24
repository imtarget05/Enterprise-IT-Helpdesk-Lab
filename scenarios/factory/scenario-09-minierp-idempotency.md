# Scenario 09 — MiniERP retry idempotent

## Mục tiêu
Kiểm tra key authentication, payload sanitization và duplicate protection.

## Điều kiện
- `MINIERP_INTEGRATION_KEY` được cấu hình trong test process.
- Không dùng key thật trong evidence.

## Thao tác
1. Gửi payload hợp lệ với `externalRef` cố định.
2. Gửi lại nguyên payload.
3. Gửi cùng ref nhưng title khác.
4. Gửi thiếu/sai key.

## Kết quả mong đợi
201 → 200 `idempotent=true`; payload khác 409; source khác 422; sai key 401; description không còn HTML.

## Evidence
Response bodies đã redact key, ticket ID, audit event và OpenAPI path.
