'use strict';

/**
 * PostgreSQL lifecycle — REAL database integration test.
 *
 * This is the strongest evidence in the Wave 2 slice: it talks to a real
 * PostgreSQL instance, so the atomicity claim is measured, not asserted.
 *
 *   · two INDEPENDENT pools (two "replicas") racing on one idempotency key →
 *     exactly one claim wins, because the winner is decided by
 *     `UNIQUE (idempotency_key)` inside the database, not by application code;
 *   · the unique index is proven directly (raw duplicate INSERT → 23505);
 *   · the approval row survives a complete pool replacement.
 *
 * Requires LIFECYCLE_PG_URL, e.g.
 *   docker run -d --name hd-pg-test -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=helpdesk -p 55432:5432 postgres:16-alpine
 *   LIFECYCLE_PG_URL=postgres://postgres:postgres@127.0.0.1:55432/helpdesk \
 *     node --test test/action-lifecycle-postgres.test.js
 *
 * Without LIFECYCLE_PG_URL every test in this file SKIPS (it never silently
 * passes), so CI without a database stays honest.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createActionLifecycle } = require('../src/action-lifecycle');
const { createPostgresLifecycleStore } = require('../src/lifecycle-store-postgres');

const PG_URL = process.env.LIFECYCLE_PG_URL;
const skip = PG_URL ? false : 'LIFECYCLE_PG_URL not set (no PostgreSQL available)';

const ADMIN = { username: 'tan.admin', role: 'IT_ADMIN', authenticated: true };
const APPROVER = { username: 'linh.approver', role: 'IT_ADMIN', authenticated: true };

function fakeExecutor(handler) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      if (handler) return handler(request, calls.length);
      return { ok: true, postCheck: { verified: true } };
    },
  };
}

/** A distinct pool = a distinct replica as far as the database is concerned. */
async function replica() {
  const store = createPostgresLifecycleStore({ connectionString: PG_URL });
  await store.runMigrations();
  const executor = fakeExecutor();
  const lifecycle = createActionLifecycle({ store, executor });
  return { store, executor, lifecycle };
}

async function cleanup(store) {
  // Remove this test's rows so the suite is re-runnable; the schema stays.
  await store.pool.query('DELETE FROM action_audit');
  await store.pool.query('DELETE FROM action_execution');
  await store.pool.query('DELETE FROM action_approval');
  await store.pool.query('DELETE FROM action_proposal');
}

