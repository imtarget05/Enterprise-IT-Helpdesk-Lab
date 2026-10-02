#!/usr/bin/env python3
"""Backend isolation + secretless-state probe for Enterprise-IT-Helpdesk-Lab.

WHY THIS FILE EXISTS: until Phase 2 this Terraform root had NO backend block at
all. That is worse than a wrong backend block, because `terraform init` SUCCEEDED
and wrote state to a laptop `.tfstate` that no other operator could read — a
silent failure, and one that every static check stayed green through.

Isolation has to be a CONTROL, not a habit, or the next refactor reintroduces
exactly this.

RULES
  S1  no client_secret / ARM_CLIENT_SECRET in the backend path
  S2  no storage account key or SAS token in any backend config
  S3  shared-key auth is not required: state is Entra/RBAC only
  S4  every environment's state key is distinct
  S5  this repo references NO other portfolio project's state resources
  S6  no cross-project state key appears in committed config
  S7  `use_oidc` is NOT hardcoded — a static value forces the GitHub Actions
      OIDC path (ACTIONS_ID_TOKEN_REQUEST_TOKEN) and breaks a local `az login`
      init. CI supplies ARM_* instead.
  S8  backend config is PARTIAL and a missing backend.hcl makes `terraform init`
      FAIL rather than silently fall back to local state. Proved by running the
      init harness, not by grepping for the word "backend".

Usage: python3 tests/probe_backend_isolation.py
Exit:  0 = clean AND every rule bit for its intended reason.
        1 = a violation, or a rule that failed to bite.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]        # repo root
TF_ROOT = Path(__file__).resolve().parents[1]     # infra/terraform

# S5/S6: state resources belonging to OTHER portfolio projects. This repo must
# never read or write them. Its OWN resources are deliberately absent from this
# list — naming itself here would make every backend.hcl a violation.
FORBIDDEN_PORTFOLIO_RESOURCES = (
    "rg-maia-tfstate",
    "sttfmaia",
    "maia-github-oidc",
    "rg-aks-tfstate",
    "stakssre",
    "rg-factory-tfstate",
    "stfactorystate",
    # historical cross-repo coupling this probe exists to prevent
    "rg-flashsale-tfstate",
    "stflashs3ctfbk01",
)

# S1/S2: forbidden in the backend path only. Comments may name them — versions.tf
# deliberately names stflashs3ctfbk01 to explain why it was removed — so the
# scan covers executable/config lines, the same rule MAIA's probe uses.
SECRET_PATTERNS = (
    (re.compile(r"ARM_CLIENT_SECRET", re.I), "S1 ARM_CLIENT_SECRET"),
    (re.compile(r"\bclient_secret\b", re.I), "S1 client_secret"),
    (re.compile(r"\baccount_key\b", re.I), "S2 account_key"),
    (re.compile(r"\bsas_token\b", re.I), "S2 sas_token"),
)

RED = "\033[31m" if sys.stdout.isatty() else ""
OFF = "\033[0m" if sys.stdout.isatty() else ""

SCAN_GLOBS = ("infra/terraform/*.tf", "infra/terraform/**/*.hcl")


def backend_files() -> list[Path]:
    return sorted(TF_ROOT.glob("environments/*/backend.hcl"))


def scanned_files() -> list[Path]:
    out: set[Path] = set()
    for pattern in SCAN_GLOBS:
        out.update(ROOT.glob(pattern))
    return sorted(out)


def config_lines(path: Path) -> list[tuple[int, str]]:
    """Non-comment lines. A commented-out reference is not a credential."""
    result = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = raw.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        result.append((lineno, raw))
    return result


def scan() -> list[str]:
    findings: list[str] = []

    # --- S1/S2: no credential material in the backend path -----------------
    for path in scanned_files():
        for lineno, raw in config_lines(path):
            for pattern, rule in SECRET_PATTERNS:
                if pattern.search(raw):
                    findings.append(f"{rule} at {path.relative_to(ROOT)}:{lineno}")

    # --- S3: Entra auth required, per environment --------------------------
    backends = backend_files()
    if not backends:
        findings.append("S3 no environments/*/backend.hcl — remote state is unconfigured")
    for path in backends:
        if "use_azuread_auth" not in path.read_text(encoding="utf-8"):
            findings.append(f"S3 {path.relative_to(ROOT)} does not set use_azuread_auth")

    # --- S4: distinct state keys per environment ---------------------------
    owners: dict[str, str] = {}
    for path in backends:
        match = re.search(r'^\s*key\s*=\s*"([^"]+)"', path.read_text(encoding="utf-8"), re.M)
        if not match:
            findings.append(f"S4 {path.relative_to(ROOT)} has no key attribute")
            continue
        key = match.group(1)
        if key in owners:
            findings.append(
                f"S4 state key '{key}' is shared by {path.relative_to(ROOT)} and "
                f"{owners[key]}; environments must not share a state file"
            )
        owners[key] = str(path.relative_to(ROOT))

    # --- S5/S6: no other project's state resources -------------------------
    for path in scanned_files():
        for lineno, raw in config_lines(path):
            for forbidden in FORBIDDEN_PORTFOLIO_RESOURCES:
                if forbidden in raw:
                    findings.append(
                        f"S5 {path.relative_to(ROOT)}:{lineno} references "
                        f"'{forbidden}', which belongs to another project"
                    )

    # --- S7: use_oidc must not be hardcoded --------------------------------
    for path in scanned_files():
        for lineno, raw in config_lines(path):
            if re.match(r"use_oidc\s*=", raw.strip()):
                findings.append(
                    f"S7 {path.relative_to(ROOT)}:{lineno} hardcodes use_oidc; this "
                    "forces the GitHub-only OIDC path and breaks a local az login init"
                )

    return findings


def init_harness() -> list[str]:
    """S8: prove a missing backend config FAILS init instead of using local state.

    WHY THIS IS NOT A GREP: the failure mode being prevented is silent. A
    half-configured backend can leave `terraform init` succeeding against local
    state, and then `terraform plan`/`apply` write state to a laptop that no
    other operator can read — with every other rule still green, because the
    rules describe committed files, not runtime behaviour.

    The harness runs init in a throwaway copy of the root with the backend config
    REMOVED, and requires it to exit non-zero. It never contacts Azure: the
    backend values point at a non-resolvable name, so a fallback to local state
    is exactly what a passing run would reveal.
    """
    import shutil
    import tempfile

    findings: list[str] = []
    if shutil.which("terraform") is None:
        return ["S8 control skipped: terraform is not installed, cannot prove fail-closed"]

    backend = TF_ROOT / "environments" / "validation" / "backend.hcl"
    if not backend.exists():
        return ["S8 control skipped: no backend.hcl to remove, nothing to prove"]

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "aks-foundation"
        shutil.copytree(
            TF_ROOT, work,
            ignore=shutil.ignore_patterns(".terraform", "*.tfstate*", "tests"),
        )
        # Remove the backend config entirely. Partial config means init now has
        # nothing to work with and MUST fail — that is the S8 property.
        for env in (work / "environments").glob("*/backend.hcl"):
            env.unlink()

        proc = subprocess.run(
            ["terraform", "init", "-no-color", "-input=false"],
            cwd=work, capture_output=True, text=True, check=False,
        )
        if proc.returncode == 0:
            findings.append(
                "S8 FAIL: terraform init SUCCEEDED with no backend config. A missing "
                "backend config must fail closed, not silently fall back to local state."
            )
        elif list(work.glob("*.tfstate")):
            findings.append("S8 FAIL: a local .tfstate was created by the failing init")

    return findings


def negative_controls() -> list[str]:
    """Every rule must bite. A rule that never fires is not a control.

    Each mutation is fed to the SAME predicate the real scan uses, so a rule
    that cannot detect its own defect is caught here rather than in production.
    """
    failures: list[str] = []

    cases = (
        ("export ARM_CLIENT_SECRET=abc", "S1"),
        ('resource "azurerm_x" "y" { client_secret = "abc" }', "S1"),
        ('account_key = "abc"', "S2"),
        ('sas_token = "sv=2021"', "S2"),
    )
    for text, expected in cases:
        fired = [rule for pattern, rule in SECRET_PATTERNS if pattern.search(text)]
        if not fired:
            failures.append(f"{expected} did not fire on {text!r}")
        elif not any(f.startswith(expected) for f in fired):
            failures.append(f"{expected} fired for the wrong reason on {text!r}: {fired}")

    # A COMMENTED mention must not trip S1/S2 — versions.tf names the removed
    # storage account on purpose to explain the removal, and a probe that
    # forbade that would push the explanation out of the file and the coupling
    # back in undocumented.
    for text in ("# account_key = removed on purpose", "// client_secret = never"):
        filtered = config_lines_for(text)
        for pattern, rule in SECRET_PATTERNS:
            if any(pattern.search(raw) for _, raw in filtered):
                failures.append(f"{rule} fired on a comment: {text!r}")

    # S5: the forbidden-resource list must catch a violation. Exercised through
    # the real scanner predicate, on a temp file so nothing in the repo changes.
    failures.extend(_s5_control())

    # S4: a duplicated key must be reported by the real key-extraction logic.
    if not duplicate_key_detected():
        failures.append("S4 control: a duplicated state key was not detected")

    # S7: a hardcoded use_oidc must be reported.
    if not re.match(r"use_oidc\s*=", "use_oidc = true"):
        failures.append("S7 control: the use_oidc mutation was not detected")

    return failures


def _s5_control() -> list[str]:
    """Write a violating backend.hcl to a temp dir and prove S5 reports it."""
    import tempfile

    failures: list[str] = []
    for forbidden in FORBIDDEN_PORTFOLIO_RESOURCES:
        with tempfile.NamedTemporaryFile("w", suffix=".hcl", delete=False) as fh:
            fh.write('resource_group_name  = "rg-helpdesk-tfstate"\n')
            fh.write(f'storage_account_name = "{forbidden}"\n')
            fh.write("use_azuread_auth = true\n")
            tmp = Path(fh.name)
        try:
            hits = [
                f
                for _, raw in config_lines(tmp)
                for f in FORBIDDEN_PORTFOLIO_RESOURCES
                if f in raw
            ]
            if forbidden not in hits:
                failures.append(f"S5 control: '{forbidden}' was not detected")
        finally:
            tmp.unlink(missing_ok=True)
    return failures


def config_lines_for(text: str) -> list[tuple[int, str]]:
    """Apply the SAME comment filter the scanner uses, to a single line."""
    stripped = text.strip()
    if stripped.startswith("#") or stripped.startswith("//"):
        return []
    return [(1, text)]


def duplicate_key_detected() -> bool:
    """Two backends sharing a key must be reported by the same logic as S4."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        owners: dict[str, str] = {}
        for env in ("dev", "validation"):
            path = Path(tmp) / env / "backend.hcl"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('key = "shared.terraform.tfstate"\nuse_azuread_auth = true\n')
        for path in sorted(Path(tmp).glob("*/backend.hcl")):
            match = re.search(r'^\s*key\s*=\s*"([^"]+)"', path.read_text(), re.M)
            if not match:
                continue
            key = match.group(1)
            if key in owners:
                return True
            owners[key] = str(path)
    return False


def main() -> int:
    findings = scan() + init_harness()
    if findings:
        for f in findings:
            print(f"{RED}FAIL{OFF} {f}")
        print(f"\nSummary: 0 passed, {len(findings)} failed")
        return 1
    print(
        "PASS backend isolation probe "
        f"({len(scanned_files())} files, {len(backend_files())} backend configs, "
        "S8 init harness passed)"
    )
    if negative_controls():
        for f in negative_controls():
            print(f"{RED}FAIL{OFF} negative control: {f}")
        print("\nSummary: 0 passed, 1 failed")
        return 1
    print("PASS negative controls (every rule bit for its intended reason)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())