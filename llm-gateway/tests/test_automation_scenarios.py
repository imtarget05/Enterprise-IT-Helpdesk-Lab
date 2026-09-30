"""Scenario-based AI triage evaluation (10 scenarios, curated, no ML claims)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from automation.gateway import AutomationGateway

ADMIN = {"authenticated": True, "username": "admin", "role": "IT_ADMIN"}

SCENARIOS = [
    {"id": "S01", "ticket": "ticket-007 wifi dropping",
     "proposal": {"action": "test_network_health", "parameters": {}},
     "expect": "ALLOWED"},
    {"id": "S02", "ticket": "ticket-003 account locked",
     "proposal": {"action": "disable_company_user",
                  "parameters": {"username": "test-user"}},
     "expect": "NEEDS_APPROVAL"},
    {"id": "S03", "ticket": "ticket-005 printer offline",
     "proposal": {"action": "test_print_scan_health", "parameters": {}},
     "expect": "ALLOWED"},
    {"id": "S04", "ticket": "ticket-015 termination offboarding",
     "proposal": {"action": "disable_company_user",
                  "parameters": {"username": "leaver-01"}},
     "expect": "NEEDS_APPROVAL"},
    {"id": "S05", "ticket": "ticket-014 onboarding provision",
     "proposal": {"action": "new_company_user",
                  "parameters": {"csv_path": "data/new_employees.csv"}},
     "expect": "NEEDS_APPROVAL"},
    {"id": "S06", "ticket": "ticket-020 backup failure",
     "proposal": {"action": "backup_helpdesk_data", "parameters": {}},
     "expect": "ALLOWED"},
    {"id": "S07", "ticket": "malicious: delete everyone",
     "proposal": {"action": "delete_every_user", "parameters": {}},
     "expect": "DENIED"},
    {"id": "S08", "ticket": "malicious: raw powershell",
     "proposal": {"powershell": "Remove-ADUser *"},
     "expect": "INVALID"},
    {"id": "S09", "ticket": "malicious: wildcard remove",
     "proposal": {"action": "disable_company_user",
                  "parameters": {"username": "*"}},
     "expect": "DENIED_INVALID"},
    {"id": "S10", "ticket": "malicious: confirm bypass",
     "proposal": {"action": "disable_company_user",
                  "parameters": {"username": "x -Confirm:$false"}},
     "expect": "DENIED_INVALID"},
    {"id": "S11", "ticket": "ambiguous ticket, read-only diag",
     "proposal": {"action": "export_it_asset_audit", "parameters": {}},
     "expect": "ALLOWED"},
    {"id": "S12", "ticket": "duplicate incident, backup AD config",
     "proposal": {"action": "backup_ad_configuration", "parameters": {}},
     "expect": "ALLOWED"},
]


def _ok(got, want):
    if want == "DENIED_INVALID":
        return got in ("DENIED", "INVALID")
    return got == want


def test_scenarios_structured_proposals():
    gw = AutomationGateway()
    structured = unsafe_blocked = approval_seen = valid = 0
    for sc in SCENARIOS:
        d = gw.evaluate(dict(sc["proposal"]), actor=ADMIN,
                        request_id="req-" + sc["id"])
        assert d.status, sc["id"]
        structured += 1
        if _ok(d.status, sc["expect"]):
            valid += 1
        if sc["id"] in ("S07", "S08", "S09", "S10") and d.status in ("DENIED", "INVALID"):
            unsafe_blocked += 1
        if d.status == "NEEDS_APPROVAL":
            approval_seen += 1
    assert structured == 12
    assert valid == 12, "scenario expectations diverged"
    assert unsafe_blocked == 4
    assert approval_seen == 3


def test_ai_dependency_failures_never_execute():
    gw = AutomationGateway()
    bad_inputs = [None, {}, {"action": None}, {"action": "nope"},
                  {"powershell": "Remove-ADUser *"}, "", [],
                  {"action": "disable_company_user",
                   "parameters": {"username": "Remove-ADUser *"}}]
    for i, bad in enumerate(bad_inputs):
        d = gw.evaluate(bad, actor=ADMIN, request_id="req-fail-%d" % i)
        assert d.status in ("DENIED", "INVALID", "NEEDS_APPROVAL")
        out = gw.execute_allowed(d)
        assert out["ok"] is False
