"""
IT Asset & Helpdesk Portal — Python Flask port (cho JD yêu cầu Python).

Mặc định ISOLATED: dùng python-portal/data/db.json riêng, KHÔNG dùng
chung ../data/db.json với bản Node.js để tránh mất collection mở rộng
(problems/changes/audit/monitoring/...) khi hai process ghi đè nhau.
Muốn trỏ DATA_FILE đi nơi khác thì export DATA_FILE explicit; nếu trỏ
vào Node data path thì process fail-fast (shared concurrent JSON là
unsupported — cần lock protocol riêng, xem plan QA W6).

Phạm vi an toàn:
  - DEMO-ONLY, KHÔNG có auth: các route ghi (POST /api/assets, POST /api/tickets,
    PATCH /api/tickets/<id>/status) ai gọi cũng được; CORS mở toàn bộ. Chỉ phục vụ
    demo/JD walkthrough, KHÔNG expose ra mạng: mặc định bind 127.0.0.1 (env HOST).

  pip install -r requirements.txt
  python app.py  # -> http://127.0.0.1:5001 (HOST/PORT override được)

Endpoints (tương đương bản Node):
  GET  /api/health, /api/dashboard/stats
  GET  /api/assets, POST /api/assets
  GET  /api/tickets, POST /api/tickets, PATCH /api/tickets/<id>/status
  GET  /api/ai/status, POST /api/ai/analyze
"""
import json
import os
import shutil
import tempfile
import threading
import time
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, Response
from flask_cors import CORS

from ai_providers import analyze_ticket, ai_status

BASE_DIR = Path(__file__).resolve().parent
NODE_DATA_FILE = (BASE_DIR.parent / "data" / "db.json").resolve()
_DEFAULT_DATA_FILE = (BASE_DIR / "data" / "db.json").resolve()
_DATA_FILE_RAW = os.environ.get("DATA_FILE")
if _DATA_FILE_RAW:
    # Fail-CLOSED: nếu không resolve được DATA_FILE thì cũng abort, không chạy tiếp
    # (có thể đó chính là file của Node — shared JSON là unsupported).
    try:
        _resolved_data_file = Path(_DATA_FILE_RAW).resolve()
    except (OSError, RuntimeError, ValueError) as exc:
        raise SystemExit(
            f"Không xác định được DATA_FILE={_DATA_FILE_RAW!r} ({exc}). "
            "Fail-closed: từ chối chạy khi không chắc path này có phải data riêng "
            "của Flask hay không (shared concurrent JSON là unsupported)."
        )
    if _resolved_data_file == NODE_DATA_FILE:
        raise SystemExit(
            "Flask DATA_FILE trỏ vào internal-portal/data/db.json của Node — "
            "shared concurrent JSON là unsupported (mất collection mở rộng). "
            "Dùng python-portal/data riêng hoặc xem plan QA W6 để duyệt lock protocol."
        )
    DATA_FILE = Path(_DATA_FILE_RAW)
else:
    DATA_FILE = _DEFAULT_DATA_FILE
PORT = int(os.environ.get("PORT", "5001"))
# Demo-only: chỉ loopback. Muốn expose ra LAN thì export HOST (và tự hiểu rằng
# app KHÔNG có auth — chỉ dùng cho demo nội bộ tin cậy).
HOST = os.environ.get("HOST", "127.0.0.1")

ASSET_STATUSES = ["Active", "In Storage", "Maintenance", "Retired"]
TICKET_STATUSES = ["Open", "In Progress", "Resolved", "Closed"]
PRIORITIES = ["Low", "Medium", "High", "Critical"]
OPEN_STATUSES = {"Open", "In Progress"}

# Canonical collections/schemaVersion của portal Node, khai báo tường minh ở
# đây (không import Node) để Flask không cần phụ thuộc bản Node.
# Flask chỉ QUẢN LÝ 3 collection dưới đây; các collection còn lại được
# read-modify-write giữ nguyên từ file trên đĩa.
MANAGED_COLLECTIONS = ("assets", "tickets", "licenses")
CANONICAL_COLLECTIONS = (
    "assets", "tickets", "licenses", "ticketEvents", "problems", "changes",
    "accessRequests", "monitoringChecks", "monitoringHistory", "auditEvents",
    "notifications",
)
SCHEMA_VERSION = 2

