# MCP · RAG · AI AGENT — Enterprise-IT-Helpdesk-Lab

> Enterprise Target. MCP + RAG + AI Agent appear in **all three** repos, but with **different roles**. See [`ROADMAP.md`](./ROADMAP.md) and [`AI-PRODUCTION-GATE.md`](./AI-PRODUCTION-GATE.md).

## Division of responsibility

```text
RAG        = retrieve the right knowledge
AI Agent   = decide the next step and coordinate work
MCP        = standardize how Agent/LLM reaches tools, data and external systems
```

## Agent must never bypass security

```text
Agent → Typed Intent → Schema Validation → RBAC / Tenant Check
      → Risk Check → HITL if required → Deterministic Tool
```

## Role by repository

| Repo | RAG | AI Agent | MCP |
|---|---|---|---|
| **MAIA** | ⭐ Core | ⭐ Core | ⭐ Core |
| **Helpdesk** | ⭐ Core (ITIL / runbook) | ⭐ Core (support workflow) | ⭐ Core (tool integration) |
| **Factory** | 🟡 Supporting | 🟡 Supporting (investigation / reporting) | ⭐ Core (integration layer) |

**`MCP ≠ Agent`.** MCP is a *protocol* for exposing resources / prompts / tools. The **Agent** decides *when* a tool is needed; **MCP** defines *how* it is called; **RAG** supplies knowledge for reasoning.

---

## This repository — Enterprise-IT-Helpdesk-Lab

**Identity: Governed AI Agent + RAG + MCP Enterprise Automation.**

### Architecture

```text
Employee → Helpdesk API
   ├──── RAG   (ITIL KB · runbooks · known incidents · troubleshooting docs)
   ▼
Helpdesk Agent  (classify · investigate · propose · explain)
   ▼
Typed Action Proposal → RBAC → Risk Engine → HITL Approval
   ▼
MCP Tool Gateway
   ├ Ticket MCP      (DB)
   ├ Asset MCP       (inventory)
   └ Automation MCP  (deterministic executor)
```

### RAG (core for ITIL / runbook)

KB: ITIL runbooks · SOP · known issues · incident history · device documentation · network troubleshooting · Windows/Office/M365 docs.
Flow: `ticket → retrieve relevant runbooks → LLM analysis → recommended troubleshooting`. The LLM must not invent a runbook.

### Agent (core) — logical roles, not necessarily 5 LLMs

```text
Triage Agent → Diagnosis Agent → Action Planner → Policy / Risk Guard
             → Human Approval → Executor
```

May be implemented as **1 orchestrator + deterministic nodes** to cut cost/latency.
**May do:** read ticket · read asset · search KB · propose action.
**May NOT do:** disable user · reset password · delete account · run arbitrary PowerShell.

### MCP (core for tool integration)

```text
helpdesk-ticket-mcp · asset-mcp · knowledge-mcp · directory-mcp · automation-mcp
```

Tools: `ticket.get`, `ticket.search`, `ticket.add_note`, `asset.get`, `asset.lookup_by_user`, `kb.search`, `directory.lookup_user`, `automation.propose_action`, `automation.status`.
High-risk `automation.execute` is **never** exposed to the LLM.

Flow: `LLM → MCP propose → policy → approval → Service Bus → worker → deterministic PowerShell`.

### Helpdesk demonstrates

> Enterprise AI Agent with governed MCP tools and human approval.

### Example end-to-end request

> User: "Employee A cannot log into the domain."

```text
Ticket → Triage
  → RAG: domain troubleshooting runbook
  → MCP: asset.lookup + directory.lookup_user
  → Agent proposes: unlock account
  → Risk = HIGH → Human approval
  → Service Bus → Worker → PowerShell deterministic executor
  → post-check → audit
```

The LLM never receives `powershell.exe ...` to author or edit a command.

---

## PHASE 6E — RAG Production Hardening

MAIA **mandatory**. Helpdesk applies to its KB. Factory applies to docs/SOP only.

**Gate:**
```text
[ ] retrieval ACL
[ ] tenant isolation
[ ] hybrid actually executes
[ ] reranker actually executes
[ ] empty retrieval behavior
[ ] no-answer behavior
[ ] chunk provenance
[ ] source identity
[ ] citation mapping
[ ] Recall@K
[ ] Precision@K
[ ] MRR
[ ] NDCG
[ ] retrieval regression gate
```

## PHASE 6F — MCP Tool Platform

