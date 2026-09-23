# Fixtures — dữ liệu mẫu để restore nhanh

| File | Nội dung |
|---|---|
| `db.baseline.json` | Snapshot dữ liệu demo **chuẩn** (6 assets, 6 tickets ITIL, 4 licenses) đúng như lần seed đầu tiên — dùng để khôi phục môi trường demo trước khi đi phỏng vấn/buổi demo. |

## Khôi phục dữ liệu demo (không cần xoá tay)

```bash
cd internal-portal
cp fixtures/db.baseline.json data/db.json     # ghi đè dữ liệu đang có
npm start                                     # portal đọc lại đúng snapshot này
```

Hoặc khi chạy Docker:

```bash
cd internal-portal
cp fixtures/db.baseline.json data/db.json
docker compose restart it-portal
```

> Lưu ý: `data/db.json` bị `.gitignore` (dữ liệu runtime). Chỉ snapshot trong
> `fixtures/` mới được commit — nhờ vậy repo luôn có sẵn một bộ dữ liệu demo
> tái lập được mà không làm bẩn git history.
