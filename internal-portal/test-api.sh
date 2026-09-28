#!/usr/bin/env bash
# =============================================================================
#  IT Asset & Helpdesk Portal — Kiểm thử tự động REST API (BƯỚC 6)
#
#  Mặc định script TỰ khởi động server trên một port TRỐNG do hệ điều hành cấp
#  với DATA_DIR tạm nằm ngoài repo → không phá dữ liệu đang chạy ở cổng khác,
#  chạy được trong CI/Docker mà không cần cấu hình port cố định.
#
#  Usage:
#    ./test-api.sh                      # tự boot server, test, tự tắt
#    PORT=3345 ./test-api.sh            # ép port cụ thể (ví dụ để soi log server)
#    QA_LOG_DIR=/path/to/logs ./test-api.sh   # giữ server.log + CSV + summary ngoài RUN_DIR
#    BASE_URL=http://localhost:3000 DATA_DIR=/tmp/portal-data ./test-api.sh
#    docker compose up -d && BASE_URL=http://localhost:3000 ./test-api.sh
#
#  Env: PORT, HOST, BASE_URL, DATA_DIR, MANAGEMENT, KEEP_DATA, RUN_DIR, RUN_ID,
#       QA_LOG_DIR, ARTIFACT_PREFIX.
#  Chế độ BASE_URL: script KHÔNG tự suy ra DATA_DIR của server ngoài. Nếu không
#  truyền DATA_DIR thì các assertion về data/db.json (quyền sở hữu dữ liệu) bị
#  bỏ qua kèm thông báo — không bao giờ đọc/ghi internal-portal/data của repo.
#
#  Exit code: 0 = tất cả PASS, 1 = có FAIL.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_ID="${RUN_ID:-$(date -u '+%Y%m%dT%H%M%SZ')}"
# RUN_DIR luôn nằm ngoài repo; nếu không có TMPDIR thì rơi về /tmp.
RUN_DIR="${RUN_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/helpdesk-api.${RUN_ID}.XXXXXX")}"
# macOS đặt TMPDIR kèm dấu / nên mktemp sinh ra ".../T//helpdesk-api..." — nén lại
# để mọi đường dẫn in ra (log, summary) đúng một lần gạch chéo.
RUN_DIR="$(printf '%s' "$RUN_DIR" | tr -s '/')"
ARTIFACT_PREFIX="${ARTIFACT_PREFIX:-helpdesk-api-}"
SUMMARY_FILE="${ARTIFACT_PREFIX}summary.txt"
QA_LOG_DIR="${QA_LOG_DIR:-$RUN_DIR}"
# Nén dấu / kép cho mọi đường dẫn in ra (TMPDIR của người gọi cũng có thể thừa).
QA_LOG_DIR="$(printf '%s' "$QA_LOG_DIR" | tr -s '/')"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-}"
BASE_URL="${BASE_URL:-}"
DATA_DIR="${DATA_DIR:-}"
KEEP_DATA="${KEEP_DATA:-0}"
# MANAGEMENT=1 do người gọi truyền, hoặc do chính script đặt khi nó tự boot server.
MANAGEMENT="${MANAGEMENT:-0}"

# ---------- màu (tắt khi output không phải terminal) ----------
if [ -t 1 ]; then
  C_G='\033[32m'; C_R='\033[31m'; C_Y='\033[33m'; C_B='\033[36m'; C_D='\033[2m'; C_0='\033[0m'
else
  C_G=''; C_R=''; C_Y=''; C_B=''; C_D=''; C_0=''
fi

PASS=0
FAIL=0
TOTAL=0
mkdir -p "$RUN_DIR"
BODY_FILE="$RUN_DIR/body.json"
OUT_DIR="$RUN_DIR/out"
mkdir -p "$OUT_DIR"
SERVER_PID=""
# Server này có do chính script boot hay không (không đi theo SERVER_PID vì
# stop_server xoá PID trước khi ghi summary).
SERVER_BOOTED=0
# Khởi tạo TẠI ĐÂY: cleanup chạy qua EXIT trap kể cả khi script chết ở bước
# readiness, nên mọi biến mà write_summary/publish_artifacts đọc phải có sẵn.
# `set -u` coi biến chưa gán là FATAL ngay trong trap → dừng cả cleanup.
CSV_FILE=""

