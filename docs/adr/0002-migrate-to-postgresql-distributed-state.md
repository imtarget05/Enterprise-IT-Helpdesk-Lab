# ADR-0002: Migration to PostgreSQL & Azure Service Bus for Enterprise Distributed Scale

- **Status:** Accepted
- **Date:** 2026-10-01
- **Supersedes:** [ADR-0001](0001-inmemory-store-file-backup.md)

## Context

ADR-0001 selected an in-memory store with local disk backup (`db.json`) for the lab portal, noting explicitly:
> *"single-writer ceiling, no concurrent-write transactions... acceptable until multi-technician concurrent load is real."*

The Enterprise Target platform now deploys the portal into Azure Container Apps (`ca-helpdesk-portal`) with multi-replica scaling (`scale 1..3`), automated ticket routing, and cross-replica Human-in-the-Loop (HITL) approval states. 

Under multi-replica scaling, container-local file persistence fails:
1. Replicas have isolated local filesystems $\rightarrow$ updates committed on Replica A are invisible to Replica B (split-brain state).
2. Approval tokens held in container memory cannot be resumed if the resume request routes to another replica.
3. Queue-driven background jobs require at-least-once delivery with message deduplication and dead-letter queues (DLQ).

Therefore, the migration trigger documented in ADR-0001 is officially triggered.

## Decision

1. **Durable Truth**: Migrate the primary datastore to **Azure Database for PostgreSQL Flexible Server**.
   - PostgreSQL provides ACID transactions, row-level locking for ticket mutations, and concurrent write safety across all container replicas.
   - Use connection pooling (`pg` pool in Node.js).
2. **Asynchronous Messaging**: Introduce **Azure Service Bus Standard** (`helpdesk-automation-jobs` queue).
   - Offload long-running ITIL automations (password resets, AD provisioning, monitoring escalations) to async queue workers.
   - Enforce message deduplication (`requiresDuplicateDetection: true`, 10-minute window) and dead-letter queues (`deadLetteringOnMessageExpiration: true`).
3. **Preserve Offline Test Seam**:
   - The OpenAPI route seam defined in ADR-0001 is preserved.
   - When `DATABASE_URL` is omitted (local dev and offline CI), the store seamlessly falls back to the in-memory adapter so the 341-test suite continues running in milliseconds with zero external dependencies.

## Consequences

- **Positive**:
  - Full multi-replica distributed correctness (`scale > 1` is safe).
  - Durable approval and audit ledger surviving container restarts and scale events.
  - Zero CI degradation (fast offline mock retained for unit tests).
- **Negative**:
  - Requires database migrations (`npm run db:migrate`) when deploying to production environments.
