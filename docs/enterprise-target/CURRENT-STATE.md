# CURRENT STATE — Enterprise-IT-Helpdesk-Lab

```text
measured_at : 2026-10-02
method      : read-only for Azure (plan/CLI only); local suites re-run on branch tip.
mutations   : remote refs fetched; no destructive git against other writers' worktrees.
rule        : no number appears below unless it was measured here, or is explicitly
              labelled CARRIED_FORWARD_NOT_REMEASURED.
```

## 1. Identity

| Field | Value |
|---|---|
| remote | `https://github.com/imtarget05/Enterprise-IT-Helpdesk-Lab.git` |
| **canonical ref (`origin/main`)** | `3ad2449` (PR #4 — Bicep stack deleted; PR #3 — Terraform canonical) |
| local `main` | `66df1d5` — **stale, must not be quoted** |
| worker branch | `helpdesk/core-runtime` (`00c9873`, rebased on `3ad2449`) — Wave 2, pushed |
| worktree | **CLEAN** |
| Render purge | **DONE** — `render.yaml` + `keepalive.yml` removed in PR #1 (`f976d9b`); anti-Render gate `test_hygiene_no_render.py` (5 tests) merged |

**Concurrency hazard observed during this pass:** a second writer
(`feat/terraform-canonical`) and a third (`ent/enterprise-target`) worked on the
same repository, and `CURRENT-STATE.md` was edited outside this session.
Integrator action: preserve the foreign edit in a stash
(`/tmp/helpdesk-preserved/CURRENT-STATE.md.concurrent-writer-edit`), reset `main`
to `origin/main`, then re-verify everything before claiming anything. The local
Phase-1 commit `8838e03` was a duplicate of already-landed PR #3 and was
**dropped, not merged** — merging it would have reverted PR #1's Render purge.

## 2. Infrastructure as deployed today

| Field | Value |
|---|---|
| IaC language | **Terraform only** (`infra/terraform/`). The Bicep stack was **deleted** in PR #4 (`3ad2449`). |
| entrypoint | `infra/terraform/main.tf` + `modules/{network,keyvault,database,messaging,observability,apps}` |
| parameters | `infra/terraform/env/{dev,prod}.tfvars` |
| gates present | `terraform validate` · `terraform test` (13) · `check_plan_invariants.py` (13) · `scripts/tests/test_controls.py` (18 bite tests) |
| **gate LOST in PR #4** | the Bicep↔Terraform oracle: `check_parity.py` (130), `check_bicep_frozen.py`, `FROZEN.lock.json` + their `test_controls.py` classes. With Bicep gone the comparison target is gone; the port is now trusted on its own contract assertions only. Deliberate cost of "Terraform only" — recorded in PR #4's message, not hidden. |
| CI | `.github/workflows/{ci.yml,iac-validate.yml,terraform-validate.yml,build-container.yml,llm-gateway.yml}` |

## 3. Measured this pass (2026-10-02, branch `helpdesk/core-runtime` @ `00c9873`)

| Suite | Command | Result |
|---|---|---|
| Node portal | `cd internal-portal && npm test` | **439 — 432 pass, 7 skipped, 0 fail** |
| Node portal, with a real DB | `LIFECYCLE_PG_URL='postgres://…@127.0.0.1:55432/postgres?sslmode=disable' npm test` | **439 — 438 pass, 1 skipped, 0 fail** |
| Governed lifecycle (unit) | `node --test test/action-lifecycle.test.js` | **31/31** |
| Governed lifecycle (REAL PostgreSQL 16) | `LIFECYCLE_PG_URL=…?sslmode=disable node --test test/action-lifecycle-postgres.test.js` | **6/6** |
| TOCTOU binding | `node --test test/lifecycle-toctou.test.js` | **15/15** |
| Governed lifecycle over HTTP (E2E) | `node --test test/automation-http.test.js` | **15/15** (CASE 1–10) |
| PostgreSQL TLS resolution + pool wiring | `node --test test/lifecycle-tls.test.js` | **8/8** (3 mutations caught, see below) |
| Auth fail-closed | `node --test test/auth-failclosed.test.js` | **5/5** |
| Service Bus bridge | `node --test test/servicebus-lifecycle-bridge.test.js` | **3/3** |
| Python portal (Flask) | `DATA_FILE=$(mktemp -d)/db.json PORT=0 python3 -m unittest discover` | **90 OK** |
| llm-gateway automation | `.venv-helpdesk/bin/python -m pytest llm-gateway/tests/ -q` | **71 passed, 4 xfailed** |
| PowerShell scripts | `bash scripts/verify-ps1-syntax.sh scripts` | **8/8 parse OK** |
| Terraform | `terraform validate` + `terraform test` | **valid / 13 passed, 0 failed** |
| Terraform control bite tests | `python3 -m unittest discover -s infra/terraform/scripts/tests` | **18/18 OK** |
| CI @ `origin/main` | `gh run list` (PR #4 merge) | **CI ✓ · IaC Validate ✓ · Terraform Validate ✓** |
| CI on PR #5 head `7ab508b` | run `36955832608` | **12/12 jobs SUCCESS** (Portal tests Node 20 + 22, Python portal 3.11 + 3.12, PowerShell AST, OpenAPI, Docker Compose, gitleaks, npm audit, pip-audit, coverage audit, SonarCloud scan) |

### 4d. The one red check, and why it was not a code regression

`SonarCloud Code Analysis` reports **FAILURE** on the PR head. It is not a job
in this repo's CI — it is the SonarCloud GitHub App, so it cannot be fixed or
re-run from the repository. What was actually measured:

| | |
|---|---|
| **Message** | "Quality Gate failed — Reliability Rating on New Code (required ≥ A), Security Rating on New Code (required ≥ A)" |
| **Not caused by this branch** | on `main` and on every prior merge (`6678a01`, `3ad2449`) the same check reads **`cancelled`**, never `success`. It has never been green in this repo |
| **Not readable** | the SonarCloud public API returns `total: 0` issues for the PR and for the branch, so the specific findings cannot be enumerated |
| **Root configuration gap** | `sonar-project.properties` declares `sonar.projectKey=imtarget05_Enterprise-IT-Helpdesk-Lab`. The SonarCloud organization `imtarget05` has **33 projects and this key is not among them** (MAIA, Factory and the other portfolio repos are all present and analysed). Automatic Analysis is therefore running against a key that resolves to no project |

Merged with the owner's explicit decision, recorded rather than hidden. **No
check was disabled and nothing was force-pushed.** Two consequences stay open:

- **[sonar-project-key-unverifiable]** — the real SonarCloud project key for
  this repo is unknown and cannot be obtained from inside the repository, so no
  Reliable/Security rating on new code can currently be *measured* here. If that
  gate is meant to carry weight, someone with SonarCloud org access must supply
  the key or create the project. *source: SonarCloud org listing, 2026-10-02*
- **[sonar-new-code-rating-unknown]** — until that is fixed, "no reliability
  bugs on new code" is **not a claim this repo can make**. The Node/Python suites
  and the mutation evidence are the signals actually available.

### 4e. Governed lifecycle over HTTP, and two real defects it exposed

The lifecycle existed (`action-lifecycle.js`, ~500 lines, full state machine) but
had **no HTTP surface**, so a new consumer would have been pushed toward
reaching into the store directly. It is now reachable, and the routes are thin:
they validate shape, derive identity from the session, and hand the decision to
the lifecycle. **There is no `/execute` endpoint**, by design — approving makes a
proposal queueable, the worker performs the side effect.

| Endpoint | Permission | Authority source |
|---|---|---|
| `POST /api/automation/proposals` | `ticket:write` | session tenant + role table |
| `GET /api/automation/proposals/:id` | `read` | session tenant, 404 across tenants |
| `POST /api/automation/proposals/:id/approve` | `change:approve` | session tenant + separation of duties |
| `POST /api/automation/proposals/:id/reject` | `change:approve` | session tenant |

Two defects surfaced while building it, both of which had been invisible before:

**1. There was no TOCTOU binding at all.** Nothing tied an approval to the payload
that would run, so a proposal could be approved and then edited before execution.
Added: a canonical-JSON SHA-256 over `{action, parameters}` written at creation
(migration `002_payload_hash.sql`), copied onto the approval row, and re-verified
both before queueing **and** again in the worker before the executor is reached.

**2. A failed post-check was reported as success.** The check was
`outcome.postCheck !== false`, so `{ verified: false, why: 'target still enabled' }`
passed — only a literal `false` failed. That is exactly the "exit code 0 is not
proof" failure this stage exists to prevent. Replaced with `isPostCheckVerified()`,
which requires an explicit verdict and treats a verdict-less object as UNVERIFIED.

The second defect is the more instructive one: **no unit test caught it**,
because every unit-test executor returned `{ verified: true }`. It was found by
CASE 10 of the HTTP end-to-end suite, using an executor that fails its post-check.
It then exposed a third, smaller thing — a test that had been returning
`postCheck: { ok: true }`, an object with no verdict at all, and passing *because
of* the bug.

### 4f. Two controls that had teeth removed by vague assertions

Mutation evidence now runs 11 mutations across 4 suites (baseline 95 pass / 0
fail). Two initially SURVIVED, and both failures were the same mistake on my part:

| | Mutation | First result | Cause | Fix |
|---|---|---|---|---|
| M-L4 | `enqueue`'s TOCTOU gate removed | **SURVIVED** | the test asserted `code ∈ [PAYLOAD_MODIFIED, APPROVAL_PAYLOAD_MISMATCH]` — the second check was still firing, so the test passed with the first deleted | assert the **exact** code, and add a separate test where the tamperer repairs the self-consistency so only the approval hash can catch it |
| M-L7 | worker stops checking the catalog | **SURVIVED** | no test could produce a row with an out-of-catalog action, because `propose()` refuses to create one | plant the row directly, as a compromised queue/DB writer would |

Both were cases of a test passing for the *wrong reason*. The lesson generalises:
asserting a union of acceptable outcomes is how a control quietly stops being
tested.

Evidence: `docs/testing/evidence/2026-10-02-core-runtime-node-suite.log` (committed).

### 4a. Defect found and closed on this pass — PostgreSQL TLS was hardcoded

Re-running the durable suite against a real database (instead of trusting the
committed "green" numbers) exposed a genuine defect:

| | |
|---|---|
| **Symptom** | every `action-lifecycle-postgres` test failed with `The server does not support SSL connections` — **6 failures** that the no-DB run had hidden behind `skip` |
| **Root cause** | `lifecycle-store-postgres.js` hardcoded `ssl: { rejectUnauthorized: false }` and only honoured `DATABASE_SSL === 'false'`. Any PostgreSQL without SSL (local docker, CI) could not connect at all |
| **Fix** | `resolveSsl()` — ranked config: `DATABASE_SSL` env → libpq `?sslmode=` in the connection string → **secure default (TLS on)**. `?sslmode=disable` is now the portable dev opt-out; Azure URLs keep TLS with no env var |
| **Security direction** | TLS-off requires an *explicit* opt-out. Removing `?sslmode=disable` restores encryption; there is no configuration in which TLS is dropped silently |
| **Regression evidence** | the first version of the test only exercised `resolveSsl()` in isolation — and a mutation that restored the hardcoded `ssl` **survived it**. A pool-wiring assertion (`store.pool.options.ssl`) was added, and the mutation then failed as it must |
| **Mutations caught** | M1 hardcoded `ssl` → 1 fail · M2 `sslmode=disable` branch removed → 2 fails · M3 secure default flipped to TLS-off → 3 fails |

Measured after the fix: no-DB **397 / 390 pass / 7 skipped / 0 fail**;
with real PostgreSQL 16 **397 / 396 pass / 1 skipped / 0 fail**.

### 4b. Defect found and closed on this pass — tenant was persisted but never enforced

The ledger carried `cross_tenant_ticket/asset_access = 0` as **NOT_PRESENT**.
Reading the code rather than the label confirmed it was worse than untested —
tenant was not enforced at all:

| | |
|---|---|
| **Sessions carried no tenant** | `auth.js` issued `{ username, role }`, so there was nothing to scope by |
| **Read paths never filtered** | `enterprise-routes.js` filtered tickets on status/priority/source and assets on status/type and **never mentioned tenant**; `app.js` served `GET /api/tickets`, `GET /api/assets`, both `:id` routes and both CSV exports unscoped |
| **The AI routes read tenant from the body** | `POST /api/ai/agent` and `/api/ai/agent/approve` passed `str(body.tenant) \|\| 'default'` straight into the agent, so any authenticated caller could drive the agent inside another tenant's context |

The fix binds the tenant to the **session** at login from the configured user
record — never from a header, query parameter or body — and enforces it in
`internal-portal/src/tenant-scope.js` on every ticket and asset read, write and
export. A row belonging to another tenant answers **404, not 403**: "this exists
but is not yours" is itself a disclosure.

Two design points worth naming:

- **Legacy rows** (no `tenant` field) map to `default`, so pre-tenancy seeded
  data stays visible instead of vanishing. It is a compatibility value, not a
  bypass: the comparison is still an equality check, so a tenant-A caller can
  never match a tenant-B row.
- **The response is the stamped row.** An intermediate version inserted
  `stampTenant(asset, ...)` into the store but still replied with the
  pre-stamp literal, so the API reported a row without the tenant that was
  actually persisted. The adversarial test caught this drift immediately.

### 4c. The tenant control caught its own hollow test

**A side door was still open.** Scoping only the HTTP routes would have left the
agent able to read the same rows: `agent/tools.js` `requireTicket`,
`search_tickets` and `search_assets` read the store directly, and the
orchestrator's `run()` did not even put `tenant` into the tool context (only
`approve()` did). So the agent could return any ticket or asset the HTTP filter
had just refused. Both are now tenant-scoped, and a tool call **without** a
caller returns nothing rather than everything — an unscoped agent read fails
closed.

Mutation evidence: `internal-portal/scripts/tenant-mutation-evidence.py`
(2 suites, baseline 49 pass / 0 fail)

| | Mutation | Result |
|---|---|---|
| M1 | tenant filter removed from `GET /api/tickets` | **CAUGHT** (2 fails) |
| M2 | tenant filter removed from the ticket CSV export | **CAUGHT** (1 fail) |
| M3 | session tenant read from a request header/query | **CAUGHT** (1 fail) |
| M4 | single-row tenant equality check removed | **CAUGHT** (3 fails) |
| M5 | created rows no longer stamped with the caller tenant | **CAUGHT** (5 fails) |
| M6 | AI agent route reads tenant from the request body again | **CAUGHT** (1 fail) — *after the test was rewritten* |
| M7 | agent `search_tickets` reads the whole store again | **CAUGHT** (1 fail) |
| M8 | agent `requireTicket` reads any ticket by id again | **CAUGHT** (2 fails) |

The first version of the M6 assertion only grepped the agent's response body for
the tenant string. The agent does not echo it back, so **M6 SURVIVED** — a
control that could not fail. The test was rewritten to assert an observable
*effect*: long-term memory is keyed `${tenant}:${user}` and persisted to
`agent-memory.json`, so the tenant the agent actually ran under is inspectable
state rather than an absent string. The question also had to contain a phrase
the memory extractors recognise, otherwise nothing was written and the negative
assertions would have passed vacuously — which is why the test now asserts the
*correct* keys are present too.

## 4. Security invariants — status after Wave 2

| Invariant | Control (deterministic code + database) | Status |
|---|---|---|
| `duplicate_privileged_execution = 0` | `UNIQUE (idempotency_key)` + `ON CONFLICT DO NOTHING`, claimed before the side effect; two independent pools racing one key measured on real PostgreSQL 16 | **IMPLEMENTED_TESTED** |
| `high_risk_execution_without_approval = 0` | approval gate in `execute()` + append-only approval row (unique per proposal) | **IMPLEMENTED_TESTED** |
| `unauthorized_privileged_execution = 0` | authorization re-derived from the **persisted** role, never from the queue message | **IMPLEMENTED_TESTED** |
| `llm_raw_shell_execution = 0` | no executor path accepts a command string; raw-command fields fail proposal validation (catalog parity-tested against `llm-gateway`) | **IMPLEMENTED_TESTED** |
| `secret_leakage = 0` (audit ledger) | `redact()` in the audit writer + negative control that plants a secret in an executor error | **IMPLEMENTED_TESTED** |
| `cross_tenant_ticket/asset_access = 0` | tenant bound to the **session** at login (from the configured user record, never from a request field) and enforced in `tenant-scope.js` on every ticket/asset read, write and CSV export; 404-not-403 disclosure policy; 6 mutations all caught | **IMPLEMENTED_TESTED** |

## 5. Verified seams present in source

> Presence in source ≠ verified at runtime. This section records existence only.

- PostgreSQL durable store adapter (legacy collections) — `internal-portal/src/postgres-adapter.js`
- Row-level governed lifecycle — `internal-portal/src/{action-catalog,action-lifecycle,lifecycle-store-postgres,lifecycle-store-memory}.js` + `internal-portal/migrations/001_action_lifecycle.sql`
- Worker bridge — `internal-portal/src/servicebus-bridge.js`
- Messaging module — `infra/terraform/modules/messaging/`

## 6. Open defects / documented gaps (carried, with source)

- **[helpdesk-capability-gaps]** — (1) no role-based access on portal routes, (2) no alert/ticket dedupe, (3) SLA is `slaPercent` only, no clock-based breach. *source: `docs/PORTFOLIO-COMPLETION-AUDIT-v2.md`*
- **[helpdesk-azure-boundary]** — the live footprint is narrow: `authMode: "lab"`, mock webhook. Any "live RBAC / durable approval" claim must restate it. *source: `docs/PORTFOLIO-FLAGSHIP-MATRIX.md`*
- **[wave2-boundaries]** — the durable store was exercised against **local PostgreSQL 16**, never Azure PostgreSQL. *source: `docs/adr/0004-durable-action-lifecycle.md`*
- **[wave2-http-queue]** — the HTTP approval path calls `lifecycle.enqueue()` and then `queue.publish()` **when a queue is injected**. With no queue configured the proposal is left in `APPROVED` and the response carries `queued: false`. **Service Bus publishing is not verified live**; only the repository abstraction is exercised. *source: `internal-portal/src/automation-routes.js`*
- **[wave2-executor-simulated]** — the default executor is a **simulation** that returns `simulated: true` and touches nothing. A real executor must be injected explicitly; no privileged system has been acted on. *source: `internal-portal/src/automation-runtime.js`*
- **[wave2-scope]** — only `tickets` and `assets` are tenant-scoped. **`problems` and `changes` are NOT**, and are deliberately not exposed to agent tools rather than exposed unscoped. *source: `internal-portal/src/tenant-scope.js`*
- **[wave2-pg-tls]** — database TLS is resolved from configuration, but **no certificate is verified against a CA** on the default path (`rejectUnauthorized: false`, required for managed-provider certs). Tightening this needs the Azure CA bundle and is a Wave 5 item, not claimed here.

## 7. NOT YET MEASURED (fail-closed)

- Azure live revision / image digest .... **UNMEASURED this pass**
- privilege separation / multi-replica behavior in Azure .... **UNMEASURED**
- cost exposure ......................... **UNMEASURED**
- governed lifecycle over HTTP ......... **PRESENT** (`POST /api/automation/proposals`, `GET .../:id`, `POST .../approve`, `POST .../reject`; no execute route by design)
- cross-tenant adversarial control ..... **IMPLEMENTED_TESTED** (10 HTTP E2E cases + 8 tenant mutations)

CARRIED_FORWARD_NOT_REMEASURED (audit docs only): earlier local suite `137 passed / 0 failed`; restore-drill PASS on a `/tmp` fixture (AD part NOT_RUN). Do NOT quote as verified.

## 8. Hazards

- `$HOME` (`/Users/mainguyenbinhtan`) is a **DIRTY worktree** of `FlashSale-Backend`. `Projects/.git` is an **empty stub** → any git run from `Projects/` resolves to `$HOME`. **All git MUST use `git -C <abs repo path>`.**
- Concurrent writers (see §1): never `git add .`, never merge a branch that was not re-verified against the *current* `origin/main`.
- The transient Terraform plan embeds the configured placeholder password — deleted after each run, never committed.
