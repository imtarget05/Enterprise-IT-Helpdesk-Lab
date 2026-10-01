# Recruiter Evidence — Enterprise IT Helpdesk Lab
Problem: phòng IT xử lý ticket/assets/licenses thủ công, không runbook tập trung, không AI hỗ trợ chẩn đoán.
Fix: Node Express `internal-portal/src/app.js` (~40 routes) + Flask Python port + llm-gateway proxy.
Evidence:
- `src/ai.js` — 3-tier LLM (OpenAI → LM Studio/Ollama → rule playbook), fail-soft luôn 200
- `POST /api/ai/log-analysis` (`src/ai.js:analyzeLogs` + test `api-log-analysis.test.js`) — FPT evidence: đếm lỗi, gom pattern, mask PII VN, gợi runbook, ghi audit (fix cả false-positive "567 trong SĐT ≠ HTTP 5xx")
- `src/rag.js` Qdrant RAG + `src/agent/` PLAN→ACT→OBSERVE, tool ghi qua approve-token
- `tickets/ticket-001..020.md` + `scenarios/factory/scenario-01..12.md` corpus thật
- `GET /metrics` cả 3 service, 4 jobs Prometheus, Grafana/SLO; Node suite last recorded in the committed log `docs/testing/evidence/2026-09-28-node-suite.log` — `1..323` tests, **322 pass, 1 skipped, 0 fail**, run as `node --test test/*.test.js` (log records the package `enterprise-it-asset-portal@2.0.0`; the log stores no OS/CPU field, so the environment is "as recorded in that log"). Not re-run for this revision, so no current suite figure is claimed.
- `docs/01-lab-topology-vmware.md` … `11-minierp-integration.md` SOP lab thật
- **Live Azure Deployment:** Azure Container Apps (East Asia, `rg-portfolio-evidence`, `ca-helpdesk-portal`)
  - **FQDN:** `https://ca-helpdesk-portal.wittysand-b748274c.eastasia.azurecontainerapps.io`
  - **Revision:** `ca-helpdesk-portal--0000001` (pinned GHCR image digest: `sha256:d9eb0b9a25cb8d757c7c47b3d2aad4d667346f0761f43e27f87ba137d4f7fe77`)
  - **Committed probe artifact (reproducible, read-only GET, no credential sent):** `docs/evidence/azure/health-probe-2026-10-01.json` — `GET /api/health` → `200 OK` in 0.31s at `2026-10-01T19:47:00Z`, revision `ca-helpdesk-portal--0000001`, pod host `ca-helpdesk-portal--0000001-576cb78d77-pv2k5`, body recorded verbatim.
  - **Honest boundary — state this before you are asked:** the deployment is live and reachable, but `authMode` is `"lab"`, not production identity (no Entra ID / enterprise SSO), and `webhook` is `"mock"`, so notification delivery is stubbed and no external endpoint received anything. The live probe was health-only and sent no credential. The PowerShell / Active Directory paths remain **NOT_RUN** (`docs/SAFE-AUTOMATION.md:52-53`).
  - **Verification — against the live revision `ca-helpdesk-portal--0000001` (this is the complete list):**
    - `GET /api/health` → `200 OK` (`status: "ok"`, `authMode: "lab"`, `webhook: "mock"`, `seeded: true`, 6 assets, 6 tickets) — **VERIFIED** by the committed artifact `docs/evidence/azure/health-probe-2026-10-01.json`.
    - **No other live route is claimed.** That probe was health-only, sent no credential, and did not exercise any role-authenticated business route — the artifact says so in its own `what_this_does_not_prove`. So `POST /api/auth/login`, `GET /api/tickets`, `GET /api/assets` and `POST /api/ai/analyze` are **NOT VERIFIED against the live revision**. They are exercised locally only (`docker compose up`, see Demo below).
    - **Do not read the local result as a live one.** With `authMode: "lab"` and `webhook: "mock"`, a recruiter's own `curl` to `/api/tickets` on the live FQDN is not the role-authenticated request described above and is not evidence of anything beyond what the health artifact records. Any claim of live role-authenticated access needs a new committed artifact that actually sends the credential.
  - **Caveat that must not blur:** the Python automation gateway (`llm-gateway/automation/`) is proven by pytest only. It is **not wired to any HTTP route in the running portal**, and live AD mutation never ran. The live deployment correction above says nothing about the automation gateway having run in the cloud.
Demo:
- **Cloud:** `curl https://ca-helpdesk-portal.wittysand-b748274c.eastasia.azurecontainerapps.io/api/health` (committed artifact: `docs/evidence/azure/health-probe-2026-10-01.json`)
- **Local:** `docker compose up` → POST ticket → `/api/ai/analyze` → agent đề xuất → approve → ticket đóng.
