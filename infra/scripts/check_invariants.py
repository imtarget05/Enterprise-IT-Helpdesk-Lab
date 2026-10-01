#!/usr/bin/env python3
"""Assert the security invariants the Helpdesk stack actually claims.

WHY THIS EXISTS. `infra/validate.sh` compiles every template and runs the
parameter and negative tests, and all of that can be green while a security
property in a module is switched off. Compile checks the SHAPE of a template; it
says nothing about whether the values in it are safe. This is the check that
closes that gap.

WHY IT READS COMPILED JSON AND NOT THE .bicep SOURCE. Grepping the source for
`enablePurgeProtection: true` would pass just as happily on a line inside a
comment, inside a string, or on a resource the deployment never creates. The
compiled ARM template is what Azure actually receives, so asserting on it tests
the real artifact. It also means these invariants survive a refactor that moves a
resource into a different module or renames the file.

SCOPE, DELIBERATELY NARROW. This is not an Azure Policy engine and does not try
to be. It asserts exactly the properties the module comments in infra/modules/
claim as their security boundary. A property with no claim behind it does not
belong here, because an assertion nobody can justify is an assertion nobody
maintains.

WHAT IS ASSERTED, and why each one is claimed:
  Key Vault     purge protection on, RBAC authorization on. A vault with neither
                turns an accidental secret delete into an outage and carries a
                second authorisation system alongside the one RBAC role
                assignments assume.
  Storage       blob public access off, HTTPS-only on. A helpdesk ticket
                screenshot reachable by a guessed URL is a data breach, not a
                misconfiguration.
  Redis         non-SSL port off. The cache holds session tokens; cleartext Redis
                is those tokens on the wire.
  Service Bus   local auth disabled. An access-key connection to the automation
                pipeline is a shared static secret standing in for a managed
                identity.
  PostgreSQL    no firewall rule that opens the server to the internet. The
                0.0.0.0/0-to-0.0.0.0 trusted-services sentinel is the documented
                shape and is explicitly ALLOWED; a wider range is not.

WHAT IS DELIBERATELY ASSERTED AS ABSENT: any vector store, Qdrant, embedding
service or retrieval index. The Helpdesk target has no RAG component, and the
single most likely way this infrastructure acquires one by accident is by copying
a module in from the bootstrap source. A guard that only checks for the present
cannot catch that, so the absence is a first-class assertion.

EXIT CODES. 0 = every invariant held. 1 = at least one failed. A missing
resource is a FAILURE, never a skip: "the vault is not in the template" means the
guarantee cannot be checked, and reporting that as a pass is the exact failure
mode this script exists to prevent.
"""

from __future__ import annotations

import json
import sys
from typing import Any

GREEN = "\033[32m"
RED = "\033[31m"
BOLD = "\033[1m"
OFF = "\033[0m"

# (resource type, property path inside properties, expected value, why claimed)
INVARIANTS: list[tuple[str, str, Any, str]] = [
    (
        "Microsoft.KeyVault/vaults",
        "enablePurgeProtection",
        True,
        "An accidental `az keyvault secret delete` becomes a support ticket "
        "instead of an outage. Irreversible once enabled, which is why it is "
        "asserted rather than merely defaulted.",
    ),
    (
        "Microsoft.KeyVault/vaults",
        "enableRbacAuthorization",
        True,
        "RBAC only. The access-policy model is a second authorisation system "
        "that is off by default in a new vault and easy to leave enabled next "
        "to RBAC, which is how a 'no access' audit finding happens.",
    ),
    (
        "Microsoft.Storage/storageAccounts",
        "allowBlobPublicAccess",
        False,
        "An account that allows a container to serve anonymous GET makes a "
        "ticket attachment one guessed URL from world-readable.",
    ),
    (
        "Microsoft.Storage/storageAccounts",
        "supportsHttpsTrafficOnly",
        True,
        "Ticket attachments and backups travel over this endpoint. Plain HTTP to "
        "a blob store is a plaintext copy of the helpdesk's evidence files.",
    ),
    (
        "Microsoft.Cache/redis",
        "enableNonSslPort",
        False,
        "The cache holds session tokens and SLA dedup state. The non-SSL port "
        "is a cleartext listener for both.",
    ),
    (
        "Microsoft.ServiceBus/namespaces",
        "disableLocalAuth",
        True,
        "The automation pipeline is consumed with a managed identity "
        "(infra/modules/rbac). Local auth left on is a standing shared-access-key "
        "path around it.",
    ),
]

# Resource type PREFIXES that must not appear anywhere in the compiled template.
# The Helpdesk target has no retrieval-augmented component; these are the
# providers that would constitute one, plus the neighbouring stores that would
# only exist to serve it.
FORBIDDEN_TYPE_PREFIXES: list[tuple[str, str]] = [
    ("Microsoft.Search/", "Azure AI Search: a retrieval index with no place in a "
     "queue-and-row helpdesk automation pipeline."),
    ("Microsoft.CognitiveServices/", "An AI service account, which is how a "
     "vector store or embedding deployment would be introduced."),
    ("Microsoft.DBforMongoDB/", "MongoDB: only meaningful here as a vector or "
     "document store for ingestion."),
    ("Microsoft.DataFactory/", "A data pipeline, which is the machinery an "
     "ingestion path would be built on."),
]


class Unsupported(Exception):
    """A resource shape the walk refuses to guess about.

    Raised rather than skipped. A skipped shape means the checker did not read
    everything the template contains, so it cannot claim to have confirmed a
    security invariant. Carries the JSON path so the failure is actionable.
    """

    def __init__(self, path: str, expected: str, got: str):
        super().__init__(
            f"unsupported resource node at {path}: expected {expected}, got {got}")
        self.path = path


def _declared_symbols(template: dict[str, Any]) -> set:
    """Names a bare string in `resources` may legitimately refer to.

    Bicep serialises a module's variables, functions and outputs as symbolic
    names, so a string there is not automatically corruption -- but it must be a
    DECLARED name. An undeclared string is malformed.
    """
    names: set = set()
    if not isinstance(template, dict):
        return names
    for key in ("functions", "variables", "outputs", "imports"):
        value = template.get(key)
        if isinstance(value, dict):
            names.update(k for k in value if isinstance(k, str))
        elif isinstance(value, list):
            for entry in value:
                if isinstance(entry, str):
                    names.add(entry)
                elif isinstance(entry, dict):
                    for field in ("name", "symbolName"):
                        if isinstance(entry.get(field), str):
                            names.add(entry[field])
    return names


def iter_resources(template: dict[str, Any], depth: int = 0, path: str = "$"):
    """Yield (resource, json_path) for every resource in a compiled template.

    Bicep compiles a module block into a nested deployments resource whose payload
    sits under properties.template, and under languageVersion 2.0 that nested
    template's `resources` is a SYMBOLIC-NAME MAP rather than a list. Iterating a
    dict yields its KEYS, so a list-only walk saw strings, skipped every one, and
    reported success having read nothing.

    The path is first-class traversal data, not decoration: a PASS line has to be
    able to name the exact object it observed.
    """
    # WHY THE TEMPLATE ITSELF IS TYPE-CHECKED. A compiled ARM template is always
    # an object, so a non-dict here is a malformed or truncated artifact, not a
    # shape Bicep can produce. Calling .get() on it raised AttributeError, which
    # is the exact failure mode this checker exists to prevent: an invariant that
    # crashes reads as an infrastructure problem, gets treated as noise, and stops
    # being run. Returning un-walked makes the caller report "no vault found" -- a
    # controlled FAIL naming the path, not a traceback.
    if depth > 4 or not isinstance(template, dict):
        return
    resources = template.get("resources")
    if resources is None:
        return

    if isinstance(resources, dict):
        for key in resources:
            here = f"{path}.resources.{key}"
            value = resources[key]
            if not isinstance(value, dict):
                raise Unsupported(here, "object", type(value).__name__)
            yield value, here
            yield from _descend(value, depth, here)
    elif isinstance(resources, list):
        declared = _declared_symbols(template)
        for index, resource in enumerate(resources):
            here = f"{path}.resources[{index}]"
            if isinstance(resource, str):
                if resource in declared:
                    continue
                raise Unsupported(
                    here, "object, or a declared symbolic name", f"str {resource!r}")
            if not isinstance(resource, dict):
                raise Unsupported(here, "object", type(resource).__name__)
            yield resource, here
            yield from _descend(resource, depth, here)
    else:
        raise Unsupported(f"{path}.resources", "list or symbolic-name map",
                          type(resources).__name__)


def _descend(resource: dict[str, Any], depth: int, path: str):
    """Recurse into properties.template.

    `yield from` is required at every call site: invoking this generator without
    iterating it creates it and discards it, silently skipping the nested subtree.
    """
    properties = resource.get("properties")
    if isinstance(properties, dict):
        nested = properties.get("template")
        if isinstance(nested, dict):
            yield from iter_resources(
                nested, depth + 1, f"{path}.properties.template")


def by_type(template: dict[str, Any], type_prefix: str) -> list[tuple[dict[str, Any], str]]:
    """Every resource whose type starts with type_prefix, with its path.

    Used for the ABSENCE checks, where a prefix is right: any Azure AI Search
    resource, of any sub-type, is the thing being forbidden.
    """
    return [
        (resource, path)
        for resource, path in iter_resources(template)
        if isinstance(resource.get("type"), str)
        and resource["type"].startswith(type_prefix)
    ]


def by_exact_type(template: dict[str, Any], resource_type: str) -> list[tuple[dict[str, Any], str]]:
    """Every resource of EXACTLY resource_type, with its path.

    WHY EXACT, AND WHY THIS DISTINCTION IS THE WHOLE POINT OF THE FUNCTION: the
    property invariants below name a resource and a property ON THAT resource. A
    prefix match would also pull in that resource's children, which legitimately
    do not carry the parent's properties -- `Microsoft.Cache/redis` matches
    `Microsoft.Cache/redis/firewallRules`, `Microsoft.ServiceBus/namespaces`
    matches every queue and topic on the namespace, and
    `Microsoft.Storage/storageAccounts` matches the blobServices and container
    resources. Asserting `disableLocalAuth` on a queue fails against a correct
    template, and the fix that stops the noise -- relaxing the matcher or adding
    a skip for "children" -- is exactly how a real property flip on the parent
    stops being caught. So the matcher is exact and the absence checks keep the
    prefix.
    """
    return [
        (resource, path)
        for resource, path in iter_resources(template)
        if resource.get("type") == resource_type
    ]