# Port trống do hệ điều hành cấp — không hard-code danh sách port dự phòng.
pick_free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

# Dừng đúng tiến trình do chính script này boot. Không pkill theo tên: máy dev có
# thể đang chạy portal của chính họ ở cổng khác.
stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

# Tỷ lệ đạt. TOTAL=0 thì node in ra "NaN" và vẫn exit 0 → `|| echo 0` không
# bao giờ chạy. Chặn trước bằng số học thuần của bash.
percent_value() {
  if [ "${TOTAL:-0}" -gt 0 ] 2>/dev/null; then
    node -e "console.log((($PASS/$TOTAL)*100).toFixed(1))" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

# Tên file CSV trong RUN_DIR (bị xoá cùng RUN_DIR) và bản đã publish ra QA_LOG_DIR.
csv_fixture_name() {
  if [ -n "$CSV_FILE" ]; then basename "$CSV_FILE"; else echo "<none>"; fi
}

csv_fixture_published() {
  if [ -n "$CSV_FILE" ] && [ "$QA_LOG_DIR" != "$RUN_DIR" ]; then
    echo "$QA_LOG_DIR/${ARTIFACT_PREFIX}asset-audit.csv"
  else
    echo "<none>"
  fi
}

# Bản tổng kết máy-đọc-được, ghi trong RUN_DIR trước khi dọn thư mục tạm.
write_summary() {
  local percent
  percent="$(percent_value)"
  {
    printf 'runId=%s\n' "$RUN_ID"
    printf 'finishedAt=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'baseUrl=%s\n' "$BASE_URL"
    printf 'host=%s\n' "$HOST"
    printf 'port=%s\n' "$PORT"
    printf 'serverBootstrappedByScript=%s\n' "$SERVER_BOOTED"
    printf 'management=%s\n' "$MANAGEMENT"
    printf 'dataDir=%s\n' "${DATA_DIR:-<none>}"
    printf 'dataAssertions=%s\n' "$([ -n "$DATA_DIR" ] && echo run || echo skipped)"
    printf 'runDir=%s\n' "$RUN_DIR"
    printf 'qaLogDir=%s\n' "$QA_LOG_DIR"
    printf 'csvFixtureName=%s\n' "$(csv_fixture_name)"
    printf 'csvFixturePublished=%s\n' "$(csv_fixture_published)"
    printf 'total=%s\n' "$TOTAL"
    printf 'pass=%s\n' "$PASS"
    printf 'fail=%s\n' "$FAIL"
    printf 'percent=%s\n' "$percent"
  } > "$RUN_DIR/$SUMMARY_FILE"
}

# Chép artifact ra QA_LOG_DIR TRƯỚC khi xoá RUN_DIR (server.log, CSV, summary).
publish_artifacts() {
  [ -n "$QA_LOG_DIR" ] || return 0
  [ "$QA_LOG_DIR" = "$RUN_DIR" ] && return 0
  mkdir -p "$QA_LOG_DIR" 2>/dev/null || return 0
  for artifact in server.log server2.log out/asset-audit.csv out/csv.headers; do
    [ -f "$RUN_DIR/$artifact" ] || continue
    cp "$RUN_DIR/$artifact" "$QA_LOG_DIR/${ARTIFACT_PREFIX}$(basename "$artifact")" 2>/dev/null || true
  done
  # SUMMARY_FILE đã mang sẵn tiền tố → không prefix lần hai.
  [ -f "$RUN_DIR/$SUMMARY_FILE" ] && cp "$RUN_DIR/$SUMMARY_FILE" "$QA_LOG_DIR/$SUMMARY_FILE" 2>/dev/null || true
}

cleanup() {
  # Thứ tự này là hợp đồng: tiến trình server phải chết TRƯỚC, kể cả khi
  # write_summary lỗi. Mọi lệnh sau stop_server đều phải fail-safe, vì nếu chúng
  # chết non thì ta lại bỏ sót process/dữ liệu — đúng thứ EXIT trap sinh ra để
  # tránh. `packaging.test.js` kiểm cả thứ tự này (static) lẫn hành vi thật
  # (failure-path end-to-end).
  trap - EXIT INT TERM
  stop_server
  write_summary || true
  publish_artifacts
  if [ "$KEEP_DATA" = "1" ]; then
    printf "${C_D}>> KEEP_DATA=1: giữ RUN_DIR để debug: %s${C_0}\n" "$RUN_DIR"
  else
    rm -rf "$RUN_DIR"
  fi
}
# INT/TERM phải exit để EXIT-trap (cleanup) thực sự chạy; gộp trap sẽ chạy
# cleanup rồi tiếp tục script trên thư mục tạm đã bị xoá.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------- khởi động server (nếu BASE_URL không được cung cấp) ----------
if [ -z "$BASE_URL" ]; then
  # Port lấy từ biến được cấp trước; nếu không có thì xin hệ điều hành port trống.
  # Nếu port đó đang có portal khác trả lời /api/health thì xin lại — không đụng
  # vào process của người khác (chỉ dừng đúng PID mình boot ở cleanup).
  if [ -z "$PORT" ]; then PORT="$(pick_free_port)"; fi
  for _ in 1 2 3 4 5; do
    if curl -sf "http://${HOST}:${PORT}/api/health" > /dev/null 2>&1; then
      printf "${C_Y}⚠ Port %s đã có portal khác đang chạy → xin port trống khác.${C_0}\n" "$PORT"
      PORT="$(pick_free_port)"
    else
      break
    fi
  done
  BASE_URL="http://${HOST}:${PORT}"
  DATA_DIR="$RUN_DIR/data"
  mkdir -p "$DATA_DIR"
  printf "${C_D}>> Đang khởi động server trên port %s (DATA_DIR tạm: %s)...${C_0}\n" "$PORT" "$DATA_DIR"
  (
    cd "$SCRIPT_DIR" || exit 1
    exec env PORT="$PORT" HOST="$HOST" DATA_DIR="$DATA_DIR" node server.js
  ) > "$RUN_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  SERVER_BOOTED=1
  MANAGEMENT=1

  READY=0
  for _ in $(seq 1 40); do
    if curl -sf "$BASE_URL/api/health" > /dev/null 2>&1; then READY=1; break; fi
    sleep 0.25
  done
  if [ "$READY" != "1" ]; then
    printf "${C_R}✖ Server không lên được. Log khởi động:${C_0}\n"
    tail -30 "$OUT_DIR/server.log" 2>/dev/null
    exit 1
  fi
  printf "${C_G}✔ Server sẵn sàng tại %s${C_0}\n\n" "$BASE_URL"
else
  printf "${C_Y}>> CẢNH BÁO: chế độ BASE_URL sẽ GHI vào database của server này${C_0}\n"
  printf "${C_Y}>>   (tạo rồi xoá 1 tài sản, tạo ticket, đổi trạng thái ticket 1006, thêm cảnh báo).${C_0}\n"
  printf "${C_D}>>   Chỉ trỏ BASE_URL tới server/data tạm.${C_0}\n\n"
  printf "${C_D}>> Kiểm thử server đang chạy sẵn tại %s${C_0}\n\n" "$BASE_URL"
  if [ -n "$DATA_DIR" ]; then
    printf "${C_D}>> Dữ liệu kiểm thử: %s (script chỉ đọc/ghi trong thư mục này)${C_0}\n\n" "$DATA_DIR"
  else
    printf "${C_Y}>> BASE_URL mode không có DATA_DIR explicit → bỏ qua các assertion data/db.json; script không đoán data thật của repo.${C_0}\n\n"
  fi
fi

# ---------- helpers ----------
# request METHOD PATH [JSON_BODY] → đặt status vào $STATUS, body vào $RESPONSE
request() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    STATUS="$(curl -s -o "$BODY_FILE" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data "$data" "$BASE_URL$path")"
  else
    STATUS="$(curl -s -o "$BODY_FILE" -w '%{http_code}' -X "$method" "$BASE_URL$path")"
  fi
  RESPONSE="$(cat "$BODY_FILE")"
}

