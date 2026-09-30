"""Action risk policy + RBAC (fail-closed). Part 1: risk + forbidden + RBAC."""
from __future__ import annotations

import re

READ_ONLY = "READ_ONLY"
LOW_RISK = "LOW_RISK"
HIGH_RISK = "HIGH_RISK"
FORBIDDEN = "FORBIDDEN"

ACTION_RISK = {
    "test_network_health": READ_ONLY,
    "test_print_scan_health": READ_ONLY,
    "export_it_asset_audit": LOW_RISK,
    "backup_helpdesk_data": LOW_RISK,
    "backup_ad_configuration": LOW_RISK,
    "new_company_user": HIGH_RISK,
    "disable_company_user": HIGH_RISK,
    "restore_helpdesk_data": HIGH_RISK,
}

AUTOMATION_ROLES = frozenset({
    "IT_ADMIN", "HELPDESK_L2",
})

FORBIDDEN_PATTERNS = (
    re.compile(r"remove-aduser\s+\*", re.IGNORECASE),
    re.compile(r"remove-aduser\b.*-confirm\s*:\s*\$false", re.IGNORECASE),
    re.compile(r"invoke-expression|\biex\b\s*\(", re.IGNORECASE),
    re.compile(r"remove-item\b.*-recurse", re.IGNORECASE),
    re.compile(r"audit.*(delete|clear|remove)", re.IGNORECASE),
)


def action_risk(action: str) -> str:
    return ACTION_RISK.get(action, "UNKNOWN")


def requires_approval(action: str) -> bool:
    return action_risk(action) == HIGH_RISK


def is_forbidden_input(text: str) -> tuple:
    blob = str(text or "")
    for pat in FORBIDDEN_PATTERNS:
        if pat.search(blob):
            return True, "forbidden pattern: " + pat.pattern[:60]
    if blob.strip() == "*":
        return True, "wildcard identity"
    return False, ""


def authorize(actor, action: str) -> tuple:
    if not actor or not actor.get("authenticated"):
        return False, "unauthenticated"
    role = str(actor.get("role", "") or "")
    if role in AUTOMATION_ROLES:
        return True, "role " + role + " may propose " + action
    return False, "role " + role + " lacks automation:execute"


USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
RESERVED_USERNAMES = frozenset({"*", "all", "administrator", "admin", "system"})

APPROVED_DATA_ROOTS = ("data", "backups", "_evidence")


def confine_path(value: str) -> tuple:
    from pathlib import Path

    raw = str(value or "")
    if "\x00" in raw or "\n" in raw or "\r" in raw:
        return False, "path contains control characters"
    rel = Path(raw)
    if rel.is_absolute():
        return False, "absolute path not allowed"
    if ".." in rel.parts:
        return False, "path escape"
    if not rel.parts or rel.parts[0] not in APPROVED_DATA_ROOTS:
        return False, "path outside approved roots"
    if any(ch in raw for ch in (";", "&", "|", "`", "$", "(", ")")):
        return False, "shell metacharacters in path"
    return True, ""


def validate_parameters(action: str, params: dict) -> tuple:
    params = dict(params or {})
    if action == "disable_company_user":
        username = str(params.get("username", params.get("sam_account_name", "")) or "")
        bad, why = is_forbidden_input(username)
        if bad:
            return False, "username " + why, {}
        if not USERNAME_RE.match(username):
            return False, "username must match [A-Za-z0-9._-]{1,64}", {}
        if username.lower() in RESERVED_USERNAMES:
            return False, "reserved username", {}
        return True, "ok", {"username": username}
    if action == "new_company_user":
        csv_path = str(params.get("csv_path", "data/new_employees.csv") or "")
        ok, why = confine_path(csv_path)
        if not ok:
            return False, "csv_path " + why, {}
        return True, "ok", {"csv_path": csv_path}
    if action == "restore_helpdesk_data":
        out = {}
        for key in ("backup_file", "target_file"):
            val = str(params.get(key, "") or "")
            if not val:
                return False, key + " is required", {}
            ok, why = confine_path(val)
            if not ok:
                return False, key + " " + why, {}
            out[key] = val
        return True, "ok", out
    if action in ("backup_helpdesk_data", "backup_ad_configuration"):
        out = {}
        for key in ("data_dir", "output_path"):
            if key in params and params[key] not in (None, ""):
                ok, why = confine_path(str(params[key]))
                if not ok:
                    return False, key + " " + why, {}
                out[key] = str(params[key])
        return True, "ok", out
    if action in ("test_network_health", "test_print_scan_health"):
        return True, "ok", {}
    if action == "export_it_asset_audit":
        if "output_path" in params and params["output_path"] not in (None, ""):
            ok, why = confine_path(str(params["output_path"]))
            if not ok:
                return False, "output_path " + why, {}
            return True, "ok", {"output_path": str(params["output_path"])}
        return True, "ok", {}
    return False, "no validator for action", {}
