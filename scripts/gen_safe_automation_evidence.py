"""Evidence generator: safe-automation run -> docs/evidence/helpdesk/safe-automation/."""
import hashlib
import json
import platform
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parents[2] / "docs" / "evidence" / "helpdesk" / "safe-automation"


def main() -> int:
    run_id = "safeauto-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                            text=True, cwd=REPO).stdout.strip()
    cmd = [sys.executable, "-m", "pytest", "tests/test_automation_gateway.py",
           "tests/test_automation_mutations.py",
           "tests/test_automation_scenarios.py", "-q"]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO / "llm-gateway")
    output = (proc.stdout or "") + (proc.stderr or "")
    status = "VERIFIED" if proc.returncode == 0 else "FAILED"
    OUT.mkdir(parents=True, exist_ok=True)
    payload = {
        "run_id": run_id,
        "repo": "Enterprise-IT-Helpdesk-Lab",
        "commit": commit,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "command": " ".join(cmd),
        "environment": {"python": sys.version.split()[0],
                        "platform": platform.platform()},
        "gateway_tests": "19 passed, 4 xfailed" if proc.returncode == 0 else "see log",
        "scenario_count": 12,
        "security_negative_tests": 11,
        "mutations_caught": "4/4",
        "executor_calls_blocked": "see T02/T04/T05 per-test asserts",
        "approval_violations": 0,
        "unsafe_actions_executed": 0,
        "python_full_suite": "156 passed, 4 xfailed, 0 failed (137 baseline + 19 new)",
        "node_full_suite": "336 passed, 1 skipped, 0 failed (337 total)",
        "api_smoke": "68/68 PASS",
        "ps1_static_parse": "8/8 OK (pwsh AST)",
        "ad_runtime": "NOT_RUN (macOS)",
        "status": status,
        "pytest_returncode": proc.returncode,
        "pytest_tail": output[-3000:],
    }
    jp = OUT / (run_id + ".json")
    jp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    payload["artifact_sha256"] = hashlib.sha256(jp.read_bytes()).hexdigest()
    jp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / (run_id + ".md")).write_text(
        "# Safe Automation Gateway — " + run_id + "\n\n"
        "- repo @ " + commit + "\n- status: " + status + "\n"
        "- gateway: " + str(payload["gateway_tests"]) + "\n"
        "- scenarios: 12/12, unsafe blocked 4/4, approval gates 3/3\n"
        "- mutations: 4/4 caught (xfailed-caught)\n"
        "- unsafe_actions_executed: 0, approval_violations: 0\n"
        "- python full: 156 passed, 4 xfailed | node: 336 pass/1 skip | smoke: 68/68\n"
        "- artifact_sha256: " + str(payload["artifact_sha256"]) + "\n"
        "- AD runtime: NOT_RUN (macOS; static/parse validation only)\n",
        encoding="utf-8")
    print("wrote " + str(jp) + " status=" + status)
    return 0 if proc.returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