# check DESC EXPECTED_STATUS METHOD PATH [JSON_BODY]
check() {
  local desc="$1" expected="$2" method="$3" path="$4" data="${5:-}"
  TOTAL=$((TOTAL + 1))
  request "$method" "$path" "$data"
  if [ "$STATUS" = "$expected" ]; then
    PASS=$((PASS + 1))
    printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}%s %-8s${C_0} ${C_D}→ %s${C_0}\n" "$desc" "$method" "$path" "$STATUS"
  else
    FAIL=$((FAIL + 1))
    printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}%s %-8s${C_0} ${C_R}→ mong đợi %s, nhận %s${C_0}\n" "$desc" "$method" "$path" "$expected" "$STATUS"
    printf "    ${C_D}%s${C_0}\n" "$(printf '%s' "$RESPONSE" | head -c 220)"
  fi
}

# check_body DESC NEEDLE METHOD PATH  — kiếm chuỗi con trong response body
check_body() {
  local desc="$1" needle="$2" method="$3" path="$4"
  TOTAL=$((TOTAL + 1))
  request "$method" "$path"
  if grep -Fq -- "$needle" <<< "$RESPONSE"; then
    PASS=$((PASS + 1))
    printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}%s %-8s${C_0} ${C_D}→ chứa \"%s\"${C_0}\n" "$desc" "$method" "$path" "$needle"
  else
    FAIL=$((FAIL + 1))
    printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}%s %-8s${C_0} ${C_R}→ thiếu \"%s\" trong body${C_0}\n" "$desc" "$method" "$path" "$needle"
  fi
}