describe('PostgreSQL lifecycle store (real database)', () => {
  test('migrations apply once and are recorded', { skip }, async () => {
    const a = await replica();
    const rows = await a.store.pool.query('SELECT name FROM schema_migrations ORDER BY name');
    assert.ok(rows.rows.some((r) => r.name === '001_action_lifecycle.sql'));

    // Re-running must be a no-op, not an error and not a duplicate row.
    await a.store.runMigrations();
    const again = await a.store.pool.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1', ['001_action_lifecycle.sql'],
    );
    assert.equal(again.rows[0].n, 1);
    await cleanup(a.store);
    await a.store.close();
  });

  test('NEGATIVE CONTROL: the unique index rejects a duplicate idempotency key', { skip }, async () => {
    const a = await replica();
    await cleanup(a.store);
    const proposed = await a.lifecycle.propose({
      actor: ADMIN, tenantId: 'tenant-a',
      proposal: { action: 'export_it_asset_audit', parameters: {} },
    });
    const key = `act-${proposed.proposalId}`;
    await a.store.claimExecution({
      proposalId: proposed.proposalId, idempotencyKey: key, tenantId: 'tenant-a', workerId: 'w1',
    });
    await assert.rejects(
      () => a.store.pool.query(
        `INSERT INTO action_execution
           (execution_id, proposal_id, idempotency_key, tenant_id, worker_id, status)
         VALUES (gen_random_uuid(), $1, $2, 'tenant-a', 'w2', 'CLAIMED')`,
        [proposed.proposalId, key],
      ),
      (err) => err.code === '23505',
      'the database itself must reject a second execution row for the same key',
    );
    await cleanup(a.store);
    await a.store.close();
  });

  test('NEGATIVE CONTROL: two replicas racing the same message execute once', { skip }, async () => {
    const a = await replica();
    const b = await replica(); // separate pool = separate container
    await cleanup(a.store);

    const proposed = await a.lifecycle.propose({
      actor: ADMIN, tenantId: 'tenant-a',
      proposal: { action: 'export_it_asset_audit', parameters: {} },
    });
    const { message } = await a.lifecycle.enqueue({ proposalId: proposed.proposalId });

    const [r1, r2] = await Promise.all([
      a.lifecycle.execute({ message, workerId: 'replica-a' }),
      b.lifecycle.execute({ message, workerId: 'replica-b' }),
    ]);

    const executed = [r1, r2].filter((r) => r.executed);
    assert.equal(executed.length, 1, 'exactly one replica may execute the privileged action');
    assert.equal(a.executor.calls.length + b.executor.calls.length, 1);
    const loser = r1.executed ? r2 : r1;
    assert.equal(loser.duplicate, true);

    const rows = await a.store.pool.query('SELECT count(*)::int AS n FROM action_execution');
    assert.equal(rows.rows[0].n, 1, 'one execution row must exist');

    await cleanup(a.store);
    await a.store.close();
    await b.store.close();
  });

test('approval is durable across a pool replacement, and replayed delivery is blocked', { skip }, async () => {
    const a = await replica();
    await cleanup(a.store);
    const proposed = await a.lifecycle.propose({
      actor: ADMIN, tenantId: 'tenant-a',
      proposal: { action: 'disable_company_user', parameters: { username: 'test-user' } },
    });
    await a.lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });
    await a.store.close();

    // New pool, same database: the decision must still be there.
    const b = await replica();
    const approval = await b.store.getApproval(proposed.proposalId);
    assert.equal(approval.decision, 'APPROVED');
    assert.equal((await b.store.getProposal(proposed.proposalId)).state, 'APPROVED');

    const { message } = await b.lifecycle.enqueue({ proposalId: proposed.proposalId });
    assert.equal((await b.lifecycle.execute({ message, workerId: 'w1' })).status, 'SUCCEEDED');

    const replay = await b.lifecycle.execute({ message, workerId: 'w2' });
    assert.equal(replay.status, 'DUPLICATE_BLOCKED');
    assert.equal(b.executor.calls.length, 1);

    await cleanup(b.store);
    await b.store.close();
  });

  test('NEGATIVE CONTROL: a high-risk proposal forced to QUEUED in SQL still needs approval', { skip }, async () => {
    const a = await replica();
    await cleanup(a.store);
    const proposed = await a.lifecycle.propose({
      actor: ADMIN, tenantId: 'tenant-a',
      proposal: { action: 'disable_company_user', parameters: { username: 'test-user' } },
    });
    // Hostile/legacy state written straight into the database.
    await a.store.pool.query("UPDATE action_proposal SET state = 'QUEUED' WHERE proposal_id = $1",
      [proposed.proposalId]);

    const result = await a.lifecycle.execute({
      message: { proposalId: proposed.proposalId }, workerId: 'w1',
    });
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.equal(a.executor.calls.length, 0);

    await cleanup(a.store);
    await a.store.close();
  });

  test('the persisted audit trail is queryable by proposal', { skip }, async () => {
    const a = await replica();
    await cleanup(a.store);
    const proposed = await a.lifecycle.propose({
      actor: ADMIN, tenantId: 'tenant-a',
      proposal: { action: 'backup_helpdesk_data', parameters: {} },
    });
    const { message } = await a.lifecycle.enqueue({ proposalId: proposed.proposalId });
    await a.lifecycle.execute({ message, workerId: 'w1' });

    const events = (await a.store.listAudit({ proposalId: proposed.proposalId })).map((e) => e.event);
    assert.deepEqual(events.filter((e) => e !== 'STARTED'),
      ['PROPOSED', 'AUTHORIZED', 'QUEUED', 'SUCCEEDED', 'POSTCHECKED']);

    await cleanup(a.store);
    await a.store.close();
  });
});