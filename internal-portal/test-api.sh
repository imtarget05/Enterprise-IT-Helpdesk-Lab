#!/usr/bin/env bash
# =============================================================================
#  IT Asset & Helpdesk Portal — Kiểm thử tự động REST API (BƯỚC 6)
#
#  Mặc định script TỰ khởi động server trên PORT riêng (3210) với DATA_DIR tạm
#  → không phá dữ liệu đang chạy trên port 3000, chạy được trong CI/Docker.
#
#  Usage:
#    ./test-api.sh                      # tự boot server, test, tự tắt
#    BASE_URL=http://localhost:3000 ./test-api.sh    # test server đang chạy sẵn
#    docker compose up -d && BASE_URL=http://localhost:3000 ./test-api.sh
#
#  Exit code: 0 = tất cả PASS, 1 = có FAIL.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3210}"
BASE_URL="${BASE_URL:-}"
KEEP_DATA="${KEEP_DATA:-0}"

# ---------- màu (tắt khi output không phải terminal) ----------
if [ -t 1 ]; then
  C_G='\033[32m'; C_R='\033[31m'; C_Y='\033[33m'; C_B='\033[36m'; C_D='\033[2m'; C_0='\033[0m'
else
  C_G=''; C_R=''; C_Y=''; C_B=''; C_D=''; C_0=''
fi

PASS=0
FAIL=0
TOTAL=0
BODY_FILE="$(mktemp)"
OUT_DIR="$(mktemp -d)"
SERVER_PID=""
MANAGEMENT=0

cleanup() {
  if [ "$MANAGEMENT" = "1" ] && [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
  fi
  rm -f "$BODY_FILE"
  [ "$KEEP_DATA" = "1" ] || rm -rf "$OUT_DIR"
}
trap cleanup EXIT INT TERM

# ---------- khởi động server (nếu BASE_URL không được cung cấp) ----------
if [ -z "$BASE_URL" ]; then
  BASE_URL="http://127.0.0.1:${PORT}"
  DATA_DIR="$OUT_DIR/data"
  mkdir -p "$DATA_DIR"
  printf "${C_D}>> Đang khởi động server trên port %s (DATA_DIR tạm: %s)...${C_0}\n" "$PORT" "$DATA_DIR"
  ( cd "$SCRIPT_DIR" && PORT="$PORT" HOST=127.0.0.1 DATA_DIR="$DATA_DIR" node server.js > "$OUT_DIR/server.log" 2>&1 & echo $! > "$OUT_DIR/server.pid" )
  MANAGEMENT=1
  SERVER_PID="$(cat "$OUT_DIR/server.pid")"

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
  printf "${C_D}>> Kiểm thử server đang chạy sẵn tại %s${C_0}\n\n" "$BASE_URL"
  if [ ! -d "$OUT_DIR" ]; then mkdir -p "$OUT_DIR"; fi
  DATA_DIR="${DATA_DIR:-$SCRIPT_DIR/data}"
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
  if printf '%s' "$RESPONSE" | grep -qF -- "$needle"; then
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
if [ "$HTTP" = "200" ] && printf '%s' "$CT" | grep -qi 'text/csv'; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s ${C_D}GET /api/assets/export.csv → 200 text/csv${C_0}\n" "Tải file kiểm kê tài sản CSV"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s ${C_D}HTTP %s | %s${C_0}\n" "Tải file kiểm kê tài sản CSV" "$HTTP" "$CT"
fi

TOTAL=$((TOTAL + 1))
if printf '%s' "$CD" | grep -qi 'attachment; filename="IT-Asset-Audit_'; then
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
if [ "$STATUS" = "200" ] && printf '%s' "$RESPONSE" | grep -q '"status":"Resolved"'; then
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

# ========================= 8. GIAO DIỆN TĨNH (SPA) =========================
section "Giao diện web & nút xuất CSV"
check "GET / → trang dashboard" 200 GET "/"
check "GET /app.js → frontend controller" 200 GET "/app.js"
check "GET /styles.css → stylesheet" 200 GET "/styles.css"
TOTAL=$((TOTAL + 1))
if curl -s "$BASE_URL/" | grep -q 'btn-export-assets'; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "UI có nút 'Xuất Danh Sách Tài Sản (CSV)'"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "UI thiếu nút xuất CSV"
fi
TOTAL=$((TOTAL + 1))
if curl -s "$BASE_URL/" | grep -q 'asset-modal'; then
  PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "UI có form modal đăng ký thiết bị"
else
  FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "UI thiếu form modal thiết bị"
fi

# ========================= 9. PERSISTENCE QUA RESTART =========================
section "Dữ liệu bền vững qua restart (Yêu cầu #3)"
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

if [ "$MANAGEMENT" = "1" ]; then
  # Kill + boot lại server trên CÙNG dataDir → dữ liệu phải còn
  TOTAL=$((TOTAL + 1))
  kill "$SERVER_PID" 2>/dev/null
  for _ in $(seq 1 20); do curl -sf "$BASE_URL/api/health" >/dev/null 2>&1 || break; sleep 0.2; done
  ( cd "$SCRIPT_DIR" && PORT="$PORT" HOST=127.0.0.1 DATA_DIR="$DATA_DIR" node server.js > "$OUT_DIR/server2.log" 2>&1 & echo $! > "$OUT_DIR/server2.pid" )
  SERVER_PID="$(cat "$OUT_DIR/server2.pid")"
  READY=0
  for _ in $(seq 1 40); do curl -sf "$BASE_URL/api/health" >/dev/null 2>&1 && { READY=1; break; }; sleep 0.25; done
  if [ "$READY" = "1" ] && [ -n "$NEW_TICKET" ] && curl -s "$BASE_URL/api/tickets" | grep -q "\"id\":$NEW_TICKET"; then
    PASS=$((PASS + 1)); printf "  ${C_G}✔ PASS${C_0} %-52s${C_0}\n" "Restart server → Ticket #%s vẫn còn trong hệ thống" "$NEW_TICKET"
  else
    FAIL=$((FAIL + 1)); printf "  ${C_R}✖ FAIL${C_0} %-52s${C_0}\n" "Restart server → mất dữ liệu (persistence lỗi)"
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
PERCENT=$(node -e "console.log(($PASS/$TOTAL*100).toFixed(1))" 2>/dev/null || echo "0")
printf "\n${C_Y}══════════════════════════ KẾT QUẢ KIỂM THỬ ══════════════════════════${C_0}\n"
printf "  Tổng số kiểm tra : ${C_D}%s${C_0}\n" "$TOTAL"
printf "  ${C_G}PASS            : %s${C_0}\n" "$PASS"
if [ "$FAIL" -gt 0 ]; then printf "  ${C_R}FAIL            : %s${C_0}\n" "$FAIL"; else printf "  FAIL            : 0\n"; fi
printf "  Tỷ lệ đạt         : ${C_B}%s%%${C_0}\n" "$PERCENT"
printf "  File CSV mẫu      : ${C_D}%s${C_0}\n" "$CSV_FILE"
printf "${C_Y}════════════════════════════════════════════════════════════════════════${C_0}\n"

if [ "$FAIL" -eq 0 ]; then
  printf "\n${C_G}✅ TẤT CẢ %s/%s KIỂM TRA PASS — 100%% REST endpoints hoạt động đúng.${C_0}\n\n" "$PASS" "$TOTAL"
  exit 0
fi
printf "\n${C_R}❌ CÓ %s KIỂM TRA THẤT BẠI — xem chi tiết phía trên.${C_0}\n\n" "$FAIL"
exit 1