section() { printf "\n${C_B}── %s ${C_D}(curl)${C_0}\n" "$1"; }

# json_count: đếm số phần tử của mảng JSON trên stdin
json_count() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log(Array.isArray(o)?o.length:Object.keys(o||{}).length)}catch(e){console.log(0)}})"
}

json_field() { # json_field JSON KEY → in ra giá trị nguyên thủy (number/string)
  printf '%s' "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v='$2'.split('.').reduce((a,k)=>a&&a[k],o);console.log(typeof v==='object'?JSON.stringify(v):v)}catch(e){process.exit(1)}})"
}

printf "${C_Y}══════════════════════════════════════════════════════════════════════${C_0}\n"
printf "${C_Y}   KIỂM THỬ TỰ ĐỘNG — IT ASSET & HELPDESK PORTAL REST API${C_0}\n"
printf "${C_D}   Thời điểm: %s   |   Host: %s${C_0}\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$BASE_URL"
printf "${C_Y}══════════════════════════════════════════════════════════════════════${C_0}\n"

# ========================= 1. HEALTH & DASHBOARD =========================
section "Health & Dashboard (persistence + KPI)"
check "GET health tra ve trang thai ok" 200 GET "/api/health"
check_body "Health khai bao storage json-file" "json-file" GET "/api/health"
check "GET dashboard stats" 200 GET "/api/dashboard/stats"
check_body "Stats co truong totalAssets" "totalAssets" GET "/api/dashboard/stats"
check_body "Stats co truong slaPercent" "slaPercent" GET "/api/dashboard/stats"

# ========================= 2. IT ASSETS =========================
section "IT Assets — doc & loc"
check "GET danh sach toan bo tai san" 200 GET "/api/assets"
check "GET tai san theo tu khoa ThinkPad" 200 GET "/api/assets?q=ThinkPad"
check "GET tai san loc status=Active" 200 GET "/api/assets?status=Active"
check "GET tai san loc type=Printer" 200 GET "/api/assets?type=Printer"
check "GET chi tiết tai san id 1" 200 GET "/api/assets/1"
check "GET tai san khong ton tai → 404" 404 GET "/api/assets/424242"

section "IT Assets — tao / cap nhat / xoa"
UNIQ="$RANDOM$$"
CREATE_BODY="{\"tag\":\"LP-API-$UNIQ\",\"type\":\"Laptop\",\"brand\":\"Lenovo\",\"model\":\"ThinkPad T14 (API test)\",\"serial\":\"API-$UNIQ\",\"assignedTo\":\"QA Bot\",\"dept\":\"IT Support\",\"status\":\"In Storage\",\"ip\":\"-\"}"
TOTAL=$((TOTAL + 1))
request POST "/api/assets" "$CREATE_BODY"
if [ "$STATUS" = "201" ]; then
  NEW_ID="$(json_field "$RESPONSE" id)"
  PASS=$((PASS + 1))
  printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}POST /api/assets${C_0} ${C_D}→ 201 (id=%s)${C_0}\n" "POST tao laptop moi (kich ban yeu cau)" "$NEW_ID"
else
  FAIL=$((FAIL + 1)); NEW_ID=""
  printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}→ mong doi 201, nhan %s${C_0}\n" "POST tao laptop moi" "$STATUS"
