# ADR-0001: In-Memory Store with File Backup vs Full DB for a Lab Portal

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

The portal serves tens of lab users with JSON-scale data (assets, tickets,
licenses) on student laptops and single VMs. It must boot with `npm start`,
survive crashes without losing tickets, and reset to a demo baseline in one
command. A full RDBMS would add a container, migrations, credentials, and
backup ops to every fresh clone.

## Decision

Atomic in-process JSON store (`data/db.json`, write-to-temp + rename) with
file backup semantics and `fixtures/db.baseline.json` one-command restore.
The OpenAPI contract (`public/openapi.yaml`, CI-validated) is the store seam:
route shapes are DB-agnostic so a future swap touches adapters, not clients.

## Consequences

- Positive: zero-provision boot, crash-safe writes, instant demo reset;
  278-test suite runs with no external service.
- Negative: single-writer ceiling, no concurrent-write transactions, no SQL
  query power — acceptable until multi-technician concurrent load is real.

## Alternatives

- Postgres/SQLite from day one: real queries and transactions, but migrations
  + volumes + backup story for data that fits comfortably in RAM-backed JSON.
- LocalStorage-only (no server store): trivial, but kills the API contract,
  RBAC, audit log, and every integration test that makes the portal credible.