SEED = {
    "assets": [
        {"id": 1, "tag": "LP-IT-001", "type": "Laptop", "brand": "Lenovo",
         "model": "ThinkPad T14 Gen 4", "serial": "PF-39X8K2",
         "assignedTo": "Mai Nguyen Binh Tan", "dept": "IT Support",
         "status": "Active", "ip": "192.168.10.101"},
        {"id": 2, "tag": "LP-ACC-012", "type": "Laptop", "brand": "Dell",
         "model": "Latitude 5420", "serial": "8H2K9L3",
         "assignedTo": "Nguyen Thi Mai", "dept": "Accounting",
         "status": "Active", "ip": "192.168.10.124"},
    ],
    "tickets": [
        {"id": 1001, "title": "Cannot access Internet due to APIPA IP",
         "requester": "Nguyen Thi Mai", "dept": "Accounting",
         "priority": "High", "status": "Resolved", "category": "Network",
         "createdAt": "2026-09-23 08:30"},
        {"id": 1006, "title": "Request new mouse and HDMI cable",
         "requester": "Vo Thi Kim Cuc", "dept": "Customer Service",
         "priority": "Low", "status": "Open", "category": "Hardware Request",
         "createdAt": "2026-09-23 14:10"},
    ],
    "licenses": [],
    # 8 collection còn lại của portal Node: Flask không quản lý nhưng file
    # isolated vẫn phải có đủ để Node load() không sinh migration backup.
    "ticketEvents": [],
    "problems": [],
    "changes": [],
    "accessRequests": [],
    "monitoringChecks": [],
    "monitoringHistory": [],
    "auditEvents": [],
    "notifications": [],
}


def stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


class DataFileUnreadable(RuntimeError):
    """DATA_FILE tồn tại nhưng không đọc/parse được -> từ chối ghi đè."""


def _corrupt_backup_path() -> Path:
    stamp_ = f"{int(time.time())}-{os.urandom(3).hex()}"
    return DATA_FILE.with_name(f"{DATA_FILE.name}.corrupt-{stamp_}")


def _backup_corrupt():
    """Copy nguyên trạng file hỏng sang `<name>.corrupt-<ts>-<hex>`.

    Copy (không rename) để file gốc còn nguyên cho người dùng tự khôi phục;
    trả về None nếu không copy được (ví dụ EACCES) — caller vẫn abort.
    """
    backup = _corrupt_backup_path()
    try:
        shutil.copy2(str(DATA_FILE), str(backup))
        return backup
    except OSError:
        return None


