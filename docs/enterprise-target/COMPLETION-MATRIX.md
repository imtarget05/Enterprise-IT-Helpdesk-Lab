# COMPLETION MATRIX — Enterprise-IT-Helpdesk-Lab

```text
derived_from : docs/enterprise-target/CURRENT-STATE.md
measured_at  : 2026-10-02
code_sha     : 00c9873  (branch helpdesk/core-runtime, rebased on origin/main 3ad2449)
              — the suites below were observed green at THIS sha; later commits
              in this branch touch docs only.
blocker      : none. Branch reconciled; original DIVERGENT blocker resolved.
               Concurrent writers observed (PR #3/#4) — see CURRENT-STATE §1.
```

## Status vocabulary

```text
VERIFIED_LIVE       measured on a live Azure runtime; evidence retained
VERIFIED_TRANSIENT  measured in a transient env that was then destroyed; evidence retained
IMPLEMENTED_TESTED  code + tests exist AND a green suite was observed at a frozen SHA
N/A_WITH_EVIDENCE   outside required scope, with a written reason

INTERIM (must be resolved before Phase 12 freeze — never a terminal state):

IMPLEMENTED_UNVERIFIED  source + tests exist; suite NOT re-run this pass; runtime not verified
UNMEASURED              required; not yet measured in this program
NOT_PASSING             a measured control currently fails
NOT_PRESENT             required; does not exist yet
```

No required row may be closed with `PARTIAL` / `PLANNED_ONLY` / `NOT_VERIFIED`.

## Open defect found while measuring (Wave 0/2)

| id | defect | why it matters | source |
|---|---|---|---|
| `[fake-injection-test]` | The first test in `internal-portal/test/ai-adversarial.test.js` asserts only `prompt.length > 0` against its own attack prompts, so it passes whatever the guardrail does. Its companion skips unless `LIVE_TESTS=1`. | The suite reports a green "prompt injection is safely neutralized" while asserting nothing about the guardrail — false confidence in 6A.4. | `test/ai-adversarial.test.js:15-21` |

Real 6A.4 coverage exists and **was** measured: `test/agent-runtime.test.js`
(`input_guard` / `prompt_injection` → `status:'blocked'`, `proposedAction:null`;
`createInputGuardrail().check()` → `ok:false` on 4 attacks). Row 19 is closed on
that evidence, **not** on `ai-adversarial.test.js`.

## Matrix

| # | Required component | Status (now) | Evidence measured | Close in |
|---|---|---|---|---|
| 1 | Terraform as canonical IaC | **IMPLEMENTED_TESTED** | `infra/terraform/` (ADR-0003); `terraform validate` + `terraform test` 13/13 green at a frozen, measured configuration; real read-only plan 13/13; `terraform-validate.yml` CI gate. Note: Bicep removed by PR #4, so the parity oracle is gone (see §2 gate LOST row) | Phase 1 |
| 2 | Remote state + GitHub OIDC | **NOT_PRESENT** | no secretless deploy path measured | Phase 2 |
| 3 | Import existing Azure resources (no recreate) | **UNMEASURED** | live inventory not probed | Phase 3 |
| 4 | VNet + Private Endpoints + Private DNS | **UNMEASURED** | `infra/terraform/modules/network` | Phase 4 |
| 5 | UAMI + Key Vault | **UNMEASURED** | `infra/terraform/modules/keyvault` (no `identity` module today) | Phase 4 |
| 6 | PostgreSQL durable approval store | **IMPLEMENTED_TESTED** | `migrations/001_action_lifecycle.sql` (row-level approvals, `UNIQUE (proposal_id)`), `lifecycle-store-postgres.js`; **6/6 against real PostgreSQL 16** incl. approval surviving pool replacement. Boundary: local PG16, never Azure PG. | Phase 5 |
| 7 | Redis (rate limit / cache / idempotency TTL) | **UNMEASURED** | — | Phase 5 |
| 8 | Service Bus + Automation Worker + DLQ | **IMPLEMENTED_UNVERIFIED** | worker + DLQ-classified outcomes (`DEAD_LETTERED`) tested with a fake executor (`test/action-lifecycle.test.js`); **no live Service Bus** — `infra/terraform/modules/messaging/` only | Phase 5 |
| 9 | RBAC / role-based access on portal routes | **IMPLEMENTED_TESTED** | `auth.js` `requireAuth(permission)` on 28 enterprise routes; `test/auth-boundary.test.js` asserts 401 for anonymous on 13 probes + 403 for VIEWER on mutations/audit (measured in the 388-test suite) | Phase 6 |
| 10 | Deterministic executor + post-condition verification | **IMPLEMENTED_TESTED** | `llm-gateway/automation/{executor,policy}.py` (argv, `shell=False`, 71 pytest + 4 xfailed) + Node `POSTCHECK_FAILED` path; PowerShell AST 8/8. Boundary: **live AD mutation NOT_RUN** | Phase 6 |
| 11 | Approval survives replica switch (A→B consistency) | **IMPLEMENTED_TESTED** | approval re-read by a **second independent pool** (stand-in for another replica) in `test/action-lifecycle-postgres.test.js`; replay against it → `DUPLICATE_BLOCKED`. Boundary: two pools, not two Azure replicas. | Phase 6 |
| 12 | Audit trail | **IMPLEMENTED_TESTED** | append-only `action_audit` + ordered lifecycle (`PROPOSED→APPROVAL_REQUESTED→APPROVED→QUEUED→STARTED→SUCCEEDED→POSTCHECKED`) asserted; redaction negative control (secret planted in executor error never reaches ledger) | Phase 6 |
| 13 | OTel + App Insights + Log Analytics + Grafana + SLO | **UNMEASURED** | `infra/terraform/modules/observability` | Phase 7 |
| 14 | Front Door + WAF + APIM (edge) | **UNMEASURED** | no `edge`/`apim` module in Terraform today | Phase 8 |
| 15 | OCI build + SBOM + digest-pinned rollout | **UNMEASURED** | `build-container.yml` | Phase 9 |

