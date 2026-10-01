#!/usr/bin/env python3
"""Bicep ↔ Terraform parity control (Phase 1 gate: "per-repo Bicep↔Terraform parity").

The Bicep templates are frozen and remain the parity source of truth. This
control reads `parity-manifest.json` and proves, mechanically, that:

  1. every Azure resource type declared in Bicep still exists in Bicep;
  2. the Terraform module declares exactly the mapped set of `azurerm_*`
     resources — an added or removed resource fails the control instead of
     drifting silently;
  3. every invariant pair (Bicep token ↔ Terraform token) is present on both
     sides, so a security property cannot be dropped from one side only;
  4. the root composition wires the same module inventory;
  5. every root parameter/variable pair still exists on both sides;
  6. every secret-bearing Terraform variable is marked `sensitive`.

Usage
-----
    python3 check_parity.py [--repo-root .] [--manifest infra/terraform/parity-manifest.json]

Exit codes
----------
0  parity holds
1  a parity violation was found
2  usage error (manifest missing / malformed)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SECRETISH_VAR = re.compile(r"(password|passwd|secret|token|key|credential|connection_string|sas)", re.I)


class Parity:
    def __init__(self) -> None:
        self.checks = 0
        self.failures: list[str] = []

    def check(self, label: str, ok: bool, detail: str = "") -> None:
        self.checks += 1
        if ok:
            print(f"PASS  {label}")
        else:
            print(f"FAIL  {label}" + (f"\n        {detail}" if detail else ""))
            self.failures.append(f"{label}: {detail}")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def terraform_resource_types(module_dir: Path) -> set[str]:
    found: set[str] = set()
    for tf in sorted(module_dir.glob("*.tf")):
        found |= set(re.findall(r'^resource\s+"(azurerm_[a-z0-9_]+)"', read(tf), re.M))
    return found


def check_module(parity: Parity, repo: Path, module: dict) -> None:
    name = module["name"]
    bicep_path = repo / module["bicep"]
    tf_dir = (repo / module["terraform"]).parent

    if not bicep_path.exists():
        parity.check(f"[{name}] bicep source exists", False, f"missing {bicep_path}")
        return
    parity.check(f"[{name}] bicep source exists", True)

    bicep_src = read(bicep_path)
    for rtype in module.get("bicep_resource_types", []):
        parity.check(
            f"[{name}] bicep declares {rtype}",
            rtype in bicep_src,
            f"{rtype} not found in {module['bicep']}",
        )

    declared = set(module.get("terraform_resource_types", []))
    actual = terraform_resource_types(tf_dir)
    parity.check(
        f"[{name}] terraform resource set == manifest ({module['terraform']})",
        declared == actual,
        f"manifest-only: {sorted(declared - actual)} · code-only: {sorted(actual - declared)}",
    )

    tf_src = "\n".join(read(p) for p in sorted(tf_dir.glob("*.tf")))
    for invariant in module.get("invariants", []):
        iid = invariant["id"]
        parity.check(
            f"[{name}] invariant {iid} present in Bicep",
            re.search(invariant["bicep_regex"], bicep_src, re.M | re.S) is not None,
            f"/{invariant['bicep_regex']}/ not matched in {module['bicep']}",
        )
        parity.check(
            f"[{name}] invariant {iid} present in Terraform",
            re.search(invariant["terraform_regex"], tf_src, re.M | re.S) is not None,
            f"/{invariant['terraform_regex']}/ not matched in {module['terraform']}",
        )


def check_root(parity: Parity, repo: Path, root_spec: dict) -> None:
    bicep_root = repo / root_spec["bicep"]
    tf_root = repo / root_spec["terraform"]

    if not bicep_root.exists() or not tf_root.exists():
        parity.check("root: both entrypoints exist", False, f"{bicep_root} / {tf_root}")
        return
    parity.check("root: both entrypoints exist", True)

    bicep_src = read(bicep_root)
    tf_src = read(tf_root)

    for module_path in root_spec["bicep_module_paths"]:
        parity.check(
            f"root: bicep composes {module_path}",
            module_path in bicep_src,
            f"module reference '{module_path}' missing from {root_spec['bicep']}",
        )

    tf_module_names = set(re.findall(r'^module\s+"([a-z0-9_]+)"', tf_src, re.M))
    expected_modules = set(root_spec["terraform_modules"])
    parity.check(
        "root: terraform module inventory == manifest",
        tf_module_names == expected_modules,
        f"manifest-only: {sorted(expected_modules - tf_module_names)} · "
        f"code-only: {sorted(tf_module_names - expected_modules)}",
    )

    tf_vars_path = repo / root_spec["terraform_variables"]
    tf_vars_src = read(tf_vars_path)
    for pair in root_spec["parameter_pairs"]:
        parity.check(
            f"root: bicep param '{pair['bicep']}' declared",
            re.search(rf"^param\s+{re.escape(pair['bicep'])}\b", bicep_src, re.M) is not None,
            f"param {pair['bicep']} missing from {root_spec['bicep']}",
        )
        parity.check(
            f"root: terraform variable '{pair['terraform']}' declared",
            re.search(rf'^variable\s+"{re.escape(pair["terraform"])}"', tf_vars_src, re.M) is not None,
            f"variable {pair['terraform']} missing from {root_spec['terraform_variables']}",
        )


def check_secret_marking(parity: Parity, repo: Path, vars_rel: str) -> None:
    """Every secret-bearing variable must be marked `sensitive = true`."""
    src = read(repo / vars_rel)
    blocks = re.findall(r'variable\s+"([^"]+)"\s*\{(.*?)\n\}', src, re.S)
    secretish = [b for b in blocks if SECRETISH_VAR.search(b[0])]
    for name, body in secretish:
        parity.check(
            f'sensitive: variable "{name}" is marked sensitive',
            re.search(r"sensitive\s*=\s*true", body) is not None,
            f"{name} looks secret-bearing but is not marked sensitive in {vars_rel}",
        )
    parity.check(
        "sensitive: at least one secret-bearing variable was inspected",
        len(secretish) > 0,
        "no secret-bearing variable found — the control would not bite",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Bicep ↔ Terraform parity control")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument(
        "--manifest",
        default="infra/terraform/parity-manifest.json",
        help="manifest path, relative to --repo-root",
    )
    args = parser.parse_args()

    repo = Path(args.repo_root).resolve()
    manifest_path = repo / args.manifest
    if not manifest_path.exists():
        print(f"FAIL: manifest not found at {manifest_path}")
        return 2
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as exc:
        print(f"FAIL: manifest is not valid JSON: {exc}")
        return 2

    parity = Parity()
    check_root(parity, repo, manifest["root"])
    for module in manifest["modules"]:
        check_module(parity, repo, module)
    check_secret_marking(parity, repo, manifest["root"]["terraform_variables"])

    print(f"\nSummary: {parity.checks - len(parity.failures)}/{parity.checks} parity checks hold")
    if parity.failures:
        print("\nPARITY VIOLATED — Bicep and Terraform no longer describe the same platform:")
        for failure in parity.failures:
            print(f"  · {failure}")
        return 1
    print("Bicep ↔ Terraform parity holds.")
    return 0



if __name__ == "__main__":
    sys.exit(main())