fi
check "POST trung Asset Tag → tu choi 409" 409 POST "/api/assets" "$CREATE_BODY"
check "POST thieu brand/model/serial → 400" 400 POST "/api/assets" '{"tag":"LP-BAD"}'
check "POST status khong hop le → 422" 422 POST "/api/assets" '{"tag":"LP-BAD2","brand":"Dell","model":"M","serial":"S-BAD2","status":"Broken"}'
if [ -n "$NEW_ID" ]; then
  check "PATCH cap phat thiet bi → Active" 200 PATCH "/api/assets/$NEW_ID" '{"status":"Active","assignedTo":"Nguyen Thi Mai","dept":"Accounting","ip":"192.168.10.231"}'
  check_body "PATCH ghi nhan nguoi dung moi" "Nguyen Thi Mai" GET "/api/assets/$NEW_ID"
  check "PATCH tai san khong ton tai → 404" 404 PATCH "/api/assets/424242" '{"status":"Retired"}'
  check "PATCH trung tag cua may khac → 409" 409 PATCH "/api/assets/$NEW_ID" '{"tag":"LP-IT-001"}'
fi


# ========================= 3. CSV EXPORT (Yêu cầu #4) =========================
section "Xuất báo cáo tài sản CSV"
CSV_FILE="$OUT_DIR/asset-audit.csv"
TOTAL=$((TOTAL + 1))
HTTP=$(curl -s -D "$OUT_DIR/csv.headers" -o "$CSV_FILE" -w '%{http_code}' "$BASE_URL/api/assets/export.csv")
CT=$(grep -i '^content-type:' "$OUT_DIR/csv.headers" | tr -d '\r')
CD=$(grep -i '^content-disposition:' "$OUT_DIR/csv.headers" | tr -d '\r')
if [ "$HTTP" = "200" ] && grep -Fqi 'text/csv' <<< "$CT"; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}GET /api/assets/export.csv → 200 text/csv${C_0}\n" "Tải file kiểm kê tài sản CSV"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}HTTP %s | %s${C_0}\n" "Tải file kiểm kê tài sản CSV" "$HTTP" "$CT"
fi

TOTAL=$((TOTAL + 1))
if grep -Fqi 'attachment; filename="IT-Asset-Audit_' <<< "$CD"; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}%s${C_0}\n" "CSV là file đính kèm, tên chuẩn kiểm kê" "$(printf '%s' "$CD" | cut -c1-60)"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}%s${C_0}\n" "CSV phải là attachment" "$CD"
fi

TOTAL=$((TOTAL + 1))
if [ "$(head -c 3 "$CSV_FILE" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "CSV có BOM UTF-8 (mở Excel không lỗi font Việt)"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "CSV thiếu BOM UTF-8"
fi

TOTAL=$((TOTAL + 1))
ASSET_COUNT=$(curl -s "$BASE_URL/api/assets" | json_count)
CSV_ROWS=$(awk 'END{print NR-1}' "$CSV_FILE")
if [ "${CSV_ROWS:-0}" -ge 1 ] && [ "$CSV_ROWS" = "$ASSET_COUNT" ]; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}%s dòng = %s tài sản${C_0}\n" "Số dòng CSV khớp số tài sản trong API" "$CSV_ROWS" "$ASSET_COUNT"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}CSV=%s API=%s${C_0}\n" "Số dòng CSV phải khớp API" "${CSV_ROWS:-0}" "$ASSET_COUNT"
fi

TOTAL=$((TOTAL + 1))
if head -1 "$CSV_FILE" | grep -q 'Asset Tag' && head -1 "$CSV_FILE" | grep -q 'Serial Number'; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "CSV có tiêu đề cột nghiệp vụ (Asset Tag, Serial...)"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}%s${C_0}\n" "CSV thiếu tiêu đề cột" "$(head -1 "$CSV_FILE" | cut -c1-100)"
fi
check "GET CSV theo bộ lọc status=In Storage" 200 GET "/api/assets/export.csv?status=In%20Storage"
check "GET báo cáo ticket CSV" 200 GET "/api/tickets/export.csv"

