# CHECKPOINT — Wave A merged, Wave B starting

## Merge status

- `origin/main` = `b358146` (`feat(rag): close the cross-tenant knowledge-base leak (#8)`)
- PR #7 MERGED (squash) → `9315ab8`
- PR #8 MERGED (squash) → `b358146`
- PR #8 was rebased onto post-#7 main by cherry-picking only the 4 RAG commits;
  the 3 original #7 commits were not replayed (they were already squashed into main).

## app.js reconciliation

`git diff origin/main...HEAD -- src/app.js` for #8 touched only `/api/ai/analyze`:
ticket lookup via `findVisible` instead of `store.find`, and `ai.analyze(input,
{ tenant })`. No overlap with #7's queue/worker wiring. Verified:
- `automation-queue.js`, `automation-worker.js`, `agent/budget.js` present
- orchestrator still passes `{ store, requester, user, tenant, fetchImpl }`
- no `shell=true` / `execSync` / `spawn` introduced anywhere

## RAG state

- candidate tenant filter: line 246, `sort` at line 260 — filter strictly BEFORE rank
- Qdrant: `hits.filter(chunkVisibleTo)` enforced
- missing tenant: `if (!str(options.tenantId) || tenantId === SHARED_TENANT)` → `[]`
- whitespace tenant: caught (M-R7)
- analyze bypass: caught (M-R8, via tenant-isolation.test.js)
- citations: content-derived `chunkId` + `CORPUS_VERSION`
- untrusted framing: 4 separate assertions, each element required

## Honest limitations (unchanged)

- Every real corpus file is `__shared__`. Tenant denial proven with controlled
  fixtures only. PRODUCTION PRIVATE CORPUS: NOT_VERIFIED.
- RAG QUALITY: NOT_MEASURED. Recall@K, Precision@K, MRR, faithfulness, abstention
  all outstanding. Wave A closed authorization + citability, not quality.

## Two evidence defects found and fixed in this pass

The mutation harness was itself unsound:

1. It never restored a mutated file between mutations, so M-R8 ran with M-R7's
   whitespace fail-open still applied to `rag.js`. The gate failed for the wrong
   reason and M-R8 was reported CAUGHT. Fix: restore immediately after each
   mutation.
2. A non-zero exit counted as a kill. Node exits non-zero on crashes too, so an
   unproven mutation could be reported as proven. Fix: a catch requires the
   gate's own `AssertionError`/`ERR_ASSERTION` output; crashes report UNCATCHED.

With both fixed, M-R8 became genuinely SURVIVED — the route had no test that
analysed another tenant's ticket by id. Four tests added to
`test/tenant-isolation.test.js`; the harness now reports 8/8 caught by the right
gate.

Lesson to carry into Wave B: a mutation is only evidence about itself when it is
the only difference from baseline.

## Measured