> The live footprint is narrow (`authMode: "lab"`, mock webhook, no credential in probe). Any "live RBAC / durable approval" claim must restate that boundary. Carried figures (`137 passed`, restore-drill PASS on a `/tmp` fixture) are **CARRIED_FORWARD_NOT_REMEASURED**.

## AI Production Readiness (Phase 6A–6D)

> Mandatory gate between Phase 6 and Phase 7. Full spec: [`AI-PRODUCTION-GATE.md`](./AI-PRODUCTION-GATE.md).

| # | Required component | Status (now) | Evidence measured | Close in |
|---|---|---|---|---|
| 16 | 6A.1 Provider timeout / retry / fallback / circuit breaker | **UNMEASURED** | `llm-gateway` exists (CB/retry/PII per its README) — not verified end-to-end here; **lifecycle** retry/bounded-retry IS tested (transient → RETRY, ceiling → DEAD_LETTERED) but that is queue retry, not provider retry | 6A |
| 17 | 6A.2 Side-effect idempotency (privileged action) | **IMPLEMENTED_TESTED** | `UNIQUE (idempotency_key)` + `ON CONFLICT DO NOTHING`; simultaneous-delivery + after-success-replay + restart-replay all `DUPLICATE_BLOCKED` with executor count = 1 (unit + real PG) | 6A |
| 18 | 6A.3 Structured proposal validation (schema + business + authz) | **IMPLEMENTED_TESTED** | Node `validateProposal` (raw-command / unknown-field / unknown-action rejected) + Python `models.validate_proposal` + `policy.validate_parameters`; catalog parity test keeps the two in step | 6A |
| 19 | 6A.4 Direct prompt-injection controls | **IMPLEMENTED_TESTED** | `test/agent-runtime.test.js` real negative controls: `input_guard`/`prompt_injection` → `status:'blocked'` + `proposedAction:null`; `createInputGuardrail().check()` → `ok:false` on 4 attacks. **Caveat:** `ai-adversarial.test.js` first test asserts only `prompt.length > 0` — it guards nothing and must be replaced or removed (defect logged below) | 6A |
| 20 | 6A.5 Retrieval / KB tenant isolation (if retrieval present) | **UNMEASURED** | `src/rag.js` exists; no cross-tenant retrieval negative control | 6A |
| 21 | 6A.6 No secrets in prompt / log / metric / trace | **UNMEASURED** | audit-ledger redaction is IMPLEMENTED_TESTED (negative control); prompt/log/metric/trace not covered | 6A |
| 22 | 6B.2 Durable HITL state (approval survives restart) | **IMPLEMENTED_TESTED** | file-backed store: approve → NEW instance → `APPROVED` + replay `DUPLICATE_BLOCKED`; real PG: approve → pool replacement → still `APPROVED` | 6B |
| 23 | 6B.4 Least-privilege tools; no raw LLM execution authority | **IMPLEMENTED_TESTED** | deterministic catalog (risk per action), `llm_raw_shell` rejected at validation, agent tools gated (`isAutoAllowed` read-only; write always needs approval), queue message carries identifiers only | 6B |
| 24 | 6C.1 Bounded concurrency | **UNMEASURED** | — | 6C |
| 25 | 6C.5 AI cost metrics | **UNMEASURED** | — | 6C |
| 26 | 6D.1 Golden dataset | **UNMEASURED** | — | 6D |
| 27 | 6D.4 Slice-level regression gate | **UNMEASURED** | — | 6D |
| 28 | Phase 7 AI distributed tracing | **UNMEASURED** | `infra/terraform/modules/observability` | 7 |

## MCP + RAG + Agent (Phase 6E–6G)

> Full spec: [`MCP-RAG-AGENT.md`](./MCP-RAG-AGENT.md). Helpdesk identity: **Governed AI Agent + RAG + MCP Enterprise Automation**.

| # | Required component | Status (now) | Evidence measured | Close in |
|---|---|---|---|---|
| 29 | 6E KB retrieval hardening (ITIL / runbook) | **UNMEASURED** | — | 6E |
| 30 | 6F MCP platform (ticket / asset / knowledge / directory / automation) | **UNMEASURED** | — | 6F |
| 31 | 6F High-risk `automation.execute` behind HITL (never LLM-exposed) | **UNMEASURED** | — | 6F |
| 32 | 6G Agent + RAG + MCP end-to-end (ticket → HITL → executor → audit) | **UNMEASURED** | — | 6G |
