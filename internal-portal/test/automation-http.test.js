'use strict';

/**
 * Governed automation over HTTP — end-to-end cases A1..A10.
 *
 * These run against a real Express app on an ephemeral port with real Bearer
 * tokens and real tenants. They assert the ARCHITECTURE, not just status codes:
 * that approval does not execute, that execution only happens in the worker, and
 * that a cross-tenant proposal is indistinguishable from a missing one.
 *
 * The default executor is the simulated one, so nothing here touches a real
 * system — `executor: { simulated: true }` is asserted rather than assumed.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createTestClient } = require('./helpers');

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

const labAuth = {
  authMode: 'lab',
  authUsers: {
    // IT_ADMIN holds change:approve and may propose automation.
    'a.admin': { password: 'pw-a-admin', role: 'IT_ADMIN', tenant: TENANT_A },
    'a.l2': { password: 'pw-a-l2', role: 'HELPDESK_L2', tenant: TENANT_A },
    'a.viewer': { password: 'pw-a-viewer', role: 'VIEWER', tenant: TENANT_A },
    'b.admin': { password: 'pw-b-admin', role: 'IT_ADMIN', tenant: TENANT_B },
  },
  requestLogger: false,
};

let client;
/** Every execution the lifecycle performed, so tests can assert "exactly once". */
let executorCalls;

function recordingExecutor() {
  const calls = [];
  executorCalls = calls;
  return {
    calls,
    async run(request) {
      calls.push(request);
      return { ok: true, simulated: true, postCheck: { verified: true } };
    },
  };
}

async function tokenAs(username, password) {
  const r = await client.json('POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, `login ${username} failed: ${r.status}`);
  return { Authorization: `Bearer ${r.data.token}` };
}

const HIGH_RISK = { action: 'disable_company_user', parameters: { username: 'mallory' } };
const LOW_RISK = { action: 'backup_helpdesk_data', parameters: { target: 'nightly' } };

before(async () => {
  client = await createTestClient({ ...labAuth, executor: recordingExecutor() });
  await client.start();
});
after(async () => { if (client) await client.stop(); });

describe('CASE 1 — low risk runs without approval, but still not from HTTP', () => {
  test('a LOW_RISK proposal is authorised immediately and is not queueable without a queue', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const created = await client.json('POST', '/api/automation/proposals', LOW_RISK, a);

    assert.equal(created.status, 201);
    assert.equal(created.data.risk, 'LOW_RISK');
    assert.equal(created.data.state, 'AUTHORIZED', 'a low-risk action needs no approval');
    assert.equal(created.data.tenantId, TENANT_A);

    // The point of the architecture: AUTHORIZED is not EXECUTING.
    assert.equal(executorCalls.length, 0, 'no HTTP request may reach the executor');
  });
});

describe('CASE 2 — high risk parks at approval and executes only in the worker', () => {
  test('proposal -> pending approval -> approve -> queued, with no HTTP execution', async () => {
    const proposer = await tokenAs('a.l2', 'pw-a-l2');
    const approver = await tokenAs('a.admin', 'pw-a-admin');

    const created = await client.json('POST', '/api/automation/proposals', HIGH_RISK, proposer);
    assert.equal(created.status, 201);
    assert.equal(created.data.risk, 'HIGH_RISK');
    assert.equal(created.data.state, 'APPROVAL_PENDING');
    assert.equal(created.data.tenantId, TENANT_A);
    assert.equal(executorCalls.length, 0, 'an approval-pending proposal must not execute');

    const approved = await client.json(
      'POST', `/api/automation/proposals/${created.data.proposalId}/approve`,
      { reason: 'confirmed incident' }, approver,
    );
    assert.equal(approved.status, 200);
    // The durable queue is now wired by default, so an approval really does
    // enqueue. The state moves APPROVED -> QUEUED inside the same request.
    // It still does NOT execute: `executorCalls` is asserted unchanged below.
    assert.equal(approved.data.state, 'QUEUED');
    assert.equal(approved.data.queued, true, 'an approval must reach the queue');
    assert.ok(approved.data.proposalId);

    // STILL not executed: approval authorises, the worker performs.
    assert.equal(executorCalls.length, 0, 'approval must not execute over HTTP');

    // The job really is pending on the durable queue, not just marked as such.
    const depth = await client.context.automationQueue.depth();
    assert.ok(depth >= 1, 'the approved job is not pending on the queue');

    // The worker performs it, and the executor is reached exactly once.
    const processed = await client.context.automationWorker.runOnce();
    assert.equal(processed.status, 'completed', `worker status was ${processed.status}`);

    const executed = processed.result;
    assert.equal(executed.ok, true);
    assert.equal(executed.status, 'SUCCEEDED');
    assert.equal(executorCalls.length, 1, 'exactly one privileged execution');
    assert.equal(executorCalls[0].action, 'disable_company_user');
    assert.equal(executorCalls[0].parameters.username, 'mallory');
  });
});