def _read_raw(for_write: bool = False) -> dict:
    """Đọc nguyên trạng file trên đĩa.

    - File KHÔNG tồn tại: hợp lệ (sẽ seed) -> `{}`.
    - File tồn tại mà parse lỗi / không phải object: bất thường -> backup
      `.corrupt-*` rồi coi như `{}`; nếu `for_write` thì ném
      `DataFileUnreadable` để `save_db` KHÔNG ghi đè dữ liệu.
    - File tồn tại mà không đọc được (EACCES, EIO...): ném OSError, không
      backup (không đọc được byte nào) và không ghi đè.
    """
    try:
        with open(DATA_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {}
    except UnicodeDecodeError as exc:
        raw = None
        reason = f"JSON không hợp lệ (encoding): {exc}"
    except json.JSONDecodeError as exc:
        raw = None
        reason = f"JSON không hợp lệ: {exc}"
    else:
        if isinstance(raw, dict):
            return raw
        reason = f"JSON hợp lệ nhưng không phải object (got {type(raw).__name__})"
    backup = _backup_corrupt()
    if for_write:
        raise DataFileUnreadable(
            f"DATA_FILE {DATA_FILE} không đọc/parse được ({reason}). "
            + (f"Đã backup nguyên trạng sang {backup.name}." if backup else
               "Không backup được (không đọc được file) — file gốc giữ nguyên.")
            + " Từ chối ghi đè để không mất dữ liệu; sửa/xóa file hỏng rồi chạy lại."
        )
    return {}


def _seed_new_db() -> dict:
    """File mới: seed đủ 11 collection canonical + schemaVersion hiện hành."""
    db = deepcopy(SEED)
    db["schemaVersion"] = SCHEMA_VERSION
    for key in CANONICAL_COLLECTIONS:
        if not isinstance(db.get(key), list):
            db[key] = []
    return db


def load_db() -> dict:
    raw = _read_raw()
    if raw:
        # Giữ TOÀN BỘ collection (kể cả problems/changes/audit/monitoring
        # và key lạ), chỉ seed collection canonical/legacy thiếu — không xóa key nào.
        db = dict(raw)
        for key in CANONICAL_COLLECTIONS:
            if not isinstance(db.get(key), list):
                db[key] = deepcopy(SEED.get(key) or [])
        return db
    return _seed_new_db()


def _row_key(row):
    """Identity của row dict theo `id`; None nếu row không dict hoặc không có `id`."""
    if not isinstance(row, dict) or "id" not in row:
        return None
    try:
        hash(row["id"])
    except TypeError:  # id unhashable -> coi như không có id
        return None
    return ("id", type(row["id"]).__name__, row["id"])


def _merge_rows(base_rows: list, incoming_rows: list) -> list:
    """Overlay collection Flask quản lý, theo contract:

    - CHỈ dict row là do Flask quản lý; chúng merge theo `id`
      (row trong RAM thắng row cùng id trên đĩa).
    - Row KHÔNG phải dict (legacy scalar/list) trong base: giữ nguyên vẹn, giữ
      thứ tự, không bị thay và không bị nhân bản.
    - Row không phải dict trong `incoming` bị BỎ QUA: đó không phải dữ liệu Flask
      quản lý, không được chèn thêm vào file.
    - Dict row có `id` trùng nhau trong base: canonical thành một dòng (vị trí
      đầu tiên, nội dung row đầu tiên).
    """
    base_rows = list(base_rows or [])
    incoming_dicts = [r for r in (incoming_rows or []) if isinstance(r, dict)]

    incoming_by_key = {}
    for row in incoming_dicts:
        key = _row_key(row)
        if key is not None:
            incoming_by_key.setdefault(key, row)

    merged = []
    seen_keys = set()
    seen_shapeless = set()
    for row in base_rows:
        key = _row_key(row)
        if key is None:
            # scalar/list/dict thiếu id: dữ liệu ngoài phạm vi Flask -> giữ nguyên
            merged.append(row)
            seen_shapeless.add(repr(row))
            continue
        if key in seen_keys:
            continue  # duplicate id trong base -> canonical (bỏ dòng lặp)
        seen_keys.add(key)
        merged.append(incoming_by_key.get(key, row))

    for row in incoming_dicts:
        key = _row_key(row)
        if key is None:
            if repr(row) in seen_shapeless:
                continue  # đã có sẵn trong base -> không nhân bản
            seen_shapeless.add(repr(row))
            merged.append(row)
            continue
        if key in seen_keys:
            continue  # đã merge ở vòng base
        seen_keys.add(key)
        merged.append(row)
    return merged


def _fsync_dir(directory: Path) -> None:
    """fsync directory để rename bền vững khi mất điện (POSIX)."""
    fd = None
    try:
        fd = os.open(str(directory), os.O_RDONLY)
        os.fsync(fd)
    except OSError:
        pass  # filesystem không hỗ trợ fsync dir -> bỏ qua, không làm hỏng write
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def save_db(db: dict) -> None:
    """Read-modify-write: chỉ overlay collection Flask quản lý.

    - File hỏng/không đọc được -> `DataFileUnreadable`, KHÔNG ghi đè.
    - Giữ nguyên `version`/`schemaVersion` của file và mọi collection/key trên
      đĩa; chỉ bổ sung collection canonical còn thiếu (không hồi sinh key đã bị
      process khác xóa).
    - Ghi atomic: `mkstemp` + `fsync(file)` + `os.replace` + `fsync(dir)`.
    """
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    base = _read_raw(for_write=True)  # ném DataFileUnreadable nếu file hỏng
    merged = dict(base)
    for key in MANAGED_COLLECTIONS:
        if isinstance(db.get(key), list):
            base_rows = base.get(key) if isinstance(base.get(key), list) else []
            merged[key] = _merge_rows(base_rows, db[key])
    # Chỉ bổ sung collection CANONICAL còn thiếu trên đĩa; key lạ đã bị xóa
    # thì không hồi sinh (tránh ghi lại giá trị stale trong RAM).
    for key in CANONICAL_COLLECTIONS:
        if key not in merged:
            merged[key] = deepcopy(db.get(key)) if isinstance(db.get(key), list) else []

    body = {k: v for k, v in merged.items()
            if k not in ("version", "updatedAt", "schemaVersion")}
    head = {"version": merged.get("version", 1),
            "updatedAt": datetime.now().isoformat(),
            "schemaVersion": merged.get("schemaVersion", SCHEMA_VERSION)}
    payload = json.dumps({**head, **body}, ensure_ascii=False, indent=2) + "\n"

    fd, tmp = tempfile.mkstemp(dir=str(DATA_FILE.parent), prefix="db.json.tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())  # bền vững nội dung trước khi rename
        os.replace(tmp, DATA_FILE)  # atomic rename
        _fsync_dir(DATA_FILE.parent)  # bền vững chính thư mục chứa rename
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


DB = load_db()

# MỘT khoá cho MỌI request (đọc và ghi): validate -> next_id -> snapshot ->
# ghi đĩa -> commit đều nằm trong cùng critical section, nên request song song
# không đọc trạng thái nửa vời và không cấp id trùng.
# (Multi-process trên cùng file vẫn unsupported — shared JSON là unsupported.)
_DB_LOCK = threading.RLock()


def _snapshot() -> dict:
    """Bản sao sâu của DB để thử thay đổi không đụng RAM trước khi ghi đĩa."""
    return deepcopy(DB)


def _persist(snapshot: dict) -> None:
    """Ghi đĩa trước, rồi mới commit vào RAM bằng ATOMIC POINTER SWAP.

    - `save_db` lỗi -> exception nổi lên, `DB` (pointer) không đổi, RAM giữ
      nguyên pre-state, retry không nhân bản row.
    - Thành công -> `global DB = snapshot`: pointer swap là một lệnh gán, nên
      reader khác thread không bao giờ thấy object nửa vời. Lưu ý: tham chiếu
      cũ tới object DB trước đó trở thành snapshot bất biến (đọc được, không
      được sửa nữa) — luôn đọc qua `app.DB`.
    """
    global DB
    save_db(snapshot)
    DB = snapshot


def next_id(rows: list, start: int = 1) -> int:
    if not rows:
        return start
    return max((r.get("id", 0) for r in rows
                if isinstance(r, dict) and isinstance(r.get("id"), int)),
               default=start - 1) + 1


def filter_rows(rows: list, args, fields: list) -> list:
    q = (args.get("q") or "").lower().strip()
    status = (args.get("status") or "").lower().strip()
    priority = (args.get("priority") or "").lower().strip()
    out = []
    for r in rows:
        if not isinstance(r, dict):  # row legacy không phải object -> giữ nguyên
            if not q:
                out.append(r)
            continue
        if q and not any(q in str(r.get(f, "")).lower() for f in fields):
            continue
        if status and str(r.get("status", "")).lower() != status:
            continue
        if priority and str(r.get("priority", "")).lower() != priority:
            continue
        out.append(r)
    return out


app = Flask(__name__)
CORS(app)


# KHÔNG dùng before_request/teardown_request để giữ lock: hook ở cấp request sẽ
# kéo cả lệnh gọi provider chậm (AI/RAG) vào critical section và chặn mọi
# request khác. Thay vào đó MỖI route tự `with _DB_LOCK:` đúng phạm vi cần thiết;
# `tests/test_ai_lock.py::RouteLockAuditTest` audit lại điều này.


# ---- Minimal Prometheus helper (additive; zero new dependencies) --------------
# In-memory request counters + process start time for GET /metrics below.
# Unauthenticated (standard for Prometheus scraping). Deliberately a WSGI-level
# wrapper — NOT @app.before_request/@app.after_request — because
# tests/test_ai_lock.py::RouteLockAuditTest forbids request-scoped hooks
# (they would pull slow provider calls into a critical section). No existing
# route, auth, or response shape is changed.
_METRICS_START = time.time()
_metrics_counts: dict = {}


class _PrometheusMiddleware:
    """WSGI wrapper counting (method, path, status) -> hits.

    Lock-free single-dict increments only; never touches _DB_LOCK or the DB,
    so slow routes are never blocked by metrics.
    """

    def __init__(self, wrapped):
        self._wrapped = wrapped

    def __call__(self, environ, start_response):
        method = environ.get("REQUEST_METHOD", "?")
        path = (environ.get("PATH_INFO", "/") or "/").split("?")[0]
        holder: dict = {}

        def _capture(status, headers, exc_info=None):
            holder["status"] = status.split(" ", 1)[0]
            return start_response(status, headers, exc_info)

        body = self._wrapped(environ, _capture)
        key = (method, path, holder.get("status", "500"))
        _metrics_counts[key] = _metrics_counts.get(key, 0) + 1
        return body


_wsgi_inner = getattr(app, "wsgi_app", None)
if _wsgi_inner is not None:
    app.wsgi_app = _PrometheusMiddleware(_wsgi_inner)
# (Under the stdlib-only stub Flask in tests/test_invariants.py there is no
# wsgi_app — the /metrics route below still loads; only live counting is off.)


@app.get("/api/health")
def health():
    with _DB_LOCK:
        counts = {"assets": len(DB["assets"]), "tickets": len(DB["tickets"])}
    return jsonify({
        "status": "ok", "service": "it-asset-portal-python",
        "framework": "Flask", "storage": "json-file",
        "scope": "demo-only (no auth, loopback default)",
        "counts": counts,
        "timestamp": stamp(),
    })


@app.get("/metrics")
def metrics_prometheus():
    """Prometheus text exposition (unauthenticated, aggregate-only, no PII).

    Scraped by the observability stack. Request counters come from the
    WSGI-level _PrometheusMiddleware (no Flask request hooks — see
    tests/test_ai_lock.py::RouteLockAuditTest); DB counts are read under
    _DB_LOCK briefly and never held across I/O.
    """
    with _DB_LOCK:
        n_assets = len(DB["assets"])
        tickets = [t for t in DB["tickets"] if isinstance(t, dict)]
    n_open = len([t for t in tickets if t.get("status") in OPEN_STATUSES])
    lines = [
        "# HELP ticket_count Tickets currently in store.",
        "# TYPE ticket_count gauge",
        f"ticket_count {len(tickets)}",
        "# HELP tickets_open Currently open tickets.",
        "# TYPE tickets_open gauge",
        f"tickets_open {n_open}",
        "# HELP assets_total Assets currently in store.",
        "# TYPE assets_total gauge",
        f"assets_total {n_assets}",
        "# HELP process_uptime_seconds Process uptime in seconds.",
        "# TYPE process_uptime_seconds gauge",
        f"process_uptime_seconds {time.time() - _METRICS_START:.2f}",
        "# HELP http_requests_total Total HTTP requests by route and status.",
        "# TYPE http_requests_total counter",
    ]
    for (method, route, status), count in sorted(_metrics_counts.items()):
        safe = route.replace('"', '')
        lines.append(f'http_requests_total{{method="{method}",route="{safe}",status="{status}"}} {count}')
    return Response("\n".join(lines) + "\n", mimetype="text/plain; version=0.0.4")


@app.get("/api/dashboard/stats")
def stats():
    with _DB_LOCK:
        assets, tickets = DB["assets"], DB["tickets"]
    dicts = [t for t in tickets if isinstance(t, dict)]
    open_t = [t for t in dicts if t.get("status") in OPEN_STATUSES]
    done = [t for t in dicts if t.get("status") in ("Resolved", "Closed")]
    return jsonify({
        "totalAssets": len(assets),
        "activeAssets": len([a for a in assets
                             if isinstance(a, dict) and a.get("status") == "Active"]),
        "openTickets": len(open_t),
        "resolvedTickets": len([t for t in dicts if t.get("status") == "Resolved"]),
        "criticalAlerts": len([t for t in open_t if t.get("priority") in ("High", "Critical")]),
        "slaPercent": round(len(done) / len(tickets) * 100, 1) if tickets else 100,
        "generatedAt": stamp(),
    })


@app.get("/api/assets")
def list_assets():
    with _DB_LOCK:
        rows = filter_rows(DB["assets"], request.args,
                           ["tag", "type", "brand", "model", "serial", "assignedTo",
                            "dept", "status"])
    return jsonify(rows)


@app.post("/api/assets")
def create_asset():
    body = request.get_json(force=True, silent=True) or {}
    missing = [f for f in ("tag", "brand", "model", "serial") if not str(body.get(f, "")).strip()]
    if missing:
        return jsonify({"error": "Thiếu trường bắt buộc.", "details": missing, "status": 400}), 400
    if body.get("status") and body["status"] not in ASSET_STATUSES:
        return jsonify({"error": f"Status phải là một trong {ASSET_STATUSES}", "status": 422}), 422
    tag = str(body["tag"]).strip()
    with _DB_LOCK:
        # Trùng tag + cấp id phải nằm trong CÙNG critical section với lúc ghi,
        # nếu không hai request song song sẽ cùng thấy DB cũ và cấp trùng id.
        if any(isinstance(a, dict) and a.get("tag", "").lower() == tag.lower()
               for a in DB["assets"]):
            return jsonify({"error": f'Asset Tag "{tag}" đã tồn tại.', "status": 409}), 409
        asset = {
            "id": next_id(DB["assets"]),
            "tag": tag, "type": str(body.get("type") or "Laptop").strip(),
            "brand": str(body["brand"]).strip(), "model": str(body["model"]).strip(),
            "serial": str(body["serial"]).strip(),
            "assignedTo": str(body.get("assignedTo") or "Unassigned").strip(),
            "dept": str(body.get("dept") or "General").strip(),
            "status": body.get("status") or "Active",
            "ip": str(body.get("ip") or "-").strip(),
            "createdAt": stamp(),
        }
        snapshot = _snapshot()
        snapshot["assets"].insert(0, asset)
        try:
            _persist(snapshot)
        except Exception as exc:
            app.logger.exception("save assets thất bại")
            return jsonify({
                "error": f"Không lưu được tài sản: {exc}",
                "status": 500,
            }), 500
    return jsonify(asset), 201


@app.get("/api/tickets")
def list_tickets():
    with _DB_LOCK:
        rows = filter_rows(DB["tickets"], request.args,
                           ["title", "requester", "dept", "category", "status",
                            "priority"])
    return jsonify(rows)


@app.post("/api/tickets")
def create_ticket():
    body = request.get_json(force=True, silent=True) or {}
    missing = [f for f in ("title", "requester") if not str(body.get(f, "")).strip()]
    if missing:
        return jsonify({"error": "Thiếu trường bắt buộc.", "details": missing, "status": 400}), 400
    if body.get("priority") and body["priority"] not in PRIORITIES:
        return jsonify({"error": f"Priority phải là một trong {PRIORITIES}", "status": 422}), 422
    with _DB_LOCK:
        ticket = {
            "id": next_id(DB["tickets"], start=1001),
            "title": str(body["title"]).strip(),
            "requester": str(body["requester"]).strip(),
            "dept": str(body.get("dept") or "General").strip(),
            "priority": body.get("priority") or "Medium",
            "status": "Open",
            "category": str(body.get("category") or "General").strip(),
            "createdAt": stamp(),
        }
        snapshot = _snapshot()
        snapshot["tickets"].insert(0, ticket)
        try:
            _persist(snapshot)
        except Exception as exc:
            app.logger.exception("save tickets thất bại")
            return jsonify({
                "error": f"Không lưu được ticket: {exc}",
                "status": 500,
            }), 500
    return jsonify(ticket), 201


@app.patch("/api/tickets/<int:tid>/status")
def update_ticket(tid: int):
    body = request.get_json(force=True, silent=True) or {}
    status = body.get("status", "Resolved")
    if status not in TICKET_STATUSES:
        return jsonify({"error": f"Status phải là một trong {TICKET_STATUSES}", "status": 422}), 422
    with _DB_LOCK:
        snapshot = _snapshot()
        # Chỉ match đúng MỘT row dict có id này -> update không nhân bản.
        target = next((t for t in snapshot["tickets"]
                       if _row_key(t) == ("id", "int", tid)), None)
        if target is None:
            return jsonify({"error": f'Ticket id "{tid}" không tồn tại.', "status": 404}), 404
        target["status"] = status
        target["updatedAt"] = stamp()
        try:
            _persist(snapshot)
        except Exception as exc:
            app.logger.exception("save ticket status thất bại")
            return jsonify({
                "error": f"Không lưu được trạng thái ticket: {exc}",
                "status": 500,
            }), 500
    return jsonify(target)


@app.get("/api/ai/status")
def ai_stat():
    return jsonify(ai_status())


@app.post("/api/ai/analyze")
def ai_analyze():
    """EXTERNAL I/O: cố tình KHÔNG giữ _DB_LOCK khi gọi provider.

    `analyze_ticket` có thể mất vài giây (OpenAI/Ollama/RAG) và không mutate DB.
    Vì vậy chỉ COPY ticket/context dưới lock rồi thả lock ngay, sau đó mới gọi
    provider — nếu không, mọi request khác (kể cả `GET /api/health`) bị chặn.
    """
    body = request.get_json(force=True, silent=True) or {}
    if body.get("ticketId") is not None and str(body.get("ticketId")).strip() != "":
        try:
            tid = int(body["ticketId"])
        except (TypeError, ValueError):
            return jsonify({"error": "ticketId phải là số.", "status": 400}), 400
        with _DB_LOCK:
            found = next((t for t in DB["tickets"]
                          if _row_key(t) == ("id", "int", tid)), None)
            if found is None:
                return jsonify({"error": f'Ticket "{body["ticketId"]}" không tồn tại.',
                                "status": 404}), 404
            # Bản sao: provider/RAG có thể giữ/sửa dict, không được chạm DB thật.
            ticket = deepcopy(found)
    elif not str(body.get("title", "")).strip():
        return jsonify({"error": "Cần ticketId hoặc title trong body.", "status": 400}), 400
    else:
        ticket = {
            "title": str(body.get("title", "")),
            "requester": str(body.get("requester", "")),
            "dept": str(body.get("dept", "")),
            "priority": body.get("priority") if body.get("priority") in PRIORITIES else "Medium",
            "category": str(body.get("category", "General")),
        }
    # >>> Ngoài critical section: không chặn request khác trong lúc chờ provider.
    result = analyze_ticket(ticket)
    return jsonify({"ticketId": ticket.get("id"), **result})


@app.get("/api/assets/export.csv")
def export_assets():
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "tag", "type", "brand", "model", "serial", "assignedTo", "dept", "status", "ip"])
    with _DB_LOCK:
        rows = list(DB["assets"])
    for a in rows:
        w.writerow([a.get(k, "") if isinstance(a, dict) else a
                    for k in ("id", "tag", "type", "brand", "model", "serial",
                              "assignedTo", "dept", "status", "ip")])
    return Response(buf.getvalue(), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="IT-Asset-Audit.csv"'})


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=False)