# ========================= 4. HELPDESK TICKETS =========================
section "Helpdesk Tickets"
check "GET danh sách ticket" 200 GET "/api/tickets"
check "GET ticket lọc status=Open" 200 GET "/api/tickets?status=Open"
check "GET ticket lọc priority=High" 200 GET "/api/tickets?priority=High"
check "GET ticket theo từ khoá DNS" 200 GET "/api/tickets?q=DNS"
check "GET chi tiết ticket 1001" 200 GET "/api/tickets/1001"
check "GET ticket không tồn tại → 404" 404 GET "/api/tickets/424242"

TOTAL=$((TOTAL + 1))
# Chu y: \\ trong JSON = 1 backslash literal (duong dan UNC \\FS01\ChungTu)
request POST "/api/tickets" '{"title":"Khong truy cap duoc \\\\FS01\\ChungTu sau doi mat khau (API test)","requester":"QA Bot","dept":"Accounting","priority":"Medium","category":"File Server"}'
if [ "$STATUS" = "201" ]; then
  NEW_TICKET="$(json_field "$RESPONSE" id)"
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}POST /api/tickets → 201 (#%s)${C_0}\n" "POST tạo ticket mới" "$NEW_TICKET"
else
  FAIL=$((FAIL + 1)); NEW_TICKET=""
  printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}→ mong đợi 201, nhận %s${C_0}\n" "POST tạo ticket mới" "$STATUS"
fi
check "POST ticket thiếu title → 400" 400 POST "/api/tickets" '{"requester":"QA"}'
check "POST ticket priority sai → 422" 422 POST "/api/tickets" '{"title":"x","requester":"QA","priority":"Urgent!"}'

section "Đóng / mở lại ticket (PATCH status)"
TOTAL=$((TOTAL + 1))
request PATCH "/api/tickets/1006/status" '{"status":"Resolved"}'
if [ "$STATUS" = "200" ] && grep -Fq '"status":"Resolved"' <<< "$RESPONSE"; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}PATCH /api/tickets/1006/status${C_0}\n" "Chuyển #1006 → Resolved (kịch bản yêu cầu)"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}→ %s${C_0}\n" "Chuyển #1006 → Resolved" "$STATUS"
fi
check "PATCH trạng thái không hợp lệ → 422" 422 PATCH "/api/tickets/1006/status" '{"status":"Done"}'
check "PATCH ticket không tồn tại → 404" 404 PATCH "/api/tickets/424242/status" '{"status":"Resolved"}'
check "PATCH mở lại ticket → In Progress" 200 PATCH "/api/tickets/1006/status" '{"status":"In Progress"}'

# ========================= 5. WEBHOOK ALERT MOCK =========================
section "Webhook alert mock (ticket High/Critical)"
ALERT_BEFORE=$(json_field "$(curl -s "$BASE_URL/api/notifications")" count)
TOTAL=$((TOTAL + 1))
request POST "/api/tickets" '{"title":"Toan bo chi nhanh mat ket noi VPN (API test alert)","requester":"QA Bot","dept":"IT Support","priority":"High","category":"Network"}'
ALERT_AFTER=$(json_field "$(curl -s "$BASE_URL/api/notifications")" count)
if [ "$STATUS" = "201" ] && [ "${ALERT_AFTER:-0}" -gt "${ALERT_BEFORE:-0}" ]; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}hàng đợi %s → %s${C_0}\n" "Ticket High kích hoạt cảnh báo Telegram/Email" "$ALERT_BEFORE" "$ALERT_AFTER"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}status=%s queue %s→%s${C_0}\n" "Ticket High phải phát sinh cảnh báo" "$STATUS" "$ALERT_BEFORE" "$ALERT_AFTER"
fi
check "GET hàng đợi cảnh báo" 200 GET "/api/notifications"
check_body "Cảnh báo chỉ rõ kênh telegram mock" "telegram" GET "/api/notifications"


# ========================= 6. SOFTWARE LICENSES =========================
section "Software Licenses"
check "GET danh sách bản quyền" 200 GET "/api/licenses"
check "GET chi tiết bản quyền id 1" 200 GET "/api/licenses/1"
check "GET bản quyền không tồn tại → 404" 404 GET "/api/licenses/4242"