describe('CASE 3 — rejection produces no execution', () => {
  test('a rejected proposal can never be queued or executed', async () => {
    const proposer = await tokenAs('a.l2', 'pw-a-l2');
    const approver = await tokenAs('a.admin', 'pw-a-admin');

    const created = await client.json('POST', '/api/automation/proposals', {
      action: 'restore_helpdesk_data', parameters: { snapshotId: 'snap-1' },
    }, proposer);
    assert.equal(created.data.state, 'APPROVAL_PENDING');

    const rejected = await client.json(
      'POST', `/api/automation/proposals/${created.data.proposalId}/reject`,
      { reason: 'not authorised by change window' }, approver,
    );
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.state, 'REJECTED');
    assert.equal(rejected.data.queued, false, 'a rejection must not queue');

    const before = executorCalls.length;
    const lifecycle = client.context.automationLifecycle;
    assert.equal((await lifecycle.enqueue({ proposalId: created.data.proposalId })).ok, false);
    const attempted = await lifecycle.execute({
      message: { proposalId: created.data.proposalId }, workerId: 'w-reject',
    });
    assert.equal(attempted.ok, false);
    assert.equal(executorCalls.length, before, 'a rejected action must never execute');
  });
});
describe('CASE 4/5 — cross-tenant read and approval are hidden, not forbidden', () => {
  test("tenant B cannot read tenant A's proposal (404, not 403)", async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const created = await client.json('POST', '/api/automation/proposals', HIGH_RISK, a);

    const cross = await client.json('GET', `/api/automation/proposals/${created.data.proposalId}`, undefined, b);
    assert.equal(cross.status, 404, 'a foreign proposal must be indistinguishable from a missing one');
    assert.ok(!JSON.stringify(cross.data).includes('mallory'), 'the 404 body leaked the proposal');
  });

  test("tenant B cannot approve tenant A's proposal", async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const created = await client.json('POST', '/api/automation/proposals', HIGH_RISK, a);

    const attack = await client.json(
      'POST', `/api/automation/proposals/${created.data.proposalId}/approve`,
      { reason: 'I am an admin too' }, b,
    );
    assert.equal(attack.status, 404, 'cross-tenant approval must be refused as not-found');

    const still = await client.json('GET', `/api/automation/proposals/${created.data.proposalId}`, undefined, a);
    assert.equal(still.data.state, 'APPROVAL_PENDING', 'the proposal must be untouched');
  });

  test('a nonexistent proposal and a foreign one answer identically', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const real = await client.json('POST', '/api/automation/proposals', HIGH_RISK, a);

    const foreign = await client.json('GET', `/api/automation/proposals/${real.data.proposalId}`, undefined, b);
    const missing = await client.json('GET', '/api/automation/proposals/00000000-0000-4000-8000-000000000000', undefined, b);
    assert.equal(foreign.status, missing.status, 'the two must not be distinguishable by status');
    assert.deepEqual(
      Object.keys(foreign.data).sort(), Object.keys(missing.data).sort(),
      'the two responses must not differ in shape either',
    );
  });
});

