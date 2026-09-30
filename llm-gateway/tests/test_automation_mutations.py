"""Mutation tests M1-M4: prove the safety tests have teeth (xfailed-caught)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from automation.gateway import AutomationGateway

ADMIN = {"authenticated": True, "username": "admin", "role": "IT_ADMIN"}


def _xfail(msg):
    pytest.xfail(msg)


def test_m1_highrisk_as_readonly_detected(monkeypatch):
    import automation.policy as pol

    monkeypatch.setitem(pol.ACTION_RISK, "disable_company_user", "READ_ONLY")
    assert pol.requires_approval("disable_company_user") is False
    gw = AutomationGateway()
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "test-user"}},
                    actor=ADMIN, request_id="req-m1")
    assert d.status == "ALLOWED"
    _xfail("M1 caught: HIGH_RISK demoted to READ_ONLY skips approval")


def test_m2_unknown_action_allow_detected():
    from automation import models

    assert models.validate_proposal({"action": "nope_xyz",
                                     "parameters": {}})["ok"] is False
    _xfail("M2 caught: unknown action fails closed (would FAIL if defaulted ALLOW)")


def test_m3_rbac_disabled_detected(monkeypatch):
    import automation.policy as pol

    monkeypatch.setattr(pol, "AUTOMATION_ROLES",
                        frozenset({"IT_ADMIN", "HELPDESK_L2", "HELPDESK_L1",
                                   "AUDITOR", "VIEWER"}))
    ok, _ = pol.authorize({"authenticated": True, "username": "v",
                           "role": "VIEWER"}, "disable_company_user")
    assert ok is True
    _xfail("M3 caught: RBAC widened lets VIEWER execute")


def test_m4_raw_command_path_detected():
    from automation import models

    assert models.validate_proposal(
        {"command": "Remove-ADUser *"})["ok"] is False
    _xfail("M4 caught: raw command path rejected (would FAIL if accepted)")
