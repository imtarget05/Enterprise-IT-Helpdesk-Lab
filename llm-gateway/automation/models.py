"""Structured action model — the ONLY shape the AI may propose.

The LLM proposes ACTION ID + STRUCTURED PARAMETERS. It MUST NOT emit an
executable shell command::

    {"action": "disable_company_user",
     "parameters": {"username": "test-user"},
     "reason": "..."}

BAD (rejected as INVALID)::

    {"command": "Disable-ADAccount -Identity bob"}
    {"powershell": "Remove-ADUser *"}

There is NO raw-command field in this schema by design. Regex/denylist
checks in policy.py are defense-in-depth for malicious fixtures, not the
security boundary — the boundary is that no executor path accepts a
command string at all.
"""
from __future__ import annotations

PROPOSAL_SCHEMA_VERSION = "automation.proposal/v1"

SUPPORTED_ACTIONS = frozenset({
    "test_network_health",
    "test_print_scan_health",
    "export_it_asset_audit",
    "backup_helpdesk_data",
    "backup_ad_configuration",
    "new_company_user",
    "disable_company_user",
    "restore_helpdesk_data",
})

# Top-level fields the gateway accepts. Anything executable-shaped is absent
# on purpose: command / powershell / script / script_path / shell.
ALLOWED_TOP_LEVEL = frozenset({"action", "parameters", "reason", "ticket_id", "request_id"})

# Fields that prove the proposer tried to smuggle an executable command.
RAW_COMMAND_FIELDS = frozenset({
    "command", "powershell", "script", "script_text", "script_path",
    "shell", "cmd", "command_text", "ps_command", "invoke",
})


def validate_proposal(proposal) -> dict:
    """Validate a raw proposal dict. Returns {ok, action, parameters, ...}."""
    if not isinstance(proposal, dict):
        return {"ok": False, "code": "INVALID",
                "error": "proposal must be an object"}
    raw_hits = sorted(RAW_COMMAND_FIELDS.intersection(proposal.keys()))
    if raw_hits:
        return {"ok": False, "code": "INVALID",
                "error": "raw command field rejected: " + ",".join(raw_hits),
                "raw_fields": raw_hits}
    unknown_top = sorted(set(proposal.keys()) - ALLOWED_TOP_LEVEL)
    if unknown_top:
        return {"ok": False, "code": "INVALID",
                "error": "unknown top-level fields: " + ",".join(unknown_top),
                "unknown_fields": unknown_top}
    action = proposal.get("action")
    if not isinstance(action, str) or not action:
        return {"ok": False, "code": "INVALID",
                "error": "missing action id"}
    if action not in SUPPORTED_ACTIONS:
        return {"ok": False, "code": "UNKNOWN_ACTION",
                "error": "unknown action: " + str(action)[:80],
                "action": action}
    params = proposal.get("parameters", {})
    if not isinstance(params, dict):
        return {"ok": False, "code": "INVALID",
                "error": "parameters must be an object",
                "action": action}
    return {"ok": True, "action": action, "parameters": dict(params),
            "reason": proposal.get("reason", ""),
            "ticket_id": proposal.get("ticket_id"),
            "request_id": proposal.get("request_id")}