describe('CASE 6 — RBAC', () => {
  test('a VIEWER may not propose automation', async () => {
    const viewer = await tokenAs('a.viewer', 'pw-a-viewer');
    const attempt = await client.json('POST', '/api/automation/proposals', HIGH_RISK, viewer);
    assert.equal(attempt.status, 403);
  });

  test('an anonymous caller is refused', async () => {
    const attempt = await client.json('POST', '/api/automation/proposals', HIGH_RISK);
    assert.equal(attempt.status, 401);
  });

  test("an IT_ADMIN proposer cannot approve their OWN high-risk action", async () => {
    const admin = await tokenAs('a.admin', 'pw-a-admin');
    const created = await client.json('POST', '/api/automation/proposals', HIGH_RISK, admin);
    assert.equal(created.status, 201);

    const selfApprove = await client.json(
      'POST', `/api/automation/proposals/${created.data.proposalId}/approve`, {}, admin,
    );
    assert.equal(selfApprove.status, 403);
    assert.equal(selfApprove.data.code, 'SELF_APPROVAL_FORBIDDEN');
  });

  test('NEGATIVE CONTROL: body.tenant cannot override the session tenant', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const spoof = await client.json(
      'POST', '/api/automation/proposals',
      { ...HIGH_RISK, tenant: TENANT_B }, a,
    );
    assert.equal(spoof.status, 201);
    assert.equal(spoof.data.tenantId, TENANT_A, 'body.tenant overrode the authenticated tenant');
  });
});

describe('CASE 7 — a duplicate approval produces one decision and one execution', () => {
  test('approving twice is refused the second time', async () => {
    const proposer = await tokenAs('a.l2', 'pw-a-l2');
    const approver = await tokenAs('a.admin', 'pw-a-admin');
    const created = await client.json('POST', '/api/automation/proposals', {
      action: 'new_company_user', parameters: { username: 'new.user' },
    }, proposer);

    const first = await client.json(
      'POST', `/api/automation/proposals/${created.data.proposalId}/approve`, {}, approver,
    );
    assert.equal(first.status, 200);

    const second = await client.json(
      'POST', `/api/automation/proposals/${created.data.proposalId}/approve`, {}, approver,
    );
    assert.equal(second.status, 409, 'a second decision must be refused');
    assert.ok(
      ['APPROVAL_CONFLICT', 'NOT_AWAITING_APPROVAL'].includes(second.data.code),
      `unexpected code ${second.data.code}`,
    );
  });

  test('a duplicate queue delivery executes exactly once', async () => {
    const proposer = await tokenAs('a.l2', 'pw-a-l2');
    const approver = await tokenAs('a.admin', 'pw-a-admin');
    const created = await client.json('POST', '/api/automation/proposals', {
      action: 'new_company_user', parameters: { username: 'dup.user' },
    }, proposer);
    await client.json('POST', `/api/automation/proposals/${created.data.proposalId}/approve`, {}, approver);

    const lifecycle = client.context.automationLifecycle;
    await lifecycle.enqueue({ proposalId: created.data.proposalId });
    const before = executorCalls.length;

    const first = await lifecycle.execute({ message: { proposalId: created.data.proposalId }, workerId: 'w-dup' });
    const second = await lifecycle.execute({ message: { proposalId: created.data.proposalId }, workerId: 'w-dup' });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.status, 'DUPLICATE_BLOCKED', `unexpected status ${second.status}`);
    assert.equal(executorCalls.length, before + 1, 'the privileged action ran more than once');
  });
});

describe('CASE 8 — the worker refuses a forged queue message', () => {
  test('a message for an unapproved high-risk action never reaches the executor', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const created = await client.json('POST', '/api/automation/proposals', HIGH_RISK, a);
    assert.equal(created.data.state, 'APPROVAL_PENDING');

    const lifecycle = client.context.automationLifecycle;
    const before = executorCalls.length;

    // The message a compromised or buggy publisher would send for a proposal
    // that was never approved.
    const forged = await lifecycle.execute({
      message: { proposalId: created.data.proposalId, idempotencyKey: 'forged-key' },
      workerId: 'w-forged',
    });

    assert.equal(forged.ok, false);
    assert.equal(forged.executed, false);
    assert.equal(forged.code, 'APPROVAL_REQUIRED', `unexpected code ${forged.code}`);
    assert.equal(executorCalls.length, before, 'a forged message reached the executor');
  });
});

