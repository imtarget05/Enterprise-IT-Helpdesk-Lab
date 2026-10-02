#!/usr/bin/env python3
"""Mutation evidence for the tenant-isolation control.

Each mutation applies exactly ONE defect to the tenant enforcement and runs the
adversarial suite. A control that cannot fail is not a control, so each entry
must produce at least one failure. Every file is restored afterwards and the
restoration is verified byte-for-byte.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PORTAL = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
SUITE = PORTAL / "test" / "tenant-isolation.test.js"
# The agent-tool scoping (M7/M8) lives in a different suite; running both under
# every mutation means a control is credited only when it actually bites.
SUITES = [
    SUITE,
    PORTAL / "test" / "agent-runtime.test.js",
    PORTAL / "test" / "lifecycle-toctou.test.js",
    PORTAL / "test" / "action-lifecycle.test.js",
    PORTAL / "test" / "automation-queue-worker.test.js",
    PORTAL / "test" / "automation-http.test.js",
]

MUTATIONS = [
    (
        "M1",
        "tenant filter removed from GET /api/tickets (list unscoped)",
        "src/enterprise-routes.js",
        "const rows = rowsVisibleTo(store.data.tickets, req.user).filter",
        "const rows = store.data.tickets.filter",
    ),
    (
        "M2",
        "tenant filter removed from the ticket CSV export",
        "src/app.js",
        "filterRows(rowsVisibleTo(store.data.tickets, req.user), req.query",
        "filterRows(store.data.tickets, req.query",
    ),
    (
        "M3",
        "session tenant taken from a request header/query instead of the session",
        "src/auth.js",
        "return { username: session.username, role: session.role, tenant: session.tenant };",
        "return { username: session.username, role: session.role, tenant: (req.headers && req.headers['x-tenant']) || session.tenant };",
    ),
    (
        "M4",
        "single-row tenant equality check removed (foreign row becomes readable)",
        "src/tenant-scope.js",
        "  if (tenantOfRow(row) !== normalizeTenant(user.tenant)) return { found: false, reason: 'absent' };",
        "",
    ),
    (
        "M5",
        "created rows no longer stamped with the caller tenant",
        "src/tenant-scope.js",
        "  return { ...row, tenant: normalizeTenant(user && user.tenant) };",
        "  return row;",
    ),
    (
        "M6",
        "AI agent route reads tenant from the request body again",
        "src/app.js",
        "        tenant: normalizeTenant(req.user.tenant),\n        requester: str(req.user.username),\n      });\n      res.json(result);",
        "        tenant: str(body.tenant) || 'default',\n        requester: str(req.user.username),\n      });\n      res.json(result);",
    ),
    (
        "M7",
        "agent's search_tickets reads the whole store again (side door around the HTTP filter)",
        "src/agent/tools.js",
        "        const rows = rowsVisibleTo(store.data.tickets || [], ctx && ctx.user ? ctx : null).filter((t) => {",
        "        const rows = (store.data.tickets || []).filter((t) => {",
    ),
    (
        "M8",
        "agent's requireTicket reads any ticket by id again",
        "src/agent/tools.js",
        "    const caller = ctx && ctx.user ? ctx : null;\n    const hit = findVisible(store.data.tickets || [], caller, id);",
        "    const hit = { found: true, row: store.find('tickets', id) };",
    ),
    (
        "M-L4",
        "enqueue's TOCTOU gate removed (a proposal edited after approval gets queued)",
        "src/action-lifecycle.js",
        "    if (!catalog.payloadHashMatches(proposal.payloadHash, proposal)) {\n      await audit({\n        proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,\n        event: 'DENIED', actor: 'system',\n        detail: { stage: 'toctou', reason: 'proposal payload no longer matches its recorded hash' },\n      });\n      return denied('PAYLOAD_MODIFIED', 'proposal payload changed after it was recorded');\n    }",
        "",
    ),
    (
        "M-L6",
        "worker trusts an unapproved queue message (approval check removed)",
        "src/action-lifecycle.js",
        "    if (catalog.requiresApproval(proposal.action)) {\n      const approval = await store.getApproval(proposalId);\n      if (!approval || approval.decision !== 'APPROVED') {\n        await audit({ ...base, event: 'DENIED', actor: workerId, detail: { stage: 'worker', reason: 'high-risk action delivered without an approved decision' } });\n        return { ok: false, status: 'POISON', executed: false, code: 'APPROVAL_REQUIRED' };\n      }",
        "    if (false) {\n      const approval = await store.getApproval(proposalId);\n      if (!approval || approval.decision !== 'APPROVED') {\n        await audit({ ...base, event: 'DENIED', actor: workerId, detail: { stage: 'worker', reason: 'high-risk action delivered without an approved decision' } });\n        return { ok: false, status: 'POISON', executed: false, code: 'APPROVAL_REQUIRED' };\n      }",
    ),
    (
        "M-L7",
        "worker stops verifying the catalog and trusts the stored action",
        "src/action-lifecycle.js",
        "    if (!catalog.isKnownAction(proposal.action)) {\n      await audit({ ...base, event: 'DENIED', actor: workerId, detail: { stage: 'worker', reason: 'action is not in the catalog' } });\n      return { ok: false, status: 'POISON', executed: false, code: 'UNKNOWN_ACTION' };\n    }",
        "",
    ),
    (
        "M-L8",
        "post-check ignored again (an unverified post-check reports SUCCEEDED)",
        "src/action-lifecycle.js",
        "    const postCheckOk = isPostCheckVerified(outcome);",
        "    const postCheckOk = true;",
    ),
    (
        "M-L9",
        "the retry budget is off by one in BOTH queue implementations",
        "src/automation-queue.js",
        "      const attempt = Number(message.attempt || 1);\n\n      if (attempt < maxAttempts && isTransient(error)) {\n        pending[idx] = { ...message, attempt: attempt + 1 };",
        "      const attempt = Number(message.attempt || 1) + 1;\n\n      if (attempt < maxAttempts && isTransient(error)) {\n        pending[idx] = { ...message, attempt };",
    ),
    (
        "M-L10",
        "the tenant agreement gate removed (an envelope may name another tenant)",
        "src/action-lifecycle.js",
        "    if (message.tenantId && String(message.tenantId) !== String(proposal.tenantId)) {\n      await audit({\n        ...base, event: 'DENIED', actor: workerId,\n        detail: { stage: 'worker', reason: 'envelope tenant does not match the proposal tenant' },\n      });\n      return { ok: false, status: 'POISON', executed: false, code: 'TENANT_MISMATCH' };\n    }",
        "",
    ),
    (
        "M-L11",
        "the worker trusts any tenant-bearing envelope (missing-tenant check removed)",
        "src/automation-worker.js",
        "    if (!message.tenantId) {",
        "    if (false) {",
    ),
    (
        "M-L12",
        "ITSM problems list served unscoped again",
        "src/enterprise-routes.js",
        "  app.get('/api/problems', (req, res) => res.json(rowsVisibleTo(store.data.problems, req.user)));",
        "  app.get('/api/problems', (req, res) => res.json(store.data.problems));",
    ),
    (
        "M-L13",
        "ITSM changes list served unscoped again",
        "src/enterprise-routes.js",
        "  app.get('/api/changes', (req, res) => res.json(rowsVisibleTo(store.data.changes, req.user)));",
        "  app.get('/api/changes', (req, res) => res.json(store.data.changes));",
    ),
    (
        "M-L14",
        "ITSM change approval becomes cross-tenant again",
        "src/enterprise-routes.js",
        "try { const row = findForUser('changes', req.params.id, 'Change', req); row.approvalState = 'APPROVED';",
        "try { const row = find('changes', req.params.id, 'Change'); row.approvalState = 'APPROVED';",
    ),
]


def run_suite(suite: Path) -> tuple[int, int, str]:
    proc = subprocess.run(
        ["node", "--test", str(suite)],
        cwd=PORTAL, capture_output=True, text=True,
    )
    passed = failed = -1
    for line in proc.stdout.splitlines():
        if line.startswith("ℹ pass"):
            passed = int(line.split()[-1])
        elif line.startswith("ℹ fail"):
            failed = int(line.split()[-1])
    return passed, failed, proc.stdout


def main() -> int:
    total_pass = total_fail = 0
    for suite in SUITES:
        p, f, _ = run_suite(suite)
        total_pass += max(p, 0)
        total_fail += max(f, 0)
    print(f"BASELINE  pass={total_pass} fail={total_fail}  ({len(SUITES)} suites)")
    if total_fail != 0:
        print("FAIL: baseline is not green, mutation results would be meaningless")
        return 1

    all_caught = True
    for tag, description, rel, old, new in MUTATIONS:
        path = PORTAL / rel
        original = path.read_text()
        if old not in original:
            print(f"{tag}  ANCHOR-MISSING  {description}  ({rel})")
            all_caught = False
            continue
        backup = Path(tempfile.mkdtemp()) / path.name
        backup.write_text(original)
        try:
            path.write_text(original.replace(old, new, 1))
            failed = 0
            for suite in SUITES:
                _, f, _ = run_suite(suite)
                failed += max(f, 0)
            caught = failed > 0
            all_caught = all_caught and caught
            verdict = "CAUGHT" if caught else "SURVIVED <-- control is hollow"
            print(f"{tag}  {verdict}  fails={failed}  {description}")
        finally:
            path.write_text(original)
            assert path.read_bytes() == backup.read_bytes(), f"{rel} was not restored byte-for-byte"

    print()
    print("every mutation caught" if all_caught else "AT LEAST ONE MUTATION SURVIVED")
    return 0 if all_caught else 1


if __name__ == "__main__":
    raise SystemExit(main())