```text
Implement PHASE 6F — MCP TOOL PLATFORM.

Do NOT use MCP merely as a wrapper around arbitrary code execution.

For each project inventory existing deterministic business capabilities and
expose only appropriate capabilities through typed MCP tools/resources.

MAIA:     knowledge / search / document / safe-action MCP.
Helpdesk: ticket / asset / knowledge / directory / approved-automation MCP.
Factory:  KPI / batch / quality / lineage / document / job MCP.

Every MCP tool must have:
  name
  version
  input schema
  output schema
  authorization policy
  tenant policy
  timeout
  retry classification
  side-effect classification
  idempotency semantics
  audit contract

Separate READ and WRITE tools.

High-risk write tools must never be directly executable by an LLM without
the existing deterministic authorization/HITL layer.

Treat every MCP response as untrusted external data when returning it to an
agent. Add indirect prompt-injection tests.

Instrument every call with: request_id, trace_id, agent_run_id, tool_call_id.

Add MCP negative controls for:
  unauthorized caller
  wrong tenant
  schema violation
  server timeout
  server unavailable
  malicious tool output
  duplicate write
  unsupported tool version.

No project may depend on another project's MCP server for its core
availability. Finish one repository before starting the next.
```

## PHASE 6G — Agent + RAG + MCP End-to-End

The strongest gate. Prove the **complete business workflow**, not each subsystem alone.

```text
MAIA:     question → agent → RAG → MCP → reasoning → SSE → citation
Helpdesk: ticket → RAG → agent → MCP read tools → proposal → HITL → queue → executor
Factory:  anomaly → deterministic gate → agent → MCP → RAG SOP → evidence-backed report
```

```text
Execute PHASE 6G — AGENT + RAG + MCP END-TO-END VALIDATION.

The purpose is not to prove each subsystem independently. Prove the complete
business workflow.

MAIA:
  authenticated tenant request
  → agent
  → tenant-filtered retrieval
  → MCP tool
  → grounded response
  → true SSE
  → citations.

Helpdesk:
  ticket
  → runbook retrieval
  → MCP investigation
  → typed proposal
  → deterministic authorization
  → HITL
  → queued execution
  → post-check
  → audit.

Factory:
  quality anomaly
  → deterministic quality decision
  → MCP evidence collection
  → RAG SOP/manual retrieval
  → investigation agent
  → structured report.

Inject failures at each boundary. Required failures:
  RAG unavailable
  MCP unavailable
  tool timeout
  LLM provider unavailable
  invalid tool output
  prompt injection in tool output
  agent max-step reached
  duplicate write delivery.

The system must fail predictably without bypassing authorization or
fabricating evidence.

Only after all three workflows pass positive and negative E2E tests may
Phase 6G be marked VERIFIED.
```

## MCP PRODUCTION READINESS (add to FINAL FREEZE)

```text
[ ] MCP tool schema versioned
[ ] tool input schema validation
[ ] tool output schema validation
[ ] per-tool authorization
[ ] tenant authorization
[ ] tool allowlist
[ ] no arbitrary shell tool
[ ] no unrestricted SQL tool
[ ] read vs write tools separated
[ ] risky tools require HITL
[ ] tool timeout
[ ] retry policy
[ ] idempotency for write tools
[ ] MCP server authentication
[ ] MCP transport encrypted
[ ] secrets never exposed as MCP resources
[ ] tool output treated as untrusted data
[ ] indirect prompt injection tested
[ ] audit every tool call
[ ] request_id / trace_id / agent_run_id / tool_call_id
[ ] latency metrics
[ ] error metrics
[ ] tool success rate
[ ] MCP server unavailable test
[ ] malformed tool response test
[ ] unauthorized tool call test
[ ] tool version compatibility test
```

## Monitoring additions (Agent + MCP + RAG)

Prometheus:
```text
rag_retrieval_total · rag_retrieval_duration_seconds · rag_empty_result_total
agent_runs_total · agent_steps_total · agent_tool_calls_total
agent_budget_exceeded_total · agent_loop_blocked_total
mcp_requests_total · mcp_request_duration_seconds · mcp_errors_total · mcp_unauthorized_total
tool_calls_total · tool_failures_total · tool_retries_total
llm_ttft_seconds · llm_tokens_total · llm_cost_estimate
```

Grafana dashboards: **RAG Quality** · **Agent Runtime** · **MCP / Tool Health**.

Trace:
```text
HTTP → agent.run → agent.plan
        ├─ rag.retrieve (embedding · vector.search · bm25 · reranker)
        └─ mcp.tool → external dependency
      → llm → SSE
```
