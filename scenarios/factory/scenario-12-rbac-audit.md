# Scenario 12 — RBAC và audit evidence

## Mục tiêu
Chứng minh quyền tối thiểu, anonymous bị chặn và mutation được audit.

## Điều kiện
- `AUTH_MODE=lab` với admin, L1 và auditor test accounts.
- Không dùng password thật trong repo/evidence.

## Thao tác
1. Gọi mutation không có token.
2. Login từng role bằng test credentials.
3. Thử L1 tạo change và auditor tạo asset.
4. Cho auditor đọc ticket/audit rồi logout.
5. Đọc audit event sau các mutation hợp lệ.

## Kết quả mong đợi
401 anonymous, 403 role không đủ quyền, 200 read đúng, logout vô hiệu token và audit actor đúng.

## Evidence
Response status đã redact credentials, role matrix, audit JSON và access request.