# ========================= 7. API CONTRACT & LỖI =========================
section "API contract & khả năng chịu lỗi"
check "Endpoint lạ → 404 JSON" 404 GET "/api/khong-ton-tai"
check "Method không hỗ trợ → 405" 405 DELETE "/api/licenses/1"
TOTAL=$((TOTAL + 1))
HTTP=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{oops' "$BASE_URL/api/assets")
if [ "$HTTP" = "400" ]; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}→ 400${C_0}\n" "Body JSON hỏng → 400 (không làm sập server)"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}→ %s${C_0}\n" "Body JSON hỏng phải trả 400" "$HTTP"
fi
check "Server vẫn sống sau chuỗi request lỗi" 200 GET "/api/health"

# ================ 7B. AI ASSISTANT (OPENAI → OLLAMA → OFFLINE) ================
section "AI Assistant — OpenAI/Ollama/offline fallback"
check "GET /api/ai/status → 200" 200 GET "/api/ai/status"
TOTAL=$((TOTAL + 1))
request GET "/api/ai/status"
if grep -Fq '"engine"' <<< "$RESPONSE"; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}→ chứa \"engine\"${C_0}\n" "status trả về engine (openai | ollama | rule-based)"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "status thiếu trường engine"
fi
check "POST analyze {ticketId:1001} → 200" 200 POST "/api/ai/analyze" '{"ticketId":1001}'
check "POST analyze {title} tự do → 200" 200 POST "/api/ai/analyze" '{"title":"Máy in offline không in được","category":"Hardware"}'
TOTAL=$((TOTAL + 1))
request POST "/api/ai/analyze" '{"title":"Không đăng nhập được do tài khoản bị khóa"}'
if grep -Fq '"diagnosis"' <<< "$RESPONSE" && grep -Fq '"prevention"' <<< "$RESPONSE"; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}→ summary/diagnosis/rca/prevention${C_0}\n" "analyze trả đủ 4 phần ITIL"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "analyze thiếu diagnosis/prevention"
fi
check "POST analyze thiếu ticketId/title → 400" 400 POST "/api/ai/analyze" '{}'
check "POST analyze ticketId không tồn tại → 404" 404 POST "/api/ai/analyze" '{"ticketId":424242}'

# ========================= 8. GIAO DIỆN TĨNH (SPA) =========================
section "Giao diện web & nút xuất CSV"
check "GET / → trang dashboard" 200 GET "/"
check "GET /app.js → frontend controller" 200 GET "/app.js"
check "GET /styles.css → stylesheet" 200 GET "/styles.css"
TOTAL=$((TOTAL + 1))
request GET "/"
if grep -Fq 'btn-export-assets' <<< "$RESPONSE"; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "UI có nút 'Xuất Danh Sách Tài Sản (CSV)'"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "UI thiếu nút xuất CSV"
fi
TOTAL=$((TOTAL + 1))
request GET "/"
if grep -Fq 'asset-modal' <<< "$RESPONSE"; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "UI có form modal đăng ký thiết bị"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "UI thiếu form modal thiết bị"
fi

# ========================= 9. PERSISTENCE QUA RESTART =========================
section "Dữ liệu bền vững qua restart (Yêu cầu #3)"
if [ -n "$DATA_DIR" ]; then
DB_FILE="$DATA_DIR/db.json"
TOTAL=$((TOTAL + 1))
if [ -f "$DB_FILE" ]; then
  SIZE=$(wc -c < "$DB_FILE" | tr -d ' ')
  if [ "$SIZE" -gt 500 ]; then
    PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}%s bytes${C_0}\n" "data/db.json đã được ghi ra đĩa" "$SIZE"
  else
    FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}%s bytes${C_0}\n" "data/db.json quá nhỏ (không có dữ liệu)" "$SIZE"
  fi
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}%s${C_0}\n" "Không tìm thấy data/db.json" "$DB_FILE"
fi

TOTAL=$((TOTAL + 1))
if grep -q '"assets"' "$DB_FILE" 2>/dev/null && grep -q '"tickets"' "$DB_FILE" 2>/dev/null; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "db.json chứa cả collection assets + tickets"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "db.json thiếu collection assets/tickets"
fi

# Bản ghi tạo ở bước test phải nằm trong file
TOTAL=$((TOTAL + 1))
if [ -n "$NEW_ID" ] && grep -q "LP-API-$UNIQ" "$DB_FILE" 2>/dev/null; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "Asset kiểm thử đã được ghi bền vững vào db.json"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "Asset kiểm thử chưa được ghi vào db.json"
fi

