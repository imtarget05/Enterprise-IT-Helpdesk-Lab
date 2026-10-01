# Recruiter Evidence — Enterprise IT Helpdesk Lab
Problem: phòng IT xử lý ticket/assets/licenses thủ công, không runbook tập trung, không AI hỗ trợ chẩn đoán.
Fix: Node Express `internal-portal/src/app.js` (~40 routes) + Flask Python port + llm-gateway proxy.
Evidence:
- `src/ai.js` — 3-tier LLM (OpenAI → LM Studio/Ollama → rule playbook), fail-soft luôn 200
- `POST /api/ai/log-analysis` (`src/ai.js:analyzeLogs` + test `api-log-analysis.test.js`) — FPT evidence: đếm lỗi, gom pattern, mask PII VN, gợi runbook, ghi audit (fix cả false-positive "567 trong SĐT ≠ HTTP 5xx")
- `src/rag.js` Qdrant RAG + `src/agent/` PLAN→ACT→OBSERVE, tool ghi qua approve-token
- `tickets/ticket-001..020.md` + `scenarios/factory/scenario-01..12.md` corpus thật
- `GET /metrics` cả 3 service, 4 jobs Prometheus, Grafana/SLO, `test/` 336/337 tests pass (2026-09-30 measured)
- `docs/01-lab-topology-vmware.md` … `11-minierp-integration.md` SOP lab thật
- **Live Azure Deployment:** Azure Container Apps (East Asia, `rg-portfolio-evidence`, `ca-helpdesk-portal`)
  - **FQDN:** `https://ca-helpdesk-portal.wittysand-b748274c.eastasia.azurecontainerapps.io`
  - **Revision:** `ca-helpdesk-portal--0000001` (pinned GHCR image digest: `sha256:d9eb0b9a25cb8d757c7c47b3d2aad4d667346f0761f43e27f87ba137d4f7fe77`)
  - **Verification:**
    - `GET /api/health` → `200 OK` (`status: "ok"`, `authMode: "lab"`, `seeded: true`, 6 assets, 6 tickets)
    - `POST /api/auth/login` → `200 OK` with Bearer token
    - `GET /api/tickets` + `GET /api/assets` → `200 OK` (role-authenticated)
    - `POST /api/ai/analyze` → `200 OK` with ITIL rule-based diagnosis and docs RAG
Demo:
- **Cloud:** `curl https://ca-helpdesk-portal.wittysand-b748274c.eastasia.azurecontainerapps.io/api/health`
- **Local:** `docker compose up` → POST ticket → `/api/ai/analyze` → agent đề xuất → approve → ticket đóng.