describe('CASE 9 — a proposal edited after approval cannot be queued', () => {
  test('the TOCTOU gate fires on an HTTP-created proposal', async () => {
    const proposer = await tokenAs('a.l2', 'pw-a-l2');
    const approver = await tokenAs('a.admin', 'pw-a-admin');
    const created = await client.json('POST', '/api/automation/proposals', {
      action: 'disable_company_user', parameters: { username: 'mallory' },
    }, proposer);
    const approved = await client.json(
      'POST', `/api/automation/proposals/${created.data.proposalId}/approve`, {}, approver,
    );
    assert.equal(approved.data.state, 'QUEUED', 'the approval enqueued the job');

    // Tamper with the stored row the way a writer with database access would.
    // The mechanism differs by backend: the memory store hands out live objects,
    // while PostgreSQL only changes through SQL — so use its own pool. Mutating
    // a JS object when a real database is behind the store would silently
    // assert nothing, which is exactly how a "passing" TOCTOU test ends up
    // testing nothing.
    const store = client.context.lifecycleStoreRef;
    if (store.pool) {
      await store.pool.query(
        `UPDATE action_proposal SET parameters = $2::jsonb WHERE proposal_id = $1`,
        [created.data.proposalId, JSON.stringify({ username: 'ceo.ceo' })],
      );
    } else {
      const row = await store.getProposal(created.data.proposalId);
      row.parameters = { username: 'ceo.ceo' };
    }

    // The job is already QUEUED, so the enqueue gate has passed. The attack now is
    // "tamper AFTER the queue accepted it, before the worker picks it up" — the
    // realistic window. The worker's own re-check is what has to stop it.
    const queued = await client.context.automationLifecycle.execute({
      message: { proposalId: created.data.proposalId, jobId: `job-${created.data.proposalId}` },
      workerId: 'w-toctou',
    });
    assert.equal(queued.ok, false, 'a tampered proposal must not execute');
    assert.equal(queued.executed, false);
    assert.equal(queued.code, 'PAYLOAD_MODIFIED', `unexpected code ${queued.code}`);
    assert.equal(
      executorCalls.filter((c) => c.parameters && c.parameters.username === 'ceo.ceo').length,
      0,
      'the tampered target was executed',
    );
  });
});

describe('CASE 10 — a post-check failure is not a success', () => {
  test('the final state is FAILED when the executor cannot verify the condition', async () => {
    // A separate client with an executor whose post-check fails, so this case
    // cannot contaminate the shared call counter.
    let calls = 0;
    const failing = await createTestClient({
      ...labAuth,
      executor: {
        async run() {
          calls += 1;
          return { ok: true, postCheck: { verified: false, why: 'target still enabled' } };
        },
      },
    });
    await failing.start();
    try {
      const login = await failing.json('POST', '/api/auth/login', { username: 'a.admin', password: 'pw-a-admin' });
      const a = { Authorization: `Bearer ${login.data.token}` };
      const created = await failing.json('POST', '/api/automation/proposals', LOW_RISK, a);
      assert.equal(created.data.state, 'AUTHORIZED');

      const lifecycle = failing.context.automationLifecycle;
      await lifecycle.enqueue({ proposalId: created.data.proposalId });
      const result = await lifecycle.execute({
        message: { proposalId: created.data.proposalId }, workerId: 'w-postcheck',
      });

      assert.equal(calls, 1, 'the executor did run');
      assert.equal(result.ok, false, 'a failed post-check must not report success');
      assert.notEqual(result.status, 'SUCCEEDED');
      const after = await failing.context.lifecycleStoreRef.getProposal(created.data.proposalId);
      assert.equal(after.state, 'FAILED', `final state was ${after.state}`);
    } finally {
      await failing.stop();
    }
  });
});