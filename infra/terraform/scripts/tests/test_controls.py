#!/usr/bin/env python3
"""Controls for controls — every gate script must bite (ROADMAP contract 11).

Each mutation below applies exactly one defect and asserts that:
  (a) the control exits non-zero, and
  (b) the intended check fails *for the intended reason* (stable check id).

Run: cd infra/terraform/scripts && python3 -m unittest discover -s tests -v
Requires only the Python standard library.
"""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
sys.path.insert(0, SCRIPTS_DIR.as_posix())

from check_plan_invariants import run_checks  # noqa: E402

REPO_ROOT = SCRIPTS_DIR
while not (REPO_ROOT / "infra" / "main.bicep").exists():
    REPO_ROOT = REPO_ROOT.parent
    if REPO_ROOT == REPO_ROOT.parent:
        raise RuntimeError("repo root not found")

FIXTURE_OK = SCRIPTS_DIR.parent / "fixtures" / "plan-ok.json"


def load_ok_plan() -> dict:
    return copy.deepcopy(json.loads(FIXTURE_OK.read_text()))


def fail_ids(plan: dict, forbid: list | None = None) -> set[str]:
    return {r.check_id for r in run_checks(plan, forbid or []) if not r.ok}


def set_after(plan: dict, rtype: str, name: str, key: str, value) -> None:
    """Set change.after[key] = value on the resource change (rtype, name)."""
    hits = 0
    for change in plan.get("resource_changes", []):
        if change.get("type") == rtype and change.get("name") == name:
            change["change"]["after"][key] = value
            hits += 1
    assert hits == 1, f"expected exactly one {(rtype, name)}, got {hits}"


def set_actions(plan: dict, rtype: str, name: str, actions: list[str]) -> None:
    hits = 0
    for change in plan.get("resource_changes", []):
        if change.get("type") == rtype and change.get("name") == name:
            change["change"]["actions"] = actions
            hits += 1
    assert hits == 1, f"expected exactly one {(rtype, name)}, got {hits}"


def set_nested(plan: dict, rtype: str, name: str, block: str, key: str, value) -> None:
    hits = 0
    for change in plan.get("resource_changes", []):
        if change.get("type") == rtype and change.get("name") == name:
            blocks = change["change"]["after"].get(block)
            assert blocks, f"no {block} block on {(rtype, name)}"
            blocks[0][key] = value
            hits += 1
    assert hits == 1, f"expected exactly one {(rtype, name)}, got {hits}"


