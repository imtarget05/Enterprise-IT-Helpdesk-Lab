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
]


def run_suite() -> tuple[int, int, str]:
    proc = subprocess.run(
        ["node", "--test", str(SUITE)],
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
    baseline_pass, baseline_fail, _ = run_suite()
    print(f"BASELINE  pass={baseline_pass} fail={baseline_fail}")
    if baseline_fail != 0:
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
            passed, failed, _ = run_suite()
            caught = failed > 0
            all_caught = all_caught and caught
            verdict = "CAUGHT" if caught else "SURVIVED <-- control is hollow"
            print(f"{tag}  {verdict}  pass={passed} fail={failed}  {description}")
        finally:
            path.write_text(original)
            assert path.read_bytes() == backup.read_bytes(), f"{rel} was not restored byte-for-byte"

    print()
    print("every mutation caught" if all_caught else "AT LEAST ONE MUTATION SURVIVED")
    return 0 if all_caught else 1


if __name__ == "__main__":
    raise SystemExit(main())