"""
IT Asset & Helpdesk Portal — Python Flask port (cho JD yêu cầu Python).

Chạy song song với bản Node.js, dùng chung file ../data/db.json nên
HR/demo thấy đúng nghiệp vụ: quản lý tài sản + ticket + AI chẩn đoán.

  pip install -r requirements.txt
  python app.py  # -> http://localhost:5001

Endpoints (tương đương bản Node):
  GET  /api/health, /api/dashboard/stats
  GET  /api/assets, POST /api/assets
  GET  /api/tickets, POST /api/tickets, PATCH /api/tickets/<id>/status
  GET  /api/ai/status, POST /api/ai/analyze
"""
import json
import os
import tempfile
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, Response
from flask_cors import CORS

from ai_providers import analyze_ticket, ai_status

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("DATA_FILE", BASE_DIR.parent / "data" / "db.json"))
PORT = int(os.environ.get("PORT", "5001"))

ASSET_STATUSES = ["Active", "In Storage", "Maintenance", "Retired"]
TICKET_STATUSES = ["Open", "In Progress", "Resolved", "Closed"]
PRIORITIES = ["Low", "Medium", "High", "Critical"]
OPEN_STATUSES = {"Open", "In Progress"}

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
}


def stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def load_db() -> dict:
    if DATA_FILE.exists():
        try:
            with open(DATA_FILE, encoding="utf-8") as f:
                raw = json.load(f)
            return {
                "assets": list(raw.get("assets", [])),
                "tickets": list(raw.get("tickets", [])),
                "licenses": list(raw.get("licenses", [])),
            }
        except (json.JSONDecodeError, OSError):
            pass
    return deepcopy(SEED)


def save_db(db: dict) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {"version": 1, "updatedAt": datetime.now().isoformat(), **db},
        ensure_ascii=False, indent=2,
    ) + "\n"
    fd, tmp = tempfile.mkstemp(dir=str(DATA_FILE.parent), prefix="db.json.tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, DATA_FILE)  # atomic rename
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


DB = load_db()


def next_id(rows: list, start: int = 1) -> int:
    if not rows:
        return start
    return max((r.get("id", 0) for r in rows if isinstance(r.get("id"), int)), default=start - 1) + 1


def filter_rows(rows: list, args, fields: list) -> list:
    q = (args.get("q") or "").lower().strip()
    status = (args.get("status") or "").lower().strip()
    priority = (args.get("priority") or "").lower().strip()
    out = []
    for r in rows:
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


@app.get("/api/health")
def health():
    return jsonify({
        "status": "ok", "service": "it-asset-portal-python",
        "framework": "Flask", "storage": "json-file",
        "counts": {"assets": len(DB["assets"]), "tickets": len(DB["tickets"])},
        "timestamp": stamp(),
    })


@app.get("/api/dashboard/stats")
def stats():
    assets, tickets = DB["assets"], DB["tickets"]
    open_t = [t for t in tickets if t.get("status") in OPEN_STATUSES]
    done = [t for t in tickets if t.get("status") in ("Resolved", "Closed")]
    return jsonify({
        "totalAssets": len(assets),
        "activeAssets": len([a for a in assets if a.get("status") == "Active"]),
        "openTickets": len(open_t),
        "resolvedTickets": len([t for t in tickets if t.get("status") == "Resolved"]),
        "criticalAlerts": len([t for t in open_t if t.get("priority") in ("High", "Critical")]),
        "slaPercent": round(len(done) / len(tickets) * 100, 1) if tickets else 100,
        "generatedAt": stamp(),
    })


@app.get("/api/assets")
def list_assets():
    rows = filter_rows(DB["assets"], request.args,
                       ["tag", "type", "brand", "model", "serial", "assignedTo", "dept", "status"])
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
    if any(a.get("tag", "").lower() == tag.lower() for a in DB["assets"]):
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
    DB["assets"].insert(0, asset)
    save_db(DB)
    return jsonify(asset), 201


@app.get("/api/tickets")
def list_tickets():
    rows = filter_rows(DB["tickets"], request.args,
                       ["title", "requester", "dept", "category", "status", "priority"])
    return jsonify(rows)


@app.post("/api/tickets")
def create_ticket():
    body = request.get_json(force=True, silent=True) or {}
    missing = [f for f in ("title", "requester") if not str(body.get(f, "")).strip()]
    if missing:
        return jsonify({"error": "Thiếu trường bắt buộc.", "details": missing, "status": 400}), 400
    if body.get("priority") and body["priority"] not in PRIORITIES:
        return jsonify({"error": f"Priority phải là một trong {PRIORITIES}", "status": 422}), 422
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
    DB["tickets"].insert(0, ticket)
    save_db(DB)
    return jsonify(ticket), 201


@app.patch("/api/tickets/<int:tid>/status")
def update_ticket(tid: int):
    ticket = next((t for t in DB["tickets"] if t.get("id") == tid), None)
    if not ticket:
        return jsonify({"error": f'Ticket id "{tid}" không tồn tại.', "status": 404}), 404
    body = request.get_json(force=True, silent=True) or {}
    status = body.get("status", "Resolved")
    if status not in TICKET_STATUSES:
        return jsonify({"error": f"Status phải là một trong {TICKET_STATUSES}", "status": 422}), 422
    ticket["status"] = status
    ticket["updatedAt"] = stamp()
    save_db(DB)
    return jsonify(ticket)


@app.get("/api/ai/status")
def ai_stat():
    return jsonify(ai_status())


@app.post("/api/ai/analyze")
def ai_analyze():
    body = request.get_json(force=True, silent=True) or {}
    ticket = None
    if body.get("ticketId") is not None and str(body.get("ticketId")).strip() != "":
        try:
            tid = int(body["ticketId"])
        except (TypeError, ValueError):
            return jsonify({"error": "ticketId phải là số.", "status": 400}), 400
        ticket = next((t for t in DB["tickets"] if t.get("id") == tid), None)
        if not ticket:
            return jsonify({"error": f'Ticket "{body["ticketId"]}" không tồn tại.', "status": 404}), 404
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
    result = analyze_ticket(ticket)
    return jsonify({"ticketId": ticket.get("id"), **result})


@app.get("/api/assets/export.csv")
def export_assets():
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "tag", "type", "brand", "model", "serial", "assignedTo", "dept", "status", "ip"])
    for a in DB["assets"]:
        w.writerow([a.get(k, "") for k in ("id", "tag", "type", "brand", "model", "serial", "assignedTo", "dept", "status", "ip")])
    return Response(buf.getvalue(), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="IT-Asset-Audit.csv"'})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False)
