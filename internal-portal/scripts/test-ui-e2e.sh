#!/usr/bin/env bash
# =============================================================================
#  IT Asset & Helpdesk Portal — UI e2e harness (W3 Task 6.4/6.5)
#
#  Script này TỰ quản lý vòng đời server cho từng auth mode:
#    * RUN_DIR tạm nằm ngoài repo (DATA_DIR tạm, không đụng internal-portal/data)
#    * port trống do hệ điều hành cấp (không hard-code, không đụng portal dev)
#    * chờ HTTP readiness qua GET /api/health (không chỉ poll cổng TCP)
#    * chỉ kill đúng PID do chính script này boot — không pkill theo tên
#    * trap EXIT + INT/TERM dừng server rồi mới xoá RUN_DIR
#    * log server + stdout của Playwright được giữ trong QA_LOG_DIR
#
#  Usage:
#    QA_ROOT=/path/to/qa-root ./scripts/test-ui-e2e.sh
#    PYTHON=/path/to/venv/bin/python QA_ROOT=... ./scripts/test-ui-e2e.sh
#    UI_E2E_MODES="lab" KEEP_DATA=1 QA_ROOT=... ./scripts/test-ui-e2e.sh
#
#  Exit code: 0 = mọi mode xanh, khác 0 = có journey FAIL.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORTAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_TEST="$PORTAL_DIR/test/e2e/helpdesk-ui.e2e.py"

QA_ROOT="${QA_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/helpdesk-ui-e2e-qa.XXXXXX")}"
QA_LOG_DIR="${QA_LOG_DIR:-$QA_ROOT/logs}"
SHOT_DIR="$QA_ROOT/screenshots"
RUN_ID="${RUN_ID:-$(date -u '+%Y%m%dT%H%M%SZ')}"
HOST="${HOST:-127.0.0.1}"
KEEP_DATA="${KEEP_DATA:-0}"
UI_E2E_MODES="${UI_E2E_MODES:-legacy lab}"
ARTIFACT_PREFIX="${ARTIFACT_PREFIX:-helpdesk-ui-e2e-}"
PYTHON="${PYTHON:-$QA_ROOT/browser/venv/bin/python}"
[ -x "$PYTHON" ] || PYTHON="$(command -v python3)"

# Fixture user của lab mode — cùng bộ credential mà test/auth-boundary.test.js dùng.
E2E_LAB_USERS='{"viewer":{"password":"qa-viewer-password","role":"VIEWER"},"admin":{"password":"qa-admin-password","role":"IT_ADMIN"}}'

SERVER_PID=""
RUN_DIR=""
MODE=""
OVERALL=0
CREATED_DIRS=""

mkdir -p "$QA_LOG_DIR" "$SHOT_DIR"

# Port trống do hệ điều hành cấp.
pick_free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

# Dừng đúng tiến trình chính script này boot.
stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

cleanup() {
  trap - EXIT INT TERM
  stop_server
  for dir in $CREATED_DIRS; do
    if [ "$KEEP_DATA" = "1" ]; then
      printf ">> KEEP_DATA=1: giữ %s\n" "$dir"
    else
      rm -rf "$dir"
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_ready() { # wait_ready BASE_URL RUN_DIR  → 0 nếu /api/health trả 200
  for _ in $(seq 1 60); do
    if curl -sf "$1/api/health" > /dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  return 1
}

run_mode() { # run_mode MODE  → 0 nếu journey xanh
  MODE="$1"
  RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/helpdesk-ui-e2e.${RUN_ID}.${MODE}.XXXXXX")"
  CREATED_DIRS="$CREATED_DIRS $RUN_DIR"
  DATA_DIR="$RUN_DIR/data"
  mkdir -p "$DATA_DIR"

  PORT="$(pick_free_port)"
  BASE_URL="http://${HOST}:${PORT}"
  printf ">> [%s] boot server port=%s data=%s\n" "$MODE" "$PORT" "$DATA_DIR"

  local auth_env=()
  if [ "$MODE" = "lab" ]; then
    auth_env=(AUTH_MODE=lab LAB_AUTH_USERS="$E2E_LAB_USERS")
  else
    auth_env=(AUTH_MODE=legacy)
  fi

  (
    cd "$PORTAL_DIR" || exit 1
    exec env PORT="$PORT" HOST="$HOST" DATA_DIR="$DATA_DIR" \
      OPENAI_API_KEY= OLLAMA_URL= QDRANT_URL= IT_WEBHOOK_URL= \
      MINIERP_INTEGRATION_KEY= "${auth_env[@]}" node server.js
  ) > "$RUN_DIR/server.log" 2>&1 &
  SERVER_PID=$!

  if ! wait_ready "$BASE_URL" "$RUN_DIR"; then
    printf "!! [%s] server không sẵn sàng. Log:\n" "$MODE"
    tail -30 "$RUN_DIR/server.log"
    return 1
  fi

  printf ">> [%s] server sẵn sàng tại %s\n" "$MODE" "$BASE_URL"
  BASE_URL="$BASE_URL" AUTH_MODE="$MODE" QA_ROOT="$QA_ROOT" QA_LOG_DIR="$QA_LOG_DIR" \
    "$PYTHON" "$E2E_TEST" 2>&1 | tee "$RUN_DIR/playwright.log"
  local rc="${PIPESTATUS[0]}"

  stop_server
  cp "$RUN_DIR/server.log" "$QA_LOG_DIR/${ARTIFACT_PREFIX}${MODE}-server.log" 2>/dev/null || true
  cp "$RUN_DIR/playwright.log" "$QA_LOG_DIR/${ARTIFACT_PREFIX}${MODE}-playwright.log" 2>/dev/null || true
  printf 'mode=%s\nbaseUrl=%s\ndataDir=%s\nrunDir=%s\nexitCode=%s\nfinishedAt=%s\n' \
    "$MODE" "$BASE_URL" "$DATA_DIR" "$RUN_DIR" "$rc" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    > "$QA_LOG_DIR/${ARTIFACT_PREFIX}${MODE}-summary.txt"
  return "$rc"
}

printf "== UI e2e: modes=[%s] python=%s\n" "$UI_E2E_MODES" "$PYTHON"
for mode in $UI_E2E_MODES; do
  if run_mode "$mode"; then
    printf "== [%s] journeys xanh\n" "$mode"
  else
    printf "== [%s] journeys FAIL\n" "$mode"
    OVERALL=1
  fi
done

if [ "$OVERALL" -eq 0 ]; then
  printf "\n✅ UI e2e xanh cho mọi mode. Screenshot: %s\n" "$SHOT_DIR"
else
  printf "\n❌ UI e2e có journey FAIL. Log: %s\n" "$QA_LOG_DIR"
fi
exit "$OVERALL"
