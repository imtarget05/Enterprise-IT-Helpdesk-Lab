#!/usr/bin/env python3
"""Plan-JSON invariant control (Phase 1 gate: "plan-JSON controls bite").

Reads a Terraform plan in `terraform show -json` format and asserts the
platform invariants *on what would actually be deployed* — this is the dynamic
half of the gate; `terraform test` (static half) proves the configuration and
this proves the rendered plan.

Checks (each has a stable id that unit tests assert on):

    keyvault.purge-protection       purge_protection_enabled == true
    keyvault.rbac-authorization     rbac_authorization_enabled == true
    keyvault.soft-delete-retention  soft_delete_retention_days >= 7
    keyvault.no-delete              the secret store is never destroyed by a plan
    postgres.require-secure-transport   require_secure_transport == "ON"
    postgres.no-delete              durable truth is never destroyed by a plan
    servicebus.duplicate-detection  requires_duplicate_detection == true
    servicebus.dead-lettering       dead_lettering_on_message_expiration == true
    servicebus.bounded-delivery     max_delivery_count is bounded (<= 10)
    container-app.no-plain-http     allow_insecure_connections == false
    container-app.system-identity   the portal runs as SystemAssigned
    outputs.no-secret-bearing-names no root output is named like a credential
    plan.no-secret-leak             no credential-shaped literal anywhere

A missing resource is a FAILURE, not a skip: if the plan does not mention the
resource at all, we cannot claim the invariant holds (fail closed).

Usage
-----
    terraform plan -out=tfplan
    terraform show -json tfplan > plan.json
    python3 check_plan_invariants.py plan.json [--forbid-value VALUE]...

    # control-proof fixture
    python3 check_plan_invariants.py fixtures/plan-ok.json

Exit codes
----------
0  every applicable invariant holds
1  at least one invariant failed
2  usage error (missing / malformed plan JSON)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# Credential-shaped literals that must never appear in an artifact we archive.
LEAK_PATTERNS: list[tuple[str, str]] = [
    ("storage-account-key", r"AccountKey=[A-Za-z0-9+/=]{8,}"),
    ("service-bus-sas-key", r"SharedAccessKey=[A-Za-z0-9+/=]{8,}"),
    ("sas-signature", r"[?&]sig=[A-Za-z0-9+/=]{16,}"),
    ("private-key-block", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("client-secret", r"client_secret\s*[=:]\s*[A-Za-z0-9._~+/=-]{8,}"),
]

SECRET_OUTPUT_NAME = re.compile(
    r"(password|passwd|secret|token|credential|connection_string|instrumentation|accountkey|sas_?key|private_?key)",
    re.I,
)

class Result:
    def __init__(self, check_id: str, ok: bool, detail: str = "") -> None:
        self.check_id = check_id
        self.ok = ok
        self.detail = detail


def walk_plan(node: Any, address: str = ""):
    """Yield (address, resource_dict) from planned_values root/child modules."""
    if isinstance(node, dict):
        for resource in node.get("resources", []) or []:
            res_address = resource.get("address", address)
            yield res_address, resource
        for child in node.get("child_modules", []) or []:
            yield from walk_plan(child, child.get("address", address))
    elif isinstance(node, list):
        for item in node:
            yield from walk_plan(item, address)


def index_by_type(plan: dict) -> dict[str, list[tuple[str, dict]]]:
    """Prefer resource_changes (has actions); fall back to planned_values."""
    index: dict[str, list[tuple[str, dict]]] = {}

    for change in plan.get("resource_changes") or []:
        rtype = change.get("type", "")
        after = (change.get("change") or {}).get("after")
        index.setdefault(rtype, []).append((change.get("address", ""), {"after": after, "actions": (change.get("change") or {}).get("actions", [])}))

    if index:
        return index

    for address, resource in walk_plan(plan.get("planned_values", {}).get("root_module", {})):
        rtype = resource.get("type", "")
        index.setdefault(rtype, []).append((address, {"after": resource.get("values"), "actions": []}))
    return index


def _first_after(entries: list[tuple[str, dict]], predicate) -> tuple[str, dict] | None:
    for address, entry in entries:
        after = entry.get("after")
        if isinstance(after, dict) and predicate(after):
            return address, entry
    return None


def collect_outputs(plan: dict) -> dict[str, Any]:
    """Root output names and values, from planned_values and/or output_changes."""
    outputs: dict[str, Any] = {}
    root = (plan.get("planned_values") or {}).get("root_module") or {}
    for name, body in (root.get("outputs") or {}).items():
        outputs[name] = body.get("value")
    for name, body in (plan.get("output_changes") or {}).items():
        outputs.setdefault(name, (body or {}).get("after"))
    return outputs


def scan_for_leaks(node: Any, forbid_values: list[str], path: str = "$") -> list[tuple[str, str]]:
    """Return (pattern_id, json-path) for every credential-shaped value.

    The value itself is never returned: the control must not become the place
    where the secret leaks into a log.
    """
    findings: list[tuple[str, str]] = []

    if isinstance(node, dict):
        for key, value in node.items():
            findings += scan_for_leaks(value, forbid_values, f"{path}.{key}")
    elif isinstance(node, list):
        for idx, value in enumerate(node):
            findings += scan_for_leaks(value, forbid_values, f"{path}[{idx}]")
    elif isinstance(node, str):
        for pattern_id, pattern in LEAK_PATTERNS:
            if re.search(pattern, node):
                findings.append((pattern_id, path))
        for forbidden in forbid_values:
            if forbidden and forbidden in node:
                findings.append(("forbidden-value", path))
    return findings


def run_checks(plan: dict, forbid_values: list[str]) -> list[Result]:
    results: list[Result] = []
    by_type = index_by_type(plan)

    # ---- key vault -------------------------------------------------------
    vault = _first_after(by_type.get("azurerm_key_vault", []), lambda a: True)
    if vault is None:
        for check_id in ("keyvault.purge-protection", "keyvault.rbac-authorization", "keyvault.soft-delete-retention", "keyvault.no-delete"):
            results.append(Result(check_id, False, "no azurerm_key_vault in plan"))
    else:
        address, entry = vault
        after = entry["after"]
        results.append(Result("keyvault.purge-protection", after.get("purge_protection_enabled") is True, f"{address}: purge_protection_enabled={after.get('purge_protection_enabled')!r}"))
        results.append(Result("keyvault.rbac-authorization", after.get("rbac_authorization_enabled") is True, f"{address}: rbac_authorization_enabled={after.get('rbac_authorization_enabled')!r}"))
        retention = after.get("soft_delete_retention_days")
        results.append(Result("keyvault.soft-delete-retention", isinstance(retention, int) and retention >= 7, f"{address}: soft_delete_retention_days={retention!r} (need >= 7)"))
        results.append(Result("keyvault.no-delete", "delete" not in (entry.get("actions") or []), f"{address}: actions={entry.get('actions')!r}"))

    # ---- postgres --------------------------------------------------------
    server = _first_after(by_type.get("azurerm_postgresql_flexible_server", []), lambda a: True)
    if server is None:
        results.append(Result("postgres.no-delete", False, "no azurerm_postgresql_flexible_server in plan"))
    else:
        address, entry = server
        results.append(Result("postgres.no-delete", "delete" not in (entry.get("actions") or []), f"{address}: actions={entry.get('actions')!r}"))

    secure_transport = _first_after(
        by_type.get("azurerm_postgresql_flexible_server_configuration", []),
        lambda a: a.get("name") == "require_secure_transport",
    )
    if secure_transport is None:
        results.append(Result("postgres.require-secure-transport", False, "require_secure_transport configuration not in plan"))
    else:
        address, entry = secure_transport
        value = entry["after"].get("value")
        results.append(Result("postgres.require-secure-transport", value == "ON", f"{address}: value={value!r} (need 'ON')"))

    # ---- service bus -----------------------------------------------------
    queue = _first_after(by_type.get("azurerm_servicebus_queue", []), lambda a: True)
    if queue is None:
        for check_id in ("servicebus.duplicate-detection", "servicebus.dead-lettering", "servicebus.bounded-delivery"):
            results.append(Result(check_id, False, "no azurerm_servicebus_queue in plan"))
    else:
        address, entry = queue
        after = entry["after"]
        results.append(Result("servicebus.duplicate-detection", after.get("requires_duplicate_detection") is True, f"{address}: requires_duplicate_detection={after.get('requires_duplicate_detection')!r}"))
        results.append(Result("servicebus.dead-lettering", after.get("dead_lettering_on_message_expiration") is True, f"{address}: dead_lettering_on_message_expiration={after.get('dead_lettering_on_message_expiration')!r}"))
        deliveries = after.get("max_delivery_count")
        results.append(Result("servicebus.bounded-delivery", isinstance(deliveries, int) and 0 < deliveries <= 10, f"{address}: max_delivery_count={deliveries!r} (need 1..10)"))

    # ---- container app ---------------------------------------------------
    app = _first_after(by_type.get("azurerm_container_app", []), lambda a: True)
    if app is None:
        for check_id in ("container-app.no-plain-http", "container-app.system-identity"):
            results.append(Result(check_id, False, "no azurerm_container_app in plan"))
    else:
        address, entry = app
        after = entry["after"]
        ingress_blocks = after.get("ingress") or []
        ingress = ingress_blocks[0] if ingress_blocks else {}
        results.append(Result("container-app.no-plain-http", ingress.get("allow_insecure_connections") is False, f"{address}: allow_insecure_connections={ingress.get('allow_insecure_connections')!r}"))
        identity_blocks = after.get("identity") or []
        identity = identity_blocks[0] if identity_blocks else {}
        results.append(Result("container-app.system-identity", identity.get("type") == "SystemAssigned", f"{address}: identity.type={identity.get('type')!r}"))

    # ---- outputs ---------------------------------------------------------
    outputs = collect_outputs(plan)
    if not outputs:
        results.append(Result("outputs.no-secret-bearing-names", False, "plan declares no root outputs at all"))
    else:
        bad_names = [name for name in sorted(outputs) if SECRET_OUTPUT_NAME.search(name)]
        if bad_names:
            for name in bad_names:
                results.append(Result("outputs.no-secret-bearing-names", False, f"root output '{name}' is named like credential material"))
        else:
            results.append(Result("outputs.no-secret-bearing-names", True, f"{len(outputs)} root outputs, none credential-shaped"))

    # ---- leak scan -------------------------------------------------------
    findings = scan_for_leaks(plan, forbid_values)
    for pattern_id, path in findings:
        results.append(Result("plan.no-secret-leak", False, f"{pattern_id} at {path} (value redacted) — do not archive this plan"))
    if not findings:
        results.append(Result("plan.no-secret-leak", True, "no credential-shaped literal in plan JSON"))

    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Terraform plan-JSON invariant control")
    parser.add_argument("plan", help="plan JSON produced by `terraform show -json`")
    parser.add_argument(
        "--forbid-value",
        action="append",
        default=[],
        help="secret that must not appear anywhere in the plan JSON (repeatable)",
    )
    args = parser.parse_args()

    plan_path = Path(args.plan)
    if not plan_path.exists():
        print(f"FAIL: plan file {plan_path} not found")
        return 2
    try:
        plan = json.loads(plan_path.read_text())
    except json.JSONDecodeError as exc:
        print(f"FAIL: {plan_path} is not valid JSON: {exc}")
        return 2
    if not isinstance(plan, dict) or ("resource_changes" not in plan and "planned_values" not in plan):
        print(f"FAIL: {plan_path} does not look like a Terraform plan JSON")
        return 2

    results = run_checks(plan, args.forbid_value)
    failures = [r for r in results if not r.ok]

    for result in results:
        print(f"{'PASS' if result.ok else 'FAIL'}  {result.check_id}" + ("" if result.ok else f"\n        {result.detail}"))

    print(f"\nSummary: {len(results) - len(failures)}/{len(results)} plan invariants hold")
    if failures:
        print("\nPLAN INVARIANTS VIOLATED — do not apply this plan:")
        for failure in failures:
            print(f"  · {failure.check_id}: {failure.detail}")
        return 1

    print("Plan invariants hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())