# Chỉ restart được khi chính script này boot server (có PID) — không đụng
# vào server mà người gọi cung cấp qua BASE_URL.
if [ "$MANAGEMENT" = "1" ] && [ -n "$SERVER_PID" ] && [ -n "$DATA_DIR" ]; then
  # Kill + boot lại server trên CÙNG dataDir → dữ liệu phải còn
  TOTAL=$((TOTAL + 1))
  stop_server
  (
    cd "$SCRIPT_DIR" || exit 1
    exec env PORT="$PORT" HOST="$HOST" DATA_DIR="$DATA_DIR" node server.js
  ) > "$RUN_DIR/server2.log" 2>&1 &
  SERVER_PID=$!
  READY=0
  for _ in $(seq 1 40); do curl -sf "$BASE_URL/api/health" >/dev/null 2>&1 && { READY=1; break; }; sleep 0.25; done
  request GET "/api/tickets"
  if [ "$READY" = "1" ] && [ -n "$NEW_TICKET" ] && grep -Fq "\"id\":$NEW_TICKET" <<< "$RESPONSE"; then
    PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_D} (Ticket #%s)${C_0}\n" "Restart server → Ticket vẫn còn trong hệ thống" "$NEW_TICKET"
  else
    FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "Restart server → mất dữ liệu (persistence lỗi)"
  fi
fi
fi

# ========================= 10. DỌN DỮ LIỆU KIỂM THỬ =========================
section "Dọn dẹp bản ghi kiểm thử"
if [ -n "$NEW_ID" ]; then
  check "DELETE tài sản đã tạo" 200 DELETE "/api/assets/$NEW_ID"
  check "DELETE lần 2 → 404" 404 DELETE "/api/assets/$NEW_ID"
fi
if [ -n "$NEW_TICKET" ]; then
  check "PATCH ticket kiểm thử → Closed" 200 PATCH "/api/tickets/$NEW_TICKET/status" '{"status":"Closed"}'
fi

# ========================= KẾT QUẢ =========================
PERCENT="$(percent_value)"
printf "\n${C_Y}══════════════════════════ KẾT QUẢ KIỂM THỬ ══════════════════════════${C_0}\n"
printf "  Tổng số kiểm tra : ${C_D}%s${C_0}\n" "$TOTAL"
printf "  ${C_G}PASS            : %s${C_0}\n" "$PASS"
if [ "$FAIL" -gt 0 ]; then printf "  ${C_R}FAIL            : %s${C_0}\n" "$FAIL"; else printf "  FAIL            : 0\n"; fi
printf "  Tỷ lệ đạt         : ${C_B}%s%%${C_0}\n" "$PERCENT"
printf "  File CSV mẫu      : ${C_D}%s${C_0}\n" "$(csv_fixture_published)"
printf "  Thư mục tạm        : ${C_D}%s${C_0}\n" "$RUN_DIR"
printf "  Artifact giữ lại  : ${C_D}%s${C_0}\n" "$QA_LOG_DIR"
if [ "$QA_LOG_DIR" != "$RUN_DIR" ]; then
  printf "  ${C_D}→ %s, %s, %s, %s, %s${C_0}\n" \
    "$QA_LOG_DIR/${ARTIFACT_PREFIX}server.log" "$QA_LOG_DIR/${ARTIFACT_PREFIX}server2.log" \
    "$QA_LOG_DIR/${ARTIFACT_PREFIX}asset-audit.csv" "$QA_LOG_DIR/${ARTIFACT_PREFIX}csv.headers" \
    "$QA_LOG_DIR/$SUMMARY_FILE"
fi
printf "${C_Y}════════════════════════════════════════════════════════════════════════${C_0}\n"

# Bản tổng kết để máy/CI đọc được; cleanup sẽ chép nó sang QA_LOG_DIR cùng log server.
write_summary

if [ "$FAIL" -eq 0 ]; then
  printf "\n${C_G}✅ TẤT CẢ %s/%s KIỂM TRA BASELINE REST PASS — các factory route được kiểm tra riêng trong node:test.${C_0}\n\n" "$PASS" "$TOTAL"
  exit 0
fi
printf "\n${C_R}❌ CÓ %s KIỂM TRA THẤT BẠI — xem chi tiết phía trên.${C_0}\n\n" "$FAIL"
exit 1

