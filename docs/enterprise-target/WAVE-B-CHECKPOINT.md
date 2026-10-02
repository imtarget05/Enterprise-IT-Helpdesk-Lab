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