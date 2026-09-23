#!/usr/bin/env bash
# =============================================================================
# scripts/prepare-data-dir.sh
# =============================================================================
# Chuẩn bị thư mục dữ liệu cho portal (bind mount).
#
# Cách dùng:
#   # Linux server (chown cho UID/GID của user 'node' trong image = 1000:1000)
#   ./scripts/prepare-data-dir.sh ./data
#
#   # macOS: script sẽ chown nếu có sudo, hoặc skip khuyến nghị chmod
#   ./scripts/prepare-data-dir.sh ./data
#
#   # Kiểm tra nhanh: docker run --rm -v $PWD/data:/app/data node:18 id -u
#     → nên trả về 1000 (tương đương UID node trong image).
#
# Lưu ý:
#   - Trên macOS/Windows (Docker Desktop) bind mount thường tự mapping permission
#     nên không cần chown. Script chỉ dùng để chuẩn bị sẵn hoặc server Linux.
#   - Nếu dùng named volume (compose.prod.yml), thư mục dữ liệu quản lý bởi Docker
#     → không cần chạy script này (Docker mount volume với UID/KGID trong image).
# =============================================================================
set -euo pipefail

DATA_DIR="${1:-./data}"

if [ ! -d "$DATA_DIR" ]; then
  echo "==> Tạo thư mục dữ liệu: $DATA_DIR"
  mkdir -p "$DATA_DIR"
fi

# UID/GID của user 'node' trong image bmc/it-asset-helpdesk-portal = 1000:1000
NODE_UID=1000
NODE_GID=1000

# Kiểm tra xem thư mục có thuộc về user node không
CURRENT_UID=$(stat -c '%u' "$DATA_DIR" 2>/dev/null || stat -f '%u' "$DATA_DIR" 2>/dev/null || true)

if [ "$CURRENT_UID" != "$NODE_UID" ]; then
  echo "==> Thư mục $DATA_DIR hiện thuộc UID $CURRENT_UID (node UID = $NODE_UID)."
  if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    echo "   Chown $DATA_DIR về $NODE_UID:$NODE_GID..."
    chown -R "$NODE_UID:$NODE_GID" "$DATA_DIR"
    chmod 750 "$DATA_DIR"
    echo "   Done."
  elif command -v sudo >/dev/null 2>&1; then
    echo "   ⚠️  Khuyến nghị: chạy 'sudo chown -R $NODE_UID:$NODE_GID $DATA_DIR'"
    echo "       và 'sudo chmod 750 $DATA_DIR' trên server Linux перед khi docker compose up."
    echo "   (Trên macOS/Windows Docker Desktop, bind mount thường tự xử lý permission.)"
  else
    echo "   ⚠️  Không có sudo; vui lòng chạy thủ công:"
    echo "       sudo chown -R $NODE_UID:$NODE_GID $DATA_DIR"
    echo "       sudo chmod 750 $DATA_DIR"
  fi
else
  echo "==> $DATA_DIR đã thuộc UID $NODE_UID (node). Không cần chown."
fi

echo ""
echo "==> Kiểm tra nhanh permission:"
if [ -w "$DATA_DIR" ]; then
  echo "    Viết được: OK"
  touch "$DATA_DIR/.write-test" && rm -f "$DATA_DIR/.write-test"
  echo "    Test ghi/xóa thư mục: OK"
else
  echo "    Viết không được: ⚠️  Cần sửa permission (xem hướng dẫn trên)."
fi