class TestPlanInvariants(unittest.TestCase):
    def test_ok_fixture_passes_everything(self):
        failed = fail_ids(load_ok_plan())
        self.assertEqual(failed, set(), f"ok fixture must pass, failed: {failed}")
        self.assertEqual(len(run_checks(load_ok_plan(), [])), 13)

    def test_keyvault_purge_protection_bites(self):
        plan = load_ok_plan()
        set_after(plan, "azurerm_key_vault", "main", "purge_protection_enabled", False)
        self.assertIn("keyvault.purge-protection", fail_ids(plan))

    def test_keyvault_rbac_bites(self):
        plan = load_ok_plan()
        set_after(plan, "azurerm_key_vault", "main", "rbac_authorization_enabled", False)
        self.assertIn("keyvault.rbac-authorization", fail_ids(plan))

    def test_keyvault_retention_bites(self):
        plan = load_ok_plan()
        set_after(plan, "azurerm_key_vault", "main", "soft_delete_retention_days", 3)
        self.assertIn("keyvault.soft-delete-retention", fail_ids(plan))

    def test_keyvault_delete_bites(self):
        plan = load_ok_plan()
        set_actions(plan, "azurerm_key_vault", "main", ["delete"])
        self.assertIn("keyvault.no-delete", fail_ids(plan))

    def test_postgres_require_secure_transport_bites(self):
        plan = load_ok_plan()
        set_after(
            plan,
            "azurerm_postgresql_flexible_server_configuration",
            "require_secure_transport",
            "value",
            "OFF",
        )
        self.assertIn("postgres.require-secure-transport", fail_ids(plan))

    def test_postgres_delete_bites(self):
        plan = load_ok_plan()
        set_actions(plan, "azurerm_postgresql_flexible_server", "main", ["delete", "create"])
        self.assertIn("postgres.no-delete", fail_ids(plan))

    def test_servicebus_dedupe_bites(self):
        plan = load_ok_plan()
        set_after(plan, "azurerm_servicebus_queue", "automation_jobs", "requires_duplicate_detection", False)
        self.assertIn("servicebus.duplicate-detection", fail_ids(plan))

    def test_servicebus_dead_lettering_bites(self):
        plan = load_ok_plan()
        set_after(plan, "azurerm_servicebus_queue", "automation_jobs", "dead_lettering_on_message_expiration", False)
        self.assertIn("servicebus.dead-lettering", fail_ids(plan))

    def test_servicebus_unbounded_delivery_bites(self):
        plan = load_ok_plan()
        set_after(plan, "azurerm_servicebus_queue", "automation_jobs", "max_delivery_count", 99)
        self.assertIn("servicebus.bounded-delivery", fail_ids(plan))

    def test_container_app_plain_http_bites(self):
        plan = load_ok_plan()
        set_nested(plan, "azurerm_container_app", "main", "ingress", "allow_insecure_connections", True)
        self.assertIn("container-app.no-plain-http", fail_ids(plan))

    def test_container_app_identity_bites(self):
        plan = load_ok_plan()
        set_nested(plan, "azurerm_container_app", "main", "identity", "type", None)
        self.assertIn("container-app.system-identity", fail_ids(plan))

    def test_secret_bearing_output_name_bites(self):
        plan = load_ok_plan()
        plan["planned_values"]["root_module"]["outputs"]["postgres_admin_password"] = {
            "sensitive": True,
            "value": "NotARealPassword123!",
        }
        self.assertIn("outputs.no-secret-bearing-names", fail_ids(plan))

    def test_storage_account_key_value_bites(self):
        plan = load_ok_plan()
        plan["resource_changes"][0]["change"]["after"]["tags"] = {"note": "AccountKey=AAAAbbbbccccdddd"}
        self.assertIn("plan.no-secret-leak", fail_ids(plan))

    def test_sas_signature_value_bites(self):
        plan = load_ok_plan()
        plan["resource_changes"][1]["change"]["after"]["server_id_note"] = "https://example.blob.core.windows.net?sig=abcdefABCDEF123456"
        self.assertIn("plan.no-secret-leak", fail_ids(plan))

    def test_forbidden_value_bites(self):
        plan = load_ok_plan()
        needle = "S3cr3t-L0okup-V4lu3-x9"
        plan["resource_changes"][2]["change"]["after"]["value"] = needle
        self.assertIn("plan.no-secret-leak", fail_ids(plan, [needle]))
        self.assertNotIn("plan.no-secret-leak", fail_ids(plan))

    def test_missing_keyvault_is_fail_closed(self):
        plan = load_ok_plan()
        plan["resource_changes"] = [c for c in plan["resource_changes"] if c["type"] != "azurerm_key_vault"]
        self.assertIn("keyvault.purge-protection", fail_ids(plan))
        self.assertIn("keyvault.no-delete", fail_ids(plan))

    def test_malformed_plan_fails_usage(self):
        proc = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_plan_invariants.py"), "/definitely/not/a/plan.json"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2)

class TempRepo(unittest.TestCase):
    """Copies ONLY the files the controls read, so mutations are hermetic."""

    CONTROL_INPUTS = [
        "infra/main.bicep",
        "infra/bicepconfig.json",
        "infra/FROZEN.lock.json",
        "infra/parameters/dev.bicepparam",
        "infra/parameters/prod.bicepparam",
        "infra/modules/network/vnet.bicep",
        "infra/modules/observability/main.bicep",
        "infra/modules/keyvault/main.bicep",
        "infra/modules/database/postgres.bicep",
        "infra/modules/messaging/servicebus.bicep",
        "infra/modules/apps/portal.bicep",
        "infra/terraform/parity-manifest.json",
        "infra/terraform/variables.tf",
        "infra/terraform/main.tf",
    ]

    MODULE_MAIN_TFS = [
        "network",
        "keyvault",
        "database",
        "messaging",
        "observability",
        "apps",
    ]

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="helpdesk-controls-"))
        for rel in self.CONTROL_INPUTS:
            src = REPO_ROOT / rel
            dst = self.tmp / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
        for module in self.MODULE_MAIN_TFS:
            for leaf in ("main.tf", "variables.tf"):
                src = REPO_ROOT / "infra" / "terraform" / "modules" / module / leaf
                dst = self.tmp / "infra" / "terraform" / "modules" / module / leaf
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_script(self, name: str, *args: str):
        return subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / name), *args],
            capture_output=True,
            text=True,
            cwd=self.tmp,
        )

    def mutate(self, rel: str, old: str, new: str) -> None:
        path = self.tmp / rel
        src = path.read_text()
        assert old in src, f"anchor missing in {rel}: {old!r}"
        path.write_text(src.replace(old, new, 1))


class TestBicepFrozen(TempRepo):
    def test_frozen_tree_passes(self):
        proc = self.run_script("check_bicep_frozen.py")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_any_bicep_edit_breaks_the_freeze(self):
        self.mutate(
            "infra/modules/keyvault/main.bicep",
            "enablePurgeProtection: true",
            "enablePurgeProtection: false",
        )
        proc = self.run_script("check_bicep_frozen.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("CHANGED", proc.stdout)
        self.assertIn("infra/modules/keyvault/main.bicep", proc.stdout)

    def test_added_bicep_file_breaks_the_freeze(self):
        extra = self.tmp / "infra" / "modules" / "keyvault" / "rogue.bicep"
        extra.write_text("// planted by the control test\n")
        proc = self.run_script("check_bicep_frozen.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("ADDED", proc.stdout)

    def test_deleted_bicep_file_breaks_the_freeze(self):
        (self.tmp / "infra" / "parameters" / "dev.bicepparam").unlink()
        proc = self.run_script("check_bicep_frozen.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("MISSING", proc.stdout)

    def test_missing_lock_file_is_usage_error(self):
        (self.tmp / "infra" / "FROZEN.lock.json").unlink()
        proc = self.run_script("check_bicep_frozen.py")
        self.assertEqual(proc.returncode, 2)


class TestParity(TempRepo):
    def test_parity_tree_passes(self):
        proc = self.run_script("check_parity.py")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_dropped_terraform_guard_breaks_parity(self):
        self.mutate(
            "infra/terraform/modules/keyvault/main.tf",
            "purge_protection_enabled      = true",
            "purge_protection_enabled      = false",
        )
        proc = self.run_script("check_parity.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("purge-protection-on", proc.stdout)

    def test_silenced_output_breaks_parity(self):
        self.mutate(
            "infra/terraform/modules/database/main.tf",
            'value     = "ON"',
            'value     = "OFF"',
        )
        proc = self.run_script("check_parity.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("require-secure-transport-on", proc.stdout)

    def test_rogue_root_module_breaks_parity(self):
        rogue = self.tmp / "infra" / "terraform" / "main.tf"
        with rogue.open("a") as fh:
            fh.write('\nmodule "rogue" {\n  source = "./modules/network"\n}\n')
        proc = self.run_script("check_parity.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("terraform module inventory", proc.stdout)

    def test_unmarked_secret_variable_breaks_parity(self):
        self.mutate(
            "infra/terraform/variables.tf",
            'variable "postgres_admin_password" {',
            'variable "postgres_admin_passw0rd_renamed" {',
        )
        with (self.tmp / "infra" / "terraform" / "variables.tf").open("r+") as fh:
            pass
        self.mutate(
            "infra/terraform/variables.tf",
            "  sensitive   = true\n",
            "",
        )
        proc = self.run_script("check_parity.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("sensitive", proc.stdout)

    def test_removed_tf_resource_breaks_parity(self):
        main_tf = self.tmp / "infra" / "terraform" / "modules" / "messaging" / "main.tf"
        src = main_tf.read_text()
        start = src.index('resource "azurerm_servicebus_queue"')
        depth, end = 0, start
        for idx in range(start, len(src)):
            if src[idx] == "{":
                depth += 1
            elif src[idx] == "}":
                depth -= 1
                if depth == 0:
                    end = idx + 1
                    break
        main_tf.write_text(src[:start] + src[end:])
        proc = self.run_script("check_parity.py")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("queue", proc.stdout.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)


