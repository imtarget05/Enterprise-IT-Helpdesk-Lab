"""Deterministic executor: action ID -> known script argv. No shell."""
from __future__ import annotations

import subprocess
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"

ACTION_SCRIPT = {
    "disable_company_user": "Disable-CompanyUser.ps1",
    "new_company_user": "New-CompanyUser.ps1",
    "backup_helpdesk_data": "Backup-HelpdeskData.ps1",
    "restore_helpdesk_data": "Restore-HelpdeskData.ps1",
    "backup_ad_configuration": "Backup-ADConfiguration.ps1",
    "export_it_asset_audit": "Export-ITAssetAudit.ps1",
    "test_network_health": "Test-NetworkHealth.ps1",
    "test_print_scan_health": "Test-PrintScanHealth.ps1",
}

ACTION_ARGV = {
    "disable_company_user": lambda p: ["-SamAccountName", p["username"]],
    "new_company_user": lambda p: ["-CsvPath", p.get("csv_path", "")],
}


class ScriptExecutor:
    """Builds argv lists only. Never shell=True, never string concat."""

    def __init__(self, runner=None):
        self._runner = runner or subprocess.run
        self.calls: list = []

    def argv_for(self, action: str, params: dict) -> list:
        script = ACTION_SCRIPT.get(action)
        if not script:
            raise ValueError("unknown action: " + str(action)[:60])
        path = SCRIPTS_DIR / script
        argv = ["pwsh", "-NoProfile", "-File", str(path)]
        extra = ACTION_ARGV.get(action)
        if extra:
            argv.extend(extra(dict(params or {})))
        return argv

    def run(self, action: str, params: dict, request_id="",
            timeout_s=30) -> dict:
        argv = self.argv_for(action, params)
        self.calls.append({"action": action, "argv": argv,
                           "request_id": request_id})
        proc = self._runner(argv, capture_output=True, text=True,
                            timeout=timeout_s, shell=False)
        return {"ok": proc.returncode == 0, "exit_code": proc.returncode,
                "stdout": (proc.stdout or "")[:2000],
                "stderr": (proc.stderr or "")[:2000],
                "argv": argv}