def check_postgres_firewall(template: dict[str, Any]) -> list[str]:
    """Return failure lines for any PostgreSQL firewall rule wider than the
    trusted-services sentinel.

    WHY A SEPARATE CHECK: 0.0.0.0/0 to 0.0.0.0 is the documented way to allow
    Azure's trusted services through a Flexible Server firewall, and it is NOT an
    open range even though it reads like one. A blanket property assertion would
    either reject the legitimate sentinel or accept every range, so this rule is
    compared explicitly instead.
    """
    failures: list[str] = []
    for rule, rule_path in by_type(template, "Microsoft.DBforPostgreSQL/flexibleServers/firewallRules"):
        props = rule.get("properties")
        if not isinstance(props, dict):
            failures.append(
                f"{rule_path}: properties is not an object, so the firewall range "
                f"is not statically visible")
            continue
        start = props.get("startIP", props.get("startIpAddress"))
        end = props.get("endIP", props.get("endIpAddress"))
        if start == "0.0.0.0" and end == "0.0.0.0":
            continue  # the documented trusted-services sentinel
        failures.append(
            f"{rule_path}: firewall rule allows {start} to {end}. Only the "
            f"0.0.0.0-to-0.0.0.0 trusted-services sentinel is accepted; any other "
            f"range opens the durable helpdesk database to that many addresses.")
    return failures


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <compiled-template.json>", file=sys.stderr)
        return 2

    path = sys.argv[1]
    # WHY a missing file is reported rather than raised: this script is called
    # right after a compile, and "the compile produced no output" is a real
    # condition a caller has to be able to read. A traceback would exit non-zero
    # too, so the safety is the same, but it would bury the actual cause under a
    # stack trace in CI logs.
    try:
        with open(path, encoding="utf-8") as handle:
            template = json.load(handle)
    except FileNotFoundError:
        print(f"{RED}  FAIL{OFF}  compiled template not found: {path}")
        print("        The compile step should have produced this file.")
        return 1
    except json.JSONDecodeError as exc:
        print(f"{RED}  FAIL{OFF}  {path} is not valid JSON: {exc}")
        return 1

    try:
        observed = list(iter_resources(template))
    except Unsupported as exc:
        print(f"{RED}{BOLD}  FAIL{OFF}  invariant discovery: {exc}")
        print("        the walk refuses to guess about an unreadable structure, "
              "so no security invariant can be confirmed.")
        return 1

    failures = 0
    print(f"{BOLD}-- 7. security invariants on the compiled template{OFF}")
    print(f"        {path}")
    print(f"        {len(observed)} resource(s) discovered across the template tree")

    # --- 7a. property invariants -------------------------------------------
    # Resources that MUST be present for their invariants to be checkable. A
    # missing one is a failure, never a skip: the guarantee cannot be confirmed,
    # and calling that a pass is the failure mode this script exists to prevent.
    required = sorted({r[0] for r in INVARIANTS})
    for type_prefix in required:
        found = by_exact_type(template, type_prefix)
        label = type_prefix.rstrip("/").split("/")[-1]
        if not found:
            failures += 1
            print(f"{RED}  FAIL{OFF}  no {type_prefix} found in the template")
            print(f"        {label} is claimed by infra/modules/. If it was renamed, "
                  f"moved or removed, the security boundary changed and this check "
                  f"cannot confirm it.")
            continue
        for index, (resource, resource_path) in enumerate(found):
            name = resource.get("name", "<unnamed>")
            shown = (f"{resource_path}: {name}" if index == 0
                     else f"{resource_path}: {name} (resource {index})")
            props = resource.get("properties", {})
            # WHY THE PROPERTIES GUARD. A resource whose properties are COMPUTED
            # rather than literal serialises the whole bag as an ARM expression
            # string ("[variables('x')]"). That is a shape the compiler can
            # produce, unlike a non-dict template, so it must be handled rather
            # than assumed away. The correct verdict is that the security values
            # are not statically visible, so the invariant is UNVERIFIED.
            if not isinstance(props, dict):
                failures += 1
                print(f"{RED}  FAIL{OFF}  {shown}: properties is "
                      f"{type(props).__name__}, not an object; the security values "
                      f"are not statically visible and the invariant is unverified")
                continue
            for rtype, prop, expected, why in INVARIANTS:
                if not rtype.startswith(type_prefix):
                    continue
                actual = props.get(prop, "<absent>")
                # Value AND type, so a mis-serialised truthy "false" string cannot
                # satisfy a boolean True.
                if type(actual) is type(expected) and actual == expected:
                    print(f"{GREEN}  PASS{OFF}  {shown}: {prop} == {expected!r}")
                else:
                    failures += 1
                    print(f"{RED}  FAIL{OFF}  {shown}: {prop} is {actual!r}, "
                          f"expected {expected!r}")
                    print(f"        {why}")

    # --- 7b. PostgreSQL firewall -------------------------------------------
    for line in check_postgres_firewall(template):
        failures += 1
        print(f"{RED}  FAIL{OFF}  {line}")

    # --- 7c. absence of a retrieval component -------------------------------
    # NOT A SKIP. This asserts that a vector store, an AI service or an ingestion
    # pipeline is absent from the compiled template. The Helpdesk automation
    # pipeline is queue-driven and row-driven; a search index would have arrived
    # by being copied in from the bootstrap source, which is precisely the drift
    # this repository is set up to prevent.
    print(f"{BOLD}-- 7c. no retrieval / vector component{OFF}")
    for prefix, why in FORBIDDEN_TYPE_PREFIXES:
        found = by_type(template, prefix)
        if found:
            failures += 1
            for resource, resource_path in found:
                print(f"{RED}  FAIL{OFF}  {resource_path}: {prefix} resource "
                      f"'{resource.get('name', '<unnamed>')}' is present")
            print(f"        {why}")
        else:
            print(f"{GREEN}  PASS{OFF}  no {prefix} resources")

    # Qdrant is checked by NAME as well as by provider type, because a
    # self-hosted Qdrant container compiles as a Container App rather than as a
    # managed search service, so the provider-type check above cannot see it.
    qdrant_hits = [
        (resource, resource_path)
        for resource, resource_path in observed
        if "qdrant" in json.dumps(resource).lower()
    ]
    if qdrant_hits:
        failures += 1
        for resource, resource_path in qdrant_hits:
            print(f"{RED}  FAIL{OFF}  {resource_path}: mentions qdrant in its "
                  f"compiled form")
        print("        The Helpdesk target has no vector store. A self-hosted one "
              "would deploy as a container, not as a managed service, so the "
              "provider-type check above cannot see it.")
    else:
        print(f"{GREEN}  PASS{OFF}  no qdrant reference anywhere in the template")

    if failures:
        print(f"{RED}{BOLD}  {failures} invariant violation(s){OFF}")
        return 1

    print(f"{GREEN}  {len(INVARIANTS)} property invariant(s) held across "
          f"{len(observed)} resource(s); no retrieval component present{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())