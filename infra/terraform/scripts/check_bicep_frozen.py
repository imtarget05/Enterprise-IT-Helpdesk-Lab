#!/usr/bin/env python3
"""Freeze control for the Bicep templates (Phase 1 gate: "Bicep frozen").

Terraform is the canonical, deployable IaC language as of Phase 1. The Bicep
templates stay in the repository as the *parity source of truth* — they must
keep compiling — but they must no longer drift: any edit to a `.bicep`,
`.bicepparam` or `bicepconfig.json` file invalidates the frozen state and this
control fails with the exact file that changed.

Why a lock file instead of a comment that says "frozen": a comment is not a
control. A SHA-256 manifest is a control that bites — it is the only thing that
can tell a reviewer "this Bicep file changed after Phase 1".

Usage
-----
    python3 check_bicep_frozen.py                 # verify (CI + local gate)
    python3 check_bicep_frozen.py --write         # (re)generate the lock file
    python3 check_bicep_frozen.py --root infra --lock infra/FROZEN.lock.json

Exit codes
----------
0  every tracked Bicep file matches the frozen digest
1  a file changed, is missing, or was added while the freeze is in force
2  usage error (lock file missing while verifying)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

SUFFIXES = (".bicep", ".bicepparam")
EXTRA_FILES = ("bicepconfig.json",)
LOCK_RULE = (
    "Terraform under infra/terraform/ is the canonical IaC (Phase 1). These digests "
    "pin the Bicep parity source of truth; regenerate only with an explicit decision "
    "recorded in docs/adr/."
)


def iter_bicep_files(root: Path) -> list[Path]:
    found = [
        p
        for p in root.rglob("*")
        if p.is_file()
        and (p.suffix in SUFFIXES or p.name in EXTRA_FILES)
        and "/.terraform/" not in p.as_posix()
    ]
    return sorted(found)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_manifest(root: Path) -> dict:
    files = iter_bicep_files(root)
    if not files:
        raise SystemExit(f"no Bicep files found under {root}")
    return {
        "rule": LOCK_RULE,
        "root": root.as_posix(),
        "files": {p.relative_to(root.parent).as_posix(): digest(p) for p in files},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Bicep freeze control")
    parser.add_argument("--root", default="infra", help="directory holding the Bicep templates")
    parser.add_argument("--lock", default="infra/FROZEN.lock.json", help="lock file path")
    parser.add_argument("--write", action="store_true", help="(re)generate the lock file")
    args = parser.parse_args()

    root = Path(args.root)
    lock_path = Path(args.lock)

    if args.write:
        manifest = build_manifest(root)
        lock_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        print(f"WROTE {lock_path} ({len(manifest['files'])} files)")
        return 0

    if not lock_path.exists():
        print(f"FAIL: lock file {lock_path} is missing — run with --write and commit it")
        return 2

    try:
        frozen = json.loads(lock_path.read_text())
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive
        print(f"FAIL: {lock_path} is not valid JSON: {exc}")
        return 2

    expected: dict[str, str] = frozen.get("files", {})
    current = build_manifest(root)["files"]

    problems: list[str] = []
    for rel in sorted(expected):
        if rel not in current:
            problems.append(f"MISSING  {rel} (present in the lock, absent on disk)")
        elif current[rel] != expected[rel]:
            problems.append(
                f"CHANGED  {rel}\n           frozen   {expected[rel]}\n           on disk  {current[rel]}"
            )
    for rel in sorted(current):
        if rel not in expected:
            problems.append(f"ADDED    {rel} (not part of the frozen set)")

    unchanged = [rel for rel in sorted(expected) if rel in current and current[rel] == expected[rel]]
    for rel in unchanged:
        print(f"PASS  frozen  {rel}")

    print(f"\nSummary: {len(unchanged)} unchanged, {len(problems)} problem(s)")
    if problems:
        print("\nBICEP FREEZE VIOLATED — the canonical IaC is infra/terraform/.")
        print("If the Bicep change is intentional, record the reason in docs/adr/ and then regenerate:")
        print(f"  python3 {Path(__file__).name} --write\n")
        for problem in problems:
            print(f"  {problem}")
        return 1

    print("Bicep freeze holds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
