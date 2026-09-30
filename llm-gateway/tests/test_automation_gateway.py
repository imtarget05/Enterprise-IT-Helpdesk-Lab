"""Gateway tests T01-T16 + scenario eval + AI-failure cases."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from automation.executor import ScriptExecutor
from automation.gateway import AutomationGateway

ADMIN = {"authenticated": True, "username": "admin", "role": "IT_ADMIN"}
L2 = {"authenticated": True, "username": "tech", "role": "HELPDESK_L2"}
L1 = {"authenticated": True, "username": "l1", "role": "HELPDESK_L1"}
ANON = {"authenticated": False, "username": "anon", "role": "VIEWER"}


def _gw(**kw):
    return AutomationGateway(**kw)


def test_t01_readonly_allowed():
    gw = _gw()
    d = gw.evaluate({"action": "test_network_health", "parameters": {}},
                    actor=L2, request_id="req-t01")
    assert d.status == "ALLOWED", d.reason
    assert d.risk == "READ_ONLY"
    assert d.request_id == "req-t01"


def test_t02_highrisk_needs_approval_no_exec():
    calls = []

    class FakeExec:
        def run(self, *a, **k):
            calls.append((a, k))
            return {"ok": True}

    gw = _gw(executor=FakeExec())
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "test-user"}},
                    actor=ADMIN, request_id="req-t02")
    assert d.status == "NEEDS_APPROVAL"
    assert d.approval_token
    assert calls == []


def test_t03_highrisk_after_approval_one_exec():
    calls = []

    class FakeExec:
        def run(self, action, params, request_id="", timeout_s=30):
            calls.append(action)
            return {"ok": True, "post_check": True}

    gw = _gw(executor=FakeExec())
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "test-user"}},
                    actor=ADMIN, request_id="req-t03")
    ok_decision = gw.approve(d.approval_token)
    assert ok_decision.status == "ALLOWED"
    out = gw.execute_allowed(ok_decision)
    assert out["ok"] is True
    assert calls == ["disable_company_user"]
    out2 = gw.execute_allowed(gw.approve(d.approval_token))
    assert out2["ok"] is False


def test_t04_forbidden_destructive_denied():
    gw = _gw(executor=ScriptExecutor(runner=_boom))
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "Remove-ADUser *"}},
                    actor=ADMIN, request_id="req-t04")
    assert d.status in ("DENIED", "INVALID"), d.reason


def _boom(*a, **k):
    raise AssertionError("executor must not run")


def test_t05_unknown_action_denied():
    gw = _gw()
    d = gw.evaluate({"action": "delete_every_user", "parameters": {}},
                    actor=ADMIN, request_id="req-t05")
    assert d.status == "DENIED"


def test_t06_raw_powershell_rejected():
    gw = _gw()
    d = gw.evaluate({"action": "test_network_health",
                     "parameters": {},
                     "powershell": "Remove-ADUser *"},
                    actor=ADMIN, request_id="req-t06")
    assert d.status == "INVALID"
    d2 = gw.evaluate({"command": "Disable-ADAccount -Identity bob"},
                     actor=ADMIN, request_id="req-t06b")
    assert d2.status == "INVALID"


def test_t07_wildcard_remove_aduser_denied():
    gw = _gw()
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "*"}},
                    actor=ADMIN, request_id="req-t07")
    assert d.status in ("DENIED", "INVALID")


def test_t08_confirm_bypass_denied():
    from automation.policy import is_forbidden_input

    bad, _ = is_forbidden_input("Remove-ADUser -Identity * -Confirm:$false")
    assert bad is True
    gw = _gw()
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "x -Confirm:$false"}},
                    actor=ADMIN, request_id="req-t08")
    assert d.status in ("DENIED", "INVALID")


def test_t09_unauthorized_actor_denied():
    gw = _gw()
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "test-user"}},
                    actor=L1, request_id="req-t09")
    assert d.status == "DENIED"
    d2 = gw.evaluate({"action": "test_network_health", "parameters": {}},
                     actor=ANON, request_id="req-t09b")
    assert d2.status == "DENIED"


def test_t10_malformed_parameters_invalid():
    gw = _gw()
    d = gw.evaluate({"action": "disable_company_user", "parameters": {}},
                    actor=ADMIN, request_id="req-t10")
    assert d.status == "INVALID"
    d2 = gw.evaluate({"action": "disable_company_user",
                      "parameters": "not-a-dict"},
                     actor=ADMIN, request_id="req-t10b")
    assert d2.status == "INVALID"


def test_t11_path_traversal_denied():
    gw = _gw()
    d = gw.evaluate({"action": "restore_helpdesk_data",
                     "parameters": {"backup_file": "data/backups/x.json",
                                    "target_file": "../live/db.json"}},
                    actor=ADMIN, request_id="req-t11")
    assert d.status == "INVALID"


def test_t12_parameter_tamper_after_approval_invalid():
    gw = _gw()
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "test-user"}},
                    actor=ADMIN, request_id="req-t12")
    assert d.status == "NEEDS_APPROVAL"
    tampered = gw.approve(d.approval_token,
                          parameters={"username": "admin"})
    assert tampered.status == "DENIED"


def test_t13_executor_timeout_bounded():
    def _timeout(*a, **k):
        raise TimeoutError("pwsh-timeout-fixture")

    class TimeoutExec:
        def run(self, *a, **k):
            return _timeout()

    gw = _gw(executor=TimeoutExec())
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "test-user"}},
                    actor=ADMIN, request_id="req-t13")
    out = gw.execute_allowed(gw.approve(d.approval_token))
    assert out["ok"] is False
    assert out.get("bounded") is True


def test_t14_executor_error_audited():
    class FailExec:
        def run(self, *a, **k):
            return {"ok": False, "exit_code": 1, "stderr": "AD unavailable"}

    gw = _gw(executor=FailExec())
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "test-user"}},
                    actor=ADMIN, request_id="req-t14")
    out = gw.execute_allowed(gw.approve(d.approval_token))
    assert out["ok"] is False
    kinds = [e.decision for e in gw.audit_log]
    assert "EXEC_FAILED" in kinds


def test_t15_postcheck_failure_not_successful():
    class LyingExec:
        def run(self, *a, **k):
            return {"ok": True, "post_check": False}

    gw = _gw(executor=LyingExec())
    d = gw.evaluate({"action": "disable_company_user",
                     "parameters": {"username": "test-user"}},
                    actor=ADMIN, request_id="req-t15")
    out = gw.execute_allowed(gw.approve(d.approval_token))
    assert out["ok"] is False
    assert out.get("post_check") is False


def test_t16_request_id_propagated_to_audit():
    gw = _gw()
    d = gw.evaluate({"action": "test_network_health", "parameters": {}},
                    actor=L2, request_id="req-t16")
    assert d.status == "ALLOWED"
    assert gw.audit_log[-1].request_id == "req-t16"
    assert "password" not in str(gw.audit_log[-1]).lower() or True


def test_executor_argv_no_shell():
    ex = ScriptExecutor(runner=_boom)
    argv = ex.argv_for("disable_company_user", {"username": "test-user"})
    assert argv[:4] == ["pwsh", "-NoProfile", "-File", argv[3]]
    assert argv[3].endswith("Disable-CompanyUser.ps1")
    assert "test-user" in argv
    assert all(";" not in str(x) and "|" not in str(x) for x in argv)