- Node: 509 tests, 502 pass, 7 skip, 0 fail (stable 3/3)
- PostgreSQL 16 lifecycle: 6/6 (`LIFECYCLE_PG_URL`, sequential; container torn down)
- llm-gateway: 71 passed, 4 xfailed
- RAG mutation: 8/8 caught, baseline green
- CI: ALL REPO-OWNED REQUIRED JOBS GREEN (12/12 on post-#7 main).
  SONARCLOUD: EXTERNAL_BLOCKER (project key absent from the SonarCloud org; not
  a repository-owned job, not faked, not disabled).

## Wave B inventory (B1)

Existing agent tools in `src/agent/tools.js`:

| tool | sideEffect | classification |
|---|---|---|
| `search_tickets` | false | READ_SAFE (tenant-scoped via rowsVisibleTo) |
| `get_ticket` | false | READ_SAFE (tenant-scoped via findVisible) |
| `find_assets` | false | READ_SAFE (tenant-scoped) |
| `search_knowledge` | false | READ_NEEDS_TENANT_FIX → fixed in #8 (candidate-set filter) |
| `create_ticket` | true | WRITE_PROPOSAL — but writes REAL data on approval |
| `add_work_note` | true | WRITE_PROPOSAL — writes REAL data on approval |

No `automation.propose` tool exists for the governed lifecycle yet.
No raw shell / SQL tool exists anywhere. Registry already separates read-only
from side-effect tools via `sideEffect` and blocks side-effect tools unless
`ctx.approved`.

Wave B plan: typed MCP read tools that inherit tenant from the authenticated
context, `knowledge.search` delegating to the Wave A RAG boundary (never a second
retrieval path), and a single `automation.propose` write tool with no
`automation.execute`.

---

# CHECKPOINT — Waves A and B merged

## MAIN

`6024b3a` — `feat(mcp): typed MCP tools with a proposal-only write surface (#9)`
No open PRs.

## PR #7 / #8 / #9

All MERGED (squash).

- #7 → `9315ab8` durable queue + deterministic worker
- #8 → `b358146` RAG tenant-safe retrieval
- #9 → `6024b3a` typed MCP tools

## RAG

- candidate tenant filter: BEFORE rank (line 246 vs 260)
- Qdrant: filtered
- missing tenant: fails closed
- whitespace tenant: caught (M-R7)
- analyze bypass: caught (M-R8, via tenant-isolation.test.js)
- citations: content-derived chunkId + CORPUS_VERSION
- untrusted framing: each element asserted separately

PRODUCTION PRIVATE CORPUS: **NOT_VERIFIED** — every real corpus file is
`__shared__`; denial proven with controlled fixtures only.

RAG QUALITY: **NOT_MEASURED** — Recall@K, Precision@K, MRR, faithfulness,
citation correctness and abstention all outstanding.

## MCP (Wave B)

- inventory: 5 read tools + 1 write tool
- tenant context: frozen, built once from the session, never an argument
- read tools: `ticket.get`, `ticket.search`, `asset.get`, `asset.search`,
  `knowledge.search`
- `knowledge.search`: delegates to the Wave A retrieval entry point
- `automation.propose`: typed, catalogued action, risk from catalog not model
- `automation.execute` exposed: **NO** — absent, and the registry refuses to
  construct if any tool name looks like an execution path
- raw command field: **ABSENT** — rejected by schema validation
- RBAC: `AUTOMATION_ROLES` from the catalog, taken from the session role
- risk/HITL: HIGH_RISK reports `requiresApproval: true`; IT_ADMIN gets no bypass
- audit: tenant, actor, tool, arg SHAPES (lengths only, never values),
  correlation id, outcome
- read/write modules separate, asserted by import inspection

## Defects found in Wave B's own code

1. `createMcpContext` used `normalizeTenant`, which maps `''` → DEFAULT_TENANT.
   A whitespace tenant became a real scope instead of being refused — the same
   fail-open class Wave A closed in `retrieve()`.
2. `query` on the forbidden-field list broke the search tools. Raw SQL is
   blocked by `sql`/`raw_sql`/`rawsql`; a search term carries no authority.
3. `canonicalize` returns a JSON string, so proposals came back as an opaque blob
   with no addressable authority fields.

## Evidence discipline

Two MCP mutations initially SURVIVED, both the harness's fault: M-MCP1 mutated
nothing, and M-MCP4 removed a factory call whose helper the test invoked
directly. Both rewritten to mutate real behaviour; a new test poisons the
registry to pin where the guard actually runs.

Carried from Wave A: a mutation is only evidence about itself when it is the
ONLY difference from baseline. Restoration happens immediately after each
mutation, and a non-zero exit never counts as a catch without an assertion.

## Measured

- Node: **530 tests, 523 pass, 7 skip, 0 fail**
- PostgreSQL 16 lifecycle: 6/6 (container torn down; requires `LIFECYCLE_PG_URL`)
- llm-gateway: 71 passed, 4 xfailed
- RAG mutation: **8/8 caught**
- MCP mutation: **8/8 caught**
- CI: ALL REPO-OWNED REQUIRED JOBS GREEN on every merged PR.
  SONARCLOUD: EXTERNAL_BLOCKER.

## NEXT (superseded — see below)

Wave C is now merged; see the Waves C and D section.

---

# Waves C and D merged

## MAIN

`f1b035c` — `feat(rag-eval): measure retrieval quality and gate regressions (#11)`
PR #10 and PR #11 merged. No open PRs. Local feature branches removed.

## Wave C — crash-window durability

The queue-worker suite's header CLAIMED the four crash windows "cannot produce
a duplicate privileged execution". It contained 18 tests and none were crash
windows. Now they exist, measured by counting executor calls.

A status assertion proves the worker returned something plausible; it does not
prove the executor was not invoked. An implementation that executes and then
throws `APPROVAL_REQUIRED` on the way out satisfies every status-based test in
this repository while still performing the privileged effect.

| Window | Crash point | Executor calls |
|---|---|---|
| W1 | after publish, before receive | 1 |
| W2 | after receive, before ACK | 1 |
| W3 | after execute, before durable completion | 1 |
| W4 | after success recorded, before ACK | 1 |

Two mutations initially SURVIVED, both informative:

- Removing the pre-flight `getExecutionByKey` lookup changed nothing, because
  the durable `claimExecution` still blocked the duplicate. That is defence in
  depth working, not a weak test. M-C1 now removes the claim that actually
  authorises the effect and the suite catches it.
- Reporting a duplicate delivery as `ok: true` was undetected. Real gap: the
  executor still ran once, so "no duplicate execution" held, but the blocked
  delivery would have looked like a success to an operator and the DLQ would
  have stayed empty. No duplicate execution is not the same as duplicate
  VISIBLE. Two tests added, plus a `DUPLICATE_BLOCKED` audit assertion.

## Wave D — RAG quality, measured

RAG QUALITY is no longer `NOT_MEASURED`. Against the real corpus (284 chunks,
36 documents, offline hash-TF, 28 answerable queries, K=5):

| Metric | Value | Gated | Floor |
|---|---|---|---|
| Recall@5 | 0.8393 | yes | 0.75 |
| MRR | 0.6333 | yes | 0.55 |
| NDCG@5 | 0.6270 | yes | 0.50 |
| Precision@5 | 0.2071 | **no** | — |
| top-1 misses | 2 / 28 | yes | <= 15% |

Precision is ungated on purpose: K=5 over 36 documents where most queries have
one gold document bounds it near 0.2 by arithmetic. Gating a high value would
be asserting the metric is wrong.

Groundedness remains NOT MEASURED. It is a property of a GENERATED ANSWER, and
the default path is an offline rule-based engine with no model in the loop.

The most important defect found in Wave D: the quality gate initially scored a
LOCALLY-WRITTEN cosine loop instead of calling `memorySearch`. M-Q1 made
`memorySearch` return nothing and the gate stayed green. A quality suite
pointed at a parallel implementation measures that implementation. The ranker
now calls the production path and preserves its order.

PRODUCTION PRIVATE CORPUS is still **NOT_VERIFIED** — every real corpus document
is `__shared__`. Tenant denial was proven with controlled fixtures only.

## Measured

- Node: **569 tests, 562 pass, 7 skip, 0 fail**
- llm-gateway: 71 passed, 4 xfailed
- Crash-window mutation: **4/4 caught**
- RAG mutation: **8/8 caught**
- MCP mutation: **8/8 caught**
- RAG quality mutation: **6/6 caught**
- PostgreSQL 16 lifecycle: not re-measured. The local container fails with
  ECONNRESET on connect due to its self-signed certificate, and it fails
  IDENTICALLY with all changes stashed — an environment problem, not a
  regression. Last green stands at 6/6 on commit `6024b3a`.
- CI: ALL REPO-OWNED REQUIRED JOBS GREEN on every merged PR, including
  SonarCloud Code Analysis on PRs #10 and #11.

## Honest limitations carried forward

- RAG quality is measured with the OFFLINE hash-TF backend. Two golden queries
  score recall 0 because they are Vietnamese while the documents are largely
  English, and hash-TF matches only shared latin tokens. Both golden entries
  are correct; the limitation is recorded rather than hidden by rewriting the
  queries until the number looked better.
- Groundedness / faithfulness: NOT MEASURED, needs a generated answer set.
- Production private corpus: NOT_VERIFIED.
- Live Azure / Service Bus: NOT VERIFIED.

## NEXT

Wave E — agent guardrails, then observability, then Azure. The durable queue
remains file-backed; a Service Bus adapter must preserve the code path these
crash-window tests pin (receive-peek, execute, complete).