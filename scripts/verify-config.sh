#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_PROJECT_DIR="$REPO_ROOT/internal-portal"
COMPOSE_FILE="$COMPOSE_PROJECT_DIR/docker-compose.yml"
ENV_EXAMPLE="$COMPOSE_PROJECT_DIR/.env.example"

echo "============================================================================="
echo "  VERIFY CONFIG — IT Asset & Helpdesk Portal"
echo "============================================================================="

# 1. Check prerequisites
echo ""
echo "[1] Kiểm tra môi trường"
if ! command -v docker >/dev/null 2>&1; then
  echo "  ❌ Docker không tìm thấy."
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  echo "  ✅ Docker Compose v$(docker compose version | grep -oE '[0-9.]+' | head -1)"
else
  echo "  ⚠️  Docker Compose không tìm thấy."
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "  ❌ Compose file không tồn tại: $COMPOSE_FILE"
  exit 1
fi
echo "  ✅ Compose file: $COMPOSE_FILE"

# 2. Validate compose config
echo ""
echo "[2] Validate compose config"
if ! docker compose -f "$COMPOSE_FILE" config --quiet 2>/dev/null; then
  echo "  ❌ Compose config có lỗi."
  exit 1
fi
echo "  ✅ docker compose config --quiet ✓"

# 3. Check variables interpolation
echo ""
echo "[3] Kiểm tra biến interpolation"
COMPOSE_VARS=$(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$COMPOSE_FILE" 2>/dev/null | sort -u)
COMPOSE_VAR_NAMES=""
while IFS= read -r cv; do
  [ -z "$cv" ] && continue
  name=${cv#\$\{}
  name=${name%%:*}
  COMPOSE_VAR_NAMES="${COMPOSE_VAR_NAMES}${name}"$'\n'
done <<< "$COMPOSE_VARS"

if [ -f "$ENV_EXAMPLE" ]; then
  ENV_VARS=$(grep -oE '^[A-Z][A-Z0-9_]*' "$ENV_EXAMPLE" | sort)
  MISSING=""
  while IFS= read -r cv; do
    [ -z "$cv" ] && continue
    cv_lower=$(echo "$cv" | tr '[:upper:]' '[:lower:]')
    found=false
    while IFS= read -r ev; do
      [ -z "$ev" ] && continue
      ev_lower=$(echo "$ev" | tr '[:upper:]' '[:lower:]')
      if [ "$cv_lower" = "$ev_lower" ]; then found=true; break; fi
    done <<< "$ENV_VARS"
    if [ "$found" = false ]; then
      MISSING="${MISSING}  - \$${cv}"$'\n'
    fi
  done <<< "$COMPOSE_VAR_NAMES"
  if [ -n "$MISSING" ]; then
    echo "  ⚠️  Các biến sau chưa có trong .env.example:"
    echo -n "$MISSING"
  else
    echo "  ✅ Tất cả biến interpolation đều có trong .env.example"
  fi
else
  echo "  ⚠️  Không tìm thấy .env.example — không thể kiểm tra biến."
fi
# 4. Check container health
echo ""
echo "[4] Kiểm tra container & health"
RUNNING=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.State}}' 2>/dev/null | head -1 || true)
if [ "$RUNNING" != "running" ]; then
  echo "  ⚠️  Container không chạy (state: ${RUNNING:-unknown})."
else
  CONTAINER_ID=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.ID}}' 2>/dev/null | head -1)
  echo "  ✅ Container đang chạy (ID: ${CONTAINER_ID:0:12})"
  HEALTH=$(docker inspect "$CONTAINER_ID" --format '{{.State.Health.Status}}' 2>/dev/null || echo "unknown")
  echo "  → Health status: $HEALTH"
  if echo "$HEALTH" | grep -qiE 'healthy|starting'; then
    echo "  ✅ Healthcheck hoạt động."
  fi
  if docker inspect "$CONTAINER_ID" --format '{{json .Config.Healthcheck.Test}}' 2>/dev/null | grep -q "process.env.PORT"; then
    echo "  ✅ Healthcheck dùng process.env.PORT (không hardcode 3000)."
  else
    echo "  ⚠️  Healthcheck có thể hardcode port."
  fi
fi

# 5. Check security options (if running)
echo ""
echo "[5] Kiểm tra bảo mật container (nếu chạy)"
if [ "${RUNNING:-}" = "running" ] && [ -n "${CONTAINER_ID:-}" ]; then
  if docker inspect "$CONTAINER_ID" --format '{{json .HostConfig.CapDrop}}' 2>/dev/null | grep -q '"ALL"'; then
    echo "  ✅ cap_drop: ALL"
  else
    echo "  ⚠️  cap_drop: ALL không được thiết lập"
  fi
  if docker inspect "$CONTAINER_ID" --format '{{json .HostConfig.SecurityOpt}}' 2>/dev/null | grep -q 'no-new-privileges'; then
    echo "  ✅ security_opt: no-new-privileges:true"
  else
    echo "  ⚠️  security_opt: no-new-privileges không được thiết lập"
  fi
  if docker inspect "$CONTAINER_ID" --format '{{.HostConfig.ReadonlyRootfs}}' 2>/dev/null | grep -q 'true'; then
    echo "  ✅ read_only: true"
  else
    echo "  ⚠️  read_only: false (container có thể ghi filesystem)"
  fi
else
  echo "  ℹ️  Không kiểm tra được (container chưa chạy)."
fi

# 6. Check persistent data
echo ""
echo "[6] Kiểm tra dữ liệu persistent"
DATA_HOST_PATH="${DATA_HOST_PATH:-./data}"
FULL_DATA_DIR="$COMPOSE_PROJECT_DIR/$DATA_HOST_PATH"
if [ -d "$FULL_DATA_DIR" ]; then
  echo "  → Thư mục: $FULL_DATA_DIR"
  DIR_UID=$(stat -f '%u' "$FULL_DATA_DIR" 2>/dev/null || stat -c '%u' "$FULL_DATA_DIR" 2>/dev/null || echo "unknown")
  echo "  → UID: $DIR_UID (mong đợi: 1000)"
  if [ -w "$FULL_DATA_DIR" ]; then
    echo "  ✅ Thư mục writable"
  else
    echo "  ⚠️  Thư mục KHÔNG writable"
  fi
else
  echo "  ⚠️  Thư mục không tồn tại: $FULL_DATA_DIR"
fi

# 7. Log rotation
echo ""
echo "[7] Kiểm tra log rotation"
if [ "${RUNNING:-}" = "running" ] && [ -n "${CONTAINER_ID:-}" ]; then
  MAXSIZE=$(docker inspect "$CONTAINER_ID" --format '{{index .HostConfig.LogConfig.Config "max-size"}}' 2>/dev/null || true)
  MAXFILE=$(docker inspect "$CONTAINER_ID" --format '{{index .HostConfig.LogConfig.Config "max-file"}}' 2>/dev/null || true)
  if [ -n "$MAXSIZE" ]; then
    echo "  ✅ Log max-size: $MAXSIZE"
  else
    echo "  ⚠️  Log max-size không thiết lập"
  fi
  if [ -n "$MAXFILE" ]; then
    echo "  ✅ Log max-file: $MAXFILE"
  else
    echo "  ⚠️  Log max-file không thiết lập"
  fi
else
  echo "  ℹ️  Không kiểm tra được (container chưa chạy)."
fi

# 8. Restart policy
echo ""
echo "[8] Kiểm tra restart policy"
if [ "${RUNNING:-}" = "running" ] && [ -n "${CONTAINER_ID:-}" ]; then
  RESTART=$(docker inspect "$CONTAINER_ID" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || true)
  echo "  → Restart: $RESTART"
  if [ "$RESTART" = "unless-stopped" ]; then
    echo "  ✅ Restart policy: unless-stopped"
  else
    echo "  ⚠️  Restart policy: $RESTART (không phải unless-stopped)"
  fi
else
  echo "  ℹ️  Không kiểm tra được (container chưa chạy)."
fi

# 9. Environment variables in container
echo ""
echo "[9] Kiểm tra biến môi trường container (nếu chạy)"
if [ "${RUNNING:-}" = "running" ] && [ -n "${CONTAINER_ID:-}" ]; then
  echo "  → Biến môi trường:"
  docker exec "$CONTAINER_ID" env 2>/dev/null | grep -E '^(PORT|DATA_DIR|NODE_ENV|TZ|IT_WEBHOOK_URL|ALLOWED_ORIGINS|HOST)=' || echo "    (chưa có biến môi trường)"
else
  echo "  ℹ️  Không kiểm tra được (container chưa chạy)."
fi

echo ""
echo "============================================================================="
echo "  TÓM TẮT"
echo "============================================================================="
echo "  ✅ Compose file hợp lệ: $COMPOSE_FILE"
echo "  ℹ️  Container: ${RUNNING:-chưa chạy}"
echo ""
echo "  Tip: chạy 'bash scripts/verify-config.sh --boot-test' để test gần đầy đủ."
echo "============================================================================="

exit 0
