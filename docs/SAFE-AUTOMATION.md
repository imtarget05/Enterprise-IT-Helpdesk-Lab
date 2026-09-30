# Safe Automation Gateway — Architecture & Runtime Limitations

## Principle

**AI does not execute PowerShell directly.**

```text
AI / LLM
    ↓  structured proposal {"action", "parameters"}   (no command strings)
Safe Automation Gateway (llm-gateway/automation/)
    ↓  schema → forbidden-pattern check → RBAC → risk policy
    ↓  → human approval (HIGH_RISK) → parameter validation
deterministic executor (argv list, never shell=True)
    ↓
PowerShell script (static allowlisted path)
    ↓
post-check → audit event (X-Request-Id propagated)
```

The model can propose a typed business action; it cannot choose an
executable command or script path. Authorization, risk classification,
approval, parameter validation, execution and post-condition verification
remain deterministic application responsibilities.

## Key modules

| File | Responsibility |
|---|---|
| `llm-gateway/automation/models.py` | Proposal schema; raw-command fields (`command`, `powershell`, `script`, …) rejected as INVALID; unknown actions fail closed |
| `llm-gateway/automation/policy.py` | Risk map (READ_ONLY/LOW_RISK/HIGH_RISK), RBAC over the existing portal roles (`src/auth.js`), forbidden patterns (defense-in-depth), per-action parameter validation with path confinement |
| `llm-gateway/automation/gateway.py` | `evaluate()` → decision; approval tokens bound to action+parameters (tamper → DENIED); `execute_allowed()` with bounded failure + post-check; audit events |
| `llm-gateway/automation/executor.py` | action ID → `pwsh -NoProfile -File <allowlisted> <validated args>` argv; `shell=False`; script path never comes from AI/user |

Roles come from the real model (`internal-portal/src/auth.js`):
`IT_ADMIN`, `HELPDESK_L2` may propose automation; `HELPDESK_L1`,
`AUDITOR`, `VIEWER`, `INTEGRATION_MINIERP` and unauthenticated actors are
DENIED. Authorization ≠ approval: a HIGH_RISK action still requires a
human approval even for `IT_ADMIN`.

## Platform limitation (be exact in any claim)

Live Active Directory mutation requires Windows + the ActiveDirectory
module. Verification on macOS covers:

- gateway policy, RBAC, approval binding, parameter validation (Python tests)
- deterministic argv construction (no shell path exists)
- PowerShell AST parsing of all 8 scripts (`scripts/verify-ps1-syntax.sh`)
- test doubles for executor success/failure/timeout/post-check
- development restore drill with byte-identical verification
  (`docs/evidence/helpdesk/restore-drill/`)

It does NOT prove live AD mutation. `Disable/New-CompanyUser.ps1` AD
runtime paths remain **NOT_RUN** on this host.

## Reproduce

```bash
.venv-helpdesk/bin/python -m pytest llm-gateway/tests/ -q      # 71 passed, 4 xfailed (mutations caught)
.venv-helpdesk/bin/python scripts/gen_safe_automation_evidence.py
bash scripts/verify-ps1-syntax.sh scripts                      # 8/8 parse OK
```
