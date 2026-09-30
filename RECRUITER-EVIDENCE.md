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
Demo: `docker compose up` → POST ticket → `/api/ai/analyze` → agent đề xuất → approve → ticket đóng.
