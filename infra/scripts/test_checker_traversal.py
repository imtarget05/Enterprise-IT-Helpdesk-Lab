#!/usr/bin/env python3
"""Traversal contract tests for the Helpdesk ARM invariant checker.

These exist because an exit-code-only assertion is not enough. A walker can
"pass" by never entering the branch it claims to check, and the failure is silent:
every invariant still prints PASS on a template the walk barely read.

Every positive case below asserts that a SPECIFIC resource was discovered at a
SPECIFIC path, and every negative case asserts that a malformed shape fails CLOSED
rather than being skipped. The absence assertions (7c) are covered by cases H and
I, because those read the whole compiled tree and are exactly the check a
narrower walk would silently skip.

Run: python3 infra/scripts/test_checker_traversal.py <checker.py>
Exit 0 = every contract holds. Exit 1 = at least one does not.
"""
import copy
import json
import pathlib
import subprocess
import sys
import tempfile

CHECKER = sys.argv[1] if len(sys.argv) > 1 else str(
    pathlib.Path(__file__).resolve().parents[1] / "scripts" / "check_invariants.py")
TMPDIR = pathlib.Path(tempfile.mkdtemp())
TIMEOUT = 30  # a canonical ARM walk is milliseconds; minutes means a bug


def run(doc):
    with (TMPDIR / "t.json").open("w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    try:
        p = subprocess.run([sys.executable, CHECKER, str(TMPDIR / "t.json")],
                           capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, "TIMEOUT", True
    out = p.stdout + p.stderr
    return p.returncode, out, "Traceback" in out


def vault(name="v", purge=True, rbac=True):
    return {
        "type": "Microsoft.KeyVault/vaults",
        "apiVersion": "2023-07-01",
        "name": name,
        "properties": {"enablePurgeProtection": purge, "enableRbacAuthorization": rbac},
    }


def storage(name="s", public=None, https=True):
    return {
        "type": "Microsoft.Storage/storageAccounts",
        "apiVersion": "2023-05-01",
        "name": name,
        "properties": {"allowBlobPublicAccess": public, "supportsHttpsTrafficOnly": https},
    }


def redis(name="r", non_ssl=False):
    return {
        "type": "Microsoft.Cache/redis",
        "apiVersion": "2024-11-01",
        "name": name,
        "properties": {"enableNonSslPort": non_ssl},
    }


def servicebus(name="sb", local_auth=None):
    return {
        "type": "Microsoft.ServiceBus/namespaces",
        "apiVersion": "2022-10-01-preview",
        "name": name,
        "properties": {"disableLocalAuth": local_auth},
    }


def pg_firewall(start, end, name="fw"):
    return {
        "type": "Microsoft.DBforPostgreSQL/flexibleServers/firewallRules",
        "apiVersion": "2024-08-01",
        "name": name,
        "properties": {"startIP": start, "endIP": end},
    }


def pg_server(name="pg"):
    return {
        "type": "Microsoft.DBforPostgreSQL/flexibleServers",
        "apiVersion": "2024-08-01",
        "name": name,
        "properties": {"version": "16"},
    }


results = []


def check(name, cond, detail=""):
    results.append((name, cond, detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}"
          f"{'' if cond else '  <- ' + detail}")


# A complete, correct template. Every fixture below is a MUTATION of this one, so a
# case cannot pass because the fixture is trivially empty.
BASELINE = {
    "resources": [
        vault(),
        storage(public=False),
        redis(non_ssl=False),
        servicebus(local_auth=True),
        pg_server(),
        pg_firewall("0.0.0.0", "0.0.0.0"),
    ]
}
rc, out, tb = run(BASELINE)
check("A0 baseline template passes", rc == 0 and not tb, f"rc={rc} tb={tb} out={out[:400]!r}")

# --- A. plain LIST -----------------------------------------------------------
doc = copy.deepcopy(BASELINE)
doc["resources"] = [vault()]
rc, out, tb = run(doc)
# A single vault means the OTHER required types are absent, which is a FAIL by
# design. What is under test here is that the vault was found at all.
check("A1 LIST -> vault discovered", "enablePurgeProtection == True" in out,
      f"vault not observed: {out!r}")
# The path must be rooted at the document, not merely contain a bracket. A
# traversal that propagated a constant still satisfies a substring check while
# pointing at the wrong location.
check("A2 LIST -> JSON path propagated and rooted", "$.resources[0]" in out,
      f"LIST branch did not propagate a rooted JSON path: {out!r}")

# --- B. symbolic-name MAP ----------------------------------------------------
doc = {"resources": {"vaultSymbol": vault(), "storageSymbol": storage(public=False),
                     "redisSymbol": redis(non_ssl=False),
                     "servicebusSymbol": servicebus(local_auth=True),
                     "pgSymbol": pg_server(),
                     "fwSymbol": pg_firewall("0.0.0.0", "0.0.0.0")}}
rc, out, tb = run(doc)
check("B1 MAP -> full baseline passes", rc == 0 and not tb, f"rc={rc} tb={tb} out={out[:400]!r}")
check("B2 MAP -> symbolic key shown in output", "vaultSymbol" in out,
      "output never mentioned the symbolic key")
# The decisive case: a list-only walk over a MAP yields strings, skips every one
# and exits 0 having read nothing. This asserts the map was really traversed.
check("B3 MAP -> all four invariants observed",
      all(t in out for t in ("vaultSymbol", "storageSymbol", "redisSymbol", "servicebusSymbol")),
      f"one or more symbolic-keyed resources were skipped: {out!r}")

# --- C. nested deployment -> MAP -> resources -------------------------------
doc = {"resources": [
    {
        "type": "Microsoft.Resources/deployments",
        "name": "nested",
        "properties": {
            "template": {
                "languageVersion": "2.0",
                "resources": {
                    "deepVault": vault(),
                    "deepStorage": storage(public=False),
                    "deepRedis": redis(non_ssl=False),
                    "deepServicebus": servicebus(local_auth=True),
                    "deepPg": pg_server(),
                    "deepFw": pg_firewall("0.0.0.0", "0.0.0.0"),
                },
            }
        },
    }
]}
rc, out, tb = run(doc)
check("C1 nested MAP -> baseline passes", rc == 0 and not tb,
      f"rc={rc} tb={tb} out={out[:400]!r}")
check("C2 nested MAP -> deep vault ACTUALLY observed", "deepVault" in out,
      "checker skipped the nested symbolic-name map entirely")
# C2 proves the symbolic key was reached, but not that it was reached BY A PATH.
check("C3 nested MAP -> full nested path propagated",
      "$.resources[0].properties.template.resources.deepVault" in out,
      f"nested path not propagated through the descent: {out!r}")

# --- C4. nested deployment -> LIST -> nested LIST ---------------------------
# The MAP and LIST branches build their own paths, so a defect fixed in one is
# invisible to a test exercising only the other.
doc = {"resources": [
    {
        "type": "Microsoft.Resources/deployments",
        "name": "nested",
        "properties": {
            "template": {
                "resources": [
                    {
                        "type": "Microsoft.Resources/deployments",
                        "name": "inner",
                        "properties": {"template": {"resources": [vault(), storage(public=False),
                                                                    redis(non_ssl=False),
                                                                    servicebus(local_auth=True),
                                                                    pg_server(),
                                                                    pg_firewall("0.0.0.0", "0.0.0.0")]}},
                    }
                ]
            }
        },
    }
]}
rc, out, tb = run(doc)
check("C4 nested LIST -> baseline passes", rc == 0 and not tb,
      f"rc={rc} tb={tb} out={out[:400]!r}")
check("C5 nested LIST -> full nested index path propagated",
      "$.resources[0].properties.template.resources[0]"
      ".properties.template.resources[0]" in out,
      f"nested list path not propagated through the descent: {out!r}")

# --- D. malformed entry ------------------------------------------------------
doc = {"resources": ["not-a-resource"]}
rc, out, tb = run(doc)
check("D1 malformed entry -> non-zero exit", rc not in (0, None), f"rc={rc}")
check("D2 malformed entry -> no traceback", not tb, "traceback leaked")
check("D3 malformed entry -> JSON path shown", "resources[0]" in out,
      "no JSON path in diagnostic")
check("D4 malformed entry -> path rooted at the document",
      "$." in out and "$.resources[0]" in out,
      f"path not rooted at the document: {out!r}")

# --- E. malformed container --------------------------------------------------
doc = {"resources": "not-a-container"}
rc, out, tb = run(doc)
check("E1 malformed container -> non-zero exit", rc not in (0, None), f"rc={rc}")
check("E2 malformed container -> no traceback", not tb, "traceback leaked")
check("E3 malformed container -> JSON path shown", "resources" in out,
      "no JSON path in diagnostic")

# --- F. every invariant still bites ------------------------------------------
# Each mutation is a single property flip on the baseline, so the only thing that
# can make it pass is the invariant under test.
for label, mutate in [
    ("F1 vault purgeProtection=false", lambda d: d["resources"][0]["properties"].__setitem__("enablePurgeProtection", False)),
    ("F2 vault rbacAuthorization=false", lambda d: d["resources"][0]["properties"].__setitem__("enableRbacAuthorization", False)),
    ("F3 storage allowBlobPublicAccess=true", lambda d: d["resources"][1]["properties"].__setitem__("allowBlobPublicAccess", True)),
    ("F4 storage httpsOnly=false", lambda d: d["resources"][1]["properties"].__setitem__("supportsHttpsTrafficOnly", False)),
    ("F5 redis nonSslPort=true", lambda d: d["resources"][2]["properties"].__setitem__("enableNonSslPort", True)),
    ("F6 servicebus localAuth=false", lambda d: d["resources"][3]["properties"].__setitem__("disableLocalAuth", False)),
]:
    doc = copy.deepcopy(BASELINE)
    mutate(doc)
    rc, out, tb = run(doc)
    check(f"{label} bites", rc not in (0, None) and not tb, f"rc={rc} out={out[:200]!r}")

# Absent property bites: a resource that does not state the property cannot be
# asserted to hold it.
doc = copy.deepcopy(BASELINE)
del doc["resources"][0]["properties"]["enablePurgeProtection"]
rc, out, tb = run(doc)
check("F7 absent property bites (never SKIP)", rc not in (0, None) and not tb, f"rc={rc}")

# A mis-serialised truthy string must not satisfy a boolean True.
doc = copy.deepcopy(BASELINE)
doc["resources"][0]["properties"]["enablePurgeProtection"] = "true"
rc, out, tb = run(doc)
check("F8 string \"true\" does not satisfy boolean True", rc not in (0, None) and not tb,
      f"rc={rc} out={out[:200]!r}")

# A required resource absent from the template is a FAILURE, not a skip.
doc = copy.deepcopy(BASELINE)
del doc["resources"][0]
rc, out, tb = run(doc)
check("F9 absent Key Vault bites (never SKIP)", rc not in (0, None) and not tb, f"rc={rc}")

# Computed (non-literal) properties cannot be statically verified, so that is a
# FAIL carrying the path rather than a crash.
doc = copy.deepcopy(BASELINE)
doc["resources"][0]["properties"] = "[variables('x')]"
rc, out, tb = run(doc)
check("F10 computed properties -> fail with path, no traceback",
      rc not in (0, None) and not tb and "resources[0]" in out, f"rc={rc} tb={tb}")

# --- G. PostgreSQL firewall --------------------------------------------------
# The documented trusted-services sentinel is accepted.
doc = copy.deepcopy(BASELINE)
doc["resources"][5] = pg_firewall("0.0.0.0", "0.0.0.0", name="sentinel")
rc, out, tb = run(doc)
check("G1 trusted-services sentinel accepted", rc == 0 and not tb, f"rc={rc} out={out[:200]!r}")

# Any real range bites.
for label, (start, end) in [
    ("G2 firewall 0.0.0.0-255.255.255.255 bites", ("0.0.0.0", "255.255.255.255")),
    ("G3 firewall public range 20.0.0.0-20.255.255.255 bites", ("20.0.0.0", "20.255.255.255")),
]:
    doc = copy.deepcopy(BASELINE)
    doc["resources"][5] = pg_firewall(start, end, name="wide")
    rc, out, tb = run(doc)
    check(label, rc not in (0, None) and not tb, f"rc={rc} out={out[:200]!r}")

# --- H. absence assertions actually run --------------------------------------
# A self-hosted vector store would compile as a container app, not as a managed
# search service, so this is the check that catches it.
doc = copy.deepcopy(BASELINE)
doc["resources"].append({
    "type": "Microsoft.Search/searchServices",
    "apiVersion": "2023-11-01",
    "name": "helpdesk-index",
    "properties": {},
})
rc, out, tb = run(doc)
check("H1 Azure AI Search resource bites", rc not in (0, None) and not tb, f"rc={rc}")

doc = copy.deepcopy(BASELINE)
doc["resources"].append({
    "type": "Microsoft.CognitiveServices/accounts",
    "apiVersion": "2023-05-01",
    "name": "helpdesk-embeddings",
    "properties": {},
})
rc, out, tb = run(doc)
check("H2 Cognitive Services account bites", rc not in (0, None) and not tb, f"rc={rc}")

# A qdrant reference inside any resource bites, whichever provider it arrived as.
doc = copy.deepcopy(BASELINE)
doc["resources"].append({
    "type": "Microsoft.App/containerApps",
    "apiVersion": "2024-03-01",
    "name": "qdrant",
    "properties": {},
})
rc, out, tb = run(doc)
check("H3 self-hosted qdrant container bites", rc not in (0, None) and not tb, f"rc={rc}")

# --- I. the absence checks are not vacuously passing ------------------------
# If the walk stopped reading, "no Search resource" would be trivially true and
# the absence check would print PASS while covering nothing. This asserts the
# absence lines are actually emitted for a full baseline walk.
rc, out, tb = run(BASELINE)
check("I1 absence checks are emitted, not silently skipped",
      "no retrieval / vector component" in out and "no qdrant reference" in out,
      f"absence assertions did not run: {out!r}")

passed = sum(1 for _, c, _ in results if c)
print(f"\n{passed}/{len(results)} traversal contracts hold")
sys.exit(0 if passed == len(results) else 1)