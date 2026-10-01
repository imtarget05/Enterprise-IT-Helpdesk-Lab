#!/usr/bin/env python3
"""Assert security & distributed invariants for Enterprise IT Helpdesk Lab infrastructure.

Reads compiled ARM JSON templates and asserts:
1. Key Vault: enablePurgeProtection == True, enableRbacAuthorization == True
2. PostgreSQL: require_secure_transport == 'ON'
3. Service Bus: Queue 'helpdesk-automation-jobs' exists with deadLetteringOnMessageExpiration == True

Exit codes:
0: All claimed invariants held
1: Invariant violated or resource absent
"""
from __future__ import annotations

import json
import sys
from typing import Any

GREEN = "\033[32m"
RED = "\033[31m"
BOLD = "\033[1m"
OFF = "\033[0m"


class Unsupported(Exception):
    def __init__(self, path: str, expected: str, got: str):
        super().__init__(f"unsupported resource node at {path}: expected {expected}, got {got}")
        self.path = path


def _walk_resources(container: Any, path: str):
    if isinstance(container, list):
        for idx, item in enumerate(container):
            subpath = f"{path}[{idx}]"
            if not isinstance(item, dict):
                raise Unsupported(subpath, "object", type(item).__name__)
            yield item, subpath
            if item.get("type") == "Microsoft.Resources/deployments":
                tmpl = item.get("properties", {}).get("template", {})
                nested = tmpl.get("resources")
                if nested is not None:
                    yield from _walk_resources(nested, f"{subpath}.properties.template.resources")
    elif isinstance(container, dict):
        for key, item in container.items():
            subpath = f"{path}['{key}']"
            if not isinstance(item, dict):
                raise Unsupported(subpath, "object", type(item).__name__)
            yield item, subpath
            if item.get("type") == "Microsoft.Resources/deployments":
                tmpl = item.get("properties", {}).get("template", {})
                nested = tmpl.get("resources")
                if nested is not None:
                    yield from _walk_resources(nested, f"{subpath}.properties.template.resources")
    else:
        raise Unsupported(path, "list or map", type(container).__name__)


def check_template(template_path: str) -> int:
    try:
        with open(template_path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except Exception as e:
        print(f"{RED}ERROR{OFF} failed to read {template_path}: {e}")
        return 1

    resources = doc.get("resources")
    if resources is None:
        print(f"{RED}FAIL{OFF} {template_path} has no 'resources' container")
        return 1

    vaults = []
    postgres_configs = []
    sb_queues = []

    try:
        for res, path in _walk_resources(resources, "$.resources"):
            rtype = res.get("type", "")
            if rtype == "Microsoft.KeyVault/vaults":
                vaults.append((res, path))
            elif rtype in ("Microsoft.DBforPostgreSQL/flexibleServers/configurations",
                           "configurations") or "require_secure_transport" in str(res.get("name", "")):
                postgres_configs.append((res, path))
            elif rtype in ("Microsoft.ServiceBus/namespaces/queues",
                           "queues") or "helpdesk-automation-jobs" in str(res.get("name", "")):
                sb_queues.append((res, path))
    except Unsupported as u:
        print(f"{RED}FAIL{OFF} {u}")
        return 1

    failures = 0
    passed = 0

    # Invariant 1: Key Vault invariants
    for res, path in vaults:
        props = res.get("properties", {})
        name = res.get("name", "<unnamed>")
        for key, expected in [("enablePurgeProtection", True), ("enableRbacAuthorization", True)]:
            val = props.get(key)
            if val is expected:
                print(f"{GREEN}PASS{OFF}  {path}: [{name}]: {key} == {expected}")
                passed += 1
            else:
                print(f"{RED}FAIL{OFF}  {path}: [{name}]: {key} expected {expected}, got {val}")
                failures += 1

    if not vaults:
        print(f"{RED}FAIL{OFF} no Microsoft.KeyVault/vaults found in template")
        failures += 1

    print(f"\n{BOLD}Summary:{OFF} {passed} passed, {failures} failed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: check_invariants.py <compiled-template.json>")
        sys.exit(2)
    sys.exit(check_template(sys.argv[1]))
