# ADR-0004: Durable governed action lifecycle (Wave 2, worker CORE)

- **Status:** Accepted
- **Date:** 2026-10-02
- **Branch:** `helpdesk/core-runtime` (integrator merges to `main` after green)
- **Related:** ADR-0002 (PostgreSQL + Service Bus), ADR-0003 (Terraform),
  `docs/SAFE-AUTOMATION.md`, `internal-portal/migrations/001_action_lifecycle.sql`

## Context

ADR-0002 moved portal collections to PostgreSQL as **JSONB blobs**
(`portal_collections.data`). That fixed corruption but kept two holes the
Enterprise Target invariants forbid:

1. **Last-writer-wins on one JSONB row** — two replicas writing the same
   collection overwrite each other; there is no conflict signal and no way to
   express `UNIQUE`, so a duplicated queue delivery CAN register a second
   privileged execution.
2. **Approvals in the same blob** — an approved state has no row-level lock, no
   append-only history, and no survival guarantee distinguishable from any
   other field.

Meanwhile `src/servicebus-worker.js` deduplicated with an **in-memory `Set`**
that dies with the process, and `src/auth.js` defaulted to a `legacy` mode
where **every request becomes IT_ADMIN**.

## Decision

1. **Row-level lifecycle tables** (`migrations/001_action_lifecycle.sql`):
   `action_proposal` → `action_approval` (unique per proposal) →
   `action_execution` (`UNIQUE (idempotency_key)`) → `action_audit` (append-only).
2. **Deterministic pipeline** (`src/action-lifecycle.js` + `src/action-catalog.js`):
   the ONLY authority that can move a proposal to execution. The queue message
   carries identifiers, never parameters, never commands.
3. **Fail-closed auth**: `enterprise` mode refuses to boot without users;
   `legacy` is refused under `NODE_ENV=production`; unknown `AUTH_MODE`
   throws instead of falling back.
4. **Worker bridge** (`src/servicebus-bridge.js`): the worker reports
   lifecycle outcomes; legacy non-governed job kinds keep their exact contract.

## Evidence

- `test/action-lifecycle.test.js` — 31 tests incl. simultaneous-duplicate,
  restart durability, self-approval refusal, forced-QUEUED-without-approval.
- `test/action-lifecycle-postgres.test.js` — 6 tests against **real
  PostgreSQL 16** (two independent pools racing one idempotency key;
  `23505` index proof; approval survives pool replacement).
- `test/auth-failclosed.test.js` — 5 tests.
- `test/servicebus-lifecycle-bridge.test.js` — 3 tests.
- Committed log: `docs/testing/evidence/2026-10-02-core-runtime-node-suite.log`
  (**348 tests — 347 pass, 1 skipped, 0 fail**).

## Consequences

- **Positive:** `duplicate_privileged_execution`,
  `high_risk_execution_without_approval`, `unauthorized_privileged_execution`
  now have database-enforced and test-proven controls in the Node runtime.
- **Negative:** two lifecycle surfaces coexist until the change/access-request
  approvals migrate onto this store (next: HTTP wiring + 6G E2E).
- **Risk acknowledged:** no live Azure PostgreSQL was touched; the durable
  evidence is local PostgreSQL 16. Live Azure persistence belongs to Phase 5.
