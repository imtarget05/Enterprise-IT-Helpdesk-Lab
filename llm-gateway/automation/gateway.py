"""Gateway core: proposal -> decision -> approval -> execute -> audit."""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

ALLOWED = "ALLOWED"
NEEDS_APPROVAL = "NEEDS_APPROVAL"
DENIED = "DENIED"
INVALID = "INVALID"

from .models import validate_proposal
from .policy import (
    action_risk,
    authorize,
    is_forbidden_input,
    requires_approval,
    validate_parameters,
)


@dataclass
class GatewayDecision:
    status: str
    action: str = ""
    risk: str = ""
    requires_approval: bool = False
    reason: str = ""
    request_id: str = ""
    parameters: dict = field(default_factory=dict)
    approval_token: str = ""


@dataclass
class AuditEvent:
    timestamp: str
    request_id: str
    actor: str
    action: str
    risk: str
    decision: str
    approval_required: bool
    approval_state: str
    execution_attempted: bool
    execution_result: str


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class AutomationGateway:
    """Fail-closed gateway. No shell, no eval, no script_path from AI."""

    def __init__(self, executor=None, audit_sink=None, now=None):
        self._executor = executor
        self._audit_sink = audit_sink
        self._now = now or time.time
        self._pending: dict = {}
        self.audit_log: list = []

    def _audit(self, request_id, actor, action, risk, decision,
               approval_required, approval_state,
               attempted, result) -> None:
        name = ""
        if isinstance(actor, dict):
            name = str(actor.get("username", actor.get("role", "?")))
        event = AuditEvent(
            timestamp=_utcnow(), request_id=request_id, actor=name,
            action=action, risk=risk, decision=decision,
            approval_required=approval_required,
            approval_state=approval_state,
            execution_attempted=attempted, execution_result=result)
        self.audit_log.append(event)
        if self._audit_sink is not None:
            try:
                self._audit_sink(event)
            except Exception:
                pass

    def evaluate(self, proposal, actor=None, request_id=None) -> GatewayDecision:
        rid = request_id or ("req_" + uuid.uuid4().hex[:12])
        checked = validate_proposal(proposal or {})
        if not checked["ok"]:
            code = checked.get("code", "INVALID")
            status = DENIED if code == "UNKNOWN_ACTION" else INVALID
            self._audit(rid, actor, str((proposal or {}).get("action", "")),
                        "UNKNOWN", status, False, "none", False,
                        checked.get("error", ""))
            return GatewayDecision(status=status, reason=checked.get("error", ""),
                                   request_id=rid)
        action = checked["action"]
        raw_params = checked["parameters"]
        blob = json.dumps(raw_params, ensure_ascii=False)
        bad, why = is_forbidden_input(action + " " + blob)
        if bad:
            self._audit(rid, actor, action, "FORBIDDEN", DENIED,
                        False, "none", False, why)
            return GatewayDecision(status=DENIED, action=action,
                                   risk="FORBIDDEN", reason=why,
                                   request_id=rid)
        allowed, why_auth = authorize(actor, action)
        if not allowed:
            self._audit(rid, actor, action, action_risk(action), DENIED,
                        False, "none", False, why_auth)
            return GatewayDecision(status=DENIED, action=action,
                                   risk=action_risk(action), reason=why_auth,
                                   request_id=rid)
        ok, why_params, clean = validate_parameters(action, raw_params)
        if not ok:
            self._audit(rid, actor, action, action_risk(action), INVALID,
                        False, "none", False, why_params)
            return GatewayDecision(status=INVALID, action=action,
                                   risk=action_risk(action), reason=why_params,
                                   request_id=rid)
        risk = action_risk(action)
        if requires_approval(action):
            token = "appr_" + hashlib.sha256(
                (rid + action + json.dumps(clean, sort_keys=True)).encode()
            ).hexdigest()[:16]
            self._pending[token] = {"action": action, "parameters": clean,
                                    "request_id": rid,
                                    "actor": (actor or {}).get("username", "?"),
                                    "created_at": self._now(), "consumed": False}
            self._audit(rid, actor, action, risk, NEEDS_APPROVAL,
                        True, "pending", False, "awaiting approval")
            return GatewayDecision(status=NEEDS_APPROVAL, action=action,
                                   risk=risk, requires_approval=True,
                                   reason="HIGH_RISK needs approval",
                                   request_id=rid, parameters=clean,
                                   approval_token=token)
        self._audit(rid, actor, action, risk, ALLOWED,
                    False, "none", False, "auto-allowed " + risk)
        return GatewayDecision(status=ALLOWED, action=action, risk=risk,
                               reason="auto-allowed " + risk,
                               request_id=rid, parameters=clean)

    def approve(self, approval_token, parameters=None) -> GatewayDecision:
        entry = self._pending.get(approval_token or "")
        if not entry or entry.get("consumed"):
            return GatewayDecision(status=DENIED, reason="invalid approval token",
                                   request_id="")
        if parameters is not None:
            if dict(parameters) != dict(entry["parameters"]):
                entry["consumed"] = True
                self._audit(entry["request_id"], {"username": entry["actor"]},
                            entry["action"], action_risk(entry["action"]),
                            DENIED, True, "tampered", False,
                            "parameters changed after approval")
                return GatewayDecision(status=DENIED, action=entry["action"],
                                       risk=action_risk(entry["action"]),
                                       reason="approval invalidated: parameters changed",
                                       request_id=entry["request_id"])
        entry["consumed"] = True
        return GatewayDecision(status=ALLOWED, action=entry["action"],
                               risk=action_risk(entry["action"]),
                               reason="approved",
                               request_id=entry["request_id"],
                               parameters=dict(entry["parameters"]))

    def execute_allowed(self, decision, timeout_s=30) -> dict:
        if not isinstance(decision, GatewayDecision):
            return {"ok": False, "error": "not a gateway decision"}
        if decision.status != ALLOWED:
            return {"ok": False, "error": "decision is not ALLOWED: " + decision.status}
        if self._executor is None:
            return {"ok": False, "error": "no executor bound"}
        try:
            result = self._executor.run(decision.action, decision.parameters,
                                        request_id=decision.request_id,
                                        timeout_s=timeout_s)
        except Exception as exc:
            self._audit(decision.request_id, {}, decision.action,
                        decision.risk, "EXEC_FAILED", decision.requires_approval,
                        "approved", True, type(exc).__name__ + ": " + str(exc)[:200])
            return {"ok": False, "error": type(exc).__name__ + ": " + str(exc)[:200],
                    "bounded": True}
        ok = bool(result.get("ok"))
        post = result.get("post_check")
        if ok and post is False:
            self._audit(decision.request_id, {}, decision.action, decision.risk,
                        "POSTCHECK_FAILED", decision.requires_approval,
                        "approved", True, str(result)[:300])
            return {"ok": False, "error": "post-check failed",
                    "post_check": False, "audit": "POSTCHECK_FAILED"}
        self._audit(decision.request_id, {}, decision.action, decision.risk,
                    "EXECUTED" if ok else "EXEC_FAILED",
                    decision.requires_approval, "approved", True,
                    str(result)[:300])
        out = {"ok": ok}
        out.update(result)
        return out
