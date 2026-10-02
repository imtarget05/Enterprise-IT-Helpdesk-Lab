'use strict';

/**
 * Governed action lifecycle — behavioral tests.
 *
 * Every security invariant has (a) a positive test and (b) a negative control
 * that plants the violation and asserts it is caught. A green suite that would
 * also pass with the guard removed is not evidence, so `describe` blocks below
 * name the invariant they protect.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const catalog = require('../src/action-catalog');
const { createActionLifecycle, classifyFailure, redact } = require('../src/action-lifecycle');
const { createMemoryLifecycleStore } = require('../src/lifecycle-store-memory');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ADMIN = { username: 'tan.admin', role: 'IT_ADMIN', authenticated: true };
const APPROVER = { username: 'linh.approver', role: 'IT_ADMIN', authenticated: true };
const L2 = { username: 'nam.l2', role: 'HELPDESK_L2', authenticated: true };
const VIEWER = { username: 'khoa.viewer', role: 'VIEWER', authenticated: true };

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-test-'));
  return path.join(dir, name);
}

/** Deterministic fake executor: counts invocations, never shells out. */
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

function build(options = {}) {
  const store = createMemoryLifecycleStore({ file: options.file });
  const executor = options.executor || fakeExecutor();
  const lifecycle = createActionLifecycle({ store, executor, ...options.lifecycle });
  return { store, executor, lifecycle };
}

async function proposeLowRisk(lifecycle, actor = ADMIN) {
  return lifecycle.propose({
    actor,
    tenantId: 'tenant-a',
    correlationId: 'corr-low',
    proposal: { action: 'export_it_asset_audit', parameters: {} },
  });
}

async function proposeHighRisk(lifecycle, actor = ADMIN) {
  return lifecycle.propose({
    actor,
    tenantId: 'tenant-a',
    correlationId: 'corr-high',
    proposal: { action: 'disable_company_user', parameters: { username: 'test-user' } },
  });
}

// ---------------------------------------------------------------------------
// Catalog parity — the Node policy must not drift from the Python gateway.
// ---------------------------------------------------------------------------
describe('action catalog parity', () => {
  test('Node ACTION_RISK matches llm-gateway/automation/policy.py exactly', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'llm-gateway', 'automation', 'policy.py'), 'utf8');
    const block = source.match(/ACTION_RISK\s*=\s*\{([\s\S]*?)\n\}/);
    assert.ok(block, 'ACTION_RISK block not found in policy.py');
    const python = {};
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*"([a-z_]+)":\s*(READ_ONLY|LOW_RISK|HIGH_RISK)\s*,?\s*$/);
      if (m) python[m[1]] = m[2];
    }
    assert.ok(Object.keys(python).length >= 8, 'parsed too few Python actions');
    assert.deepEqual(catalog.ACTION_RISK, python, 'Node and Python risk catalogs diverge');
  });

  test('Node catalog covers exactly the Python SUPPORTED_ACTIONS', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'llm-gateway', 'automation', 'models.py'), 'utf8');
    const block = source.match(/SUPPORTED_ACTIONS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/);
    assert.ok(block, 'SUPPORTED_ACTIONS not found in models.py');
    const python = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(Object.keys(catalog.ACTION_RISK).sort(), python);
  });

  test('raw-command fields are rejected and never accepted as parameters', () => {
    for (const field of catalog.RAW_COMMAND_FIELDS) {
      const result = catalog.validateProposal({ action: 'disable_company_user', [field]: 'Remove-ADUser *' });
      assert.equal(result.ok, false, `${field} must be rejected`);
      assert.equal(result.code, 'INVALID');
    }
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: unauthorized_privileged_execution = 0
// ---------------------------------------------------------------------------
describe('propose — authorization is deterministic', () => {
  test('low-risk action is auto-authorized and needs no approval', async () => {
    const { lifecycle } = build();
    const result = await proposeLowRisk(lifecycle);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'ALLOWED');
    assert.equal(result.risk, 'LOW_RISK');
    assert.equal(result.proposal.state, 'AUTHORIZED');
    assert.equal((await lifecycle.auditTrail(result.proposalId)).length, 2);
  });

  test('high-risk action parks at APPROVAL_PENDING and is not queueable', async () => {
    const { lifecycle } = build();
    const result = await proposeHighRisk(lifecycle);
    assert.equal(result.status, 'NEEDS_APPROVAL');
    assert.equal(result.proposal.state, 'APPROVAL_PENDING');
    const queued = await lifecycle.enqueue({ proposalId: result.proposalId });
    assert.equal(queued.ok, false);
    assert.equal(queued.code, 'NOT_QUEUEABLE');
  });

  test('a hidden command field makes the whole proposal INVALID (no row created)', async () => {
    const { lifecycle, store } = build();
    const result = await lifecycle.propose({
      actor: ADMIN,
      tenantId: 'tenant-a',
      proposal: { action: 'disable_company_user', parameters: { username: 'x' }, powershell: 'Remove-ADUser *' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID');
    const raw = await store._raw();
    assert.equal(Object.keys(raw.proposals).length, 0, 'invalid proposal must not be persisted');
    const audit = await store.listAudit({});
    assert.equal(audit.length, 1);
    assert.equal(audit[0].event, 'DENIED');
  });

  test('unknown action id is rejected, not coerced', async () => {
    const { lifecycle } = build();
    const result = await lifecycle.propose({
      actor: ADMIN, tenantId: 'tenant-a',
      proposal: { action: 'run_arbitrary_powershell', parameters: {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNKNOWN_ACTION');
  });

  test('unauthenticated actor is denied', async () => {
    const { lifecycle } = build();
    const result = await lifecycle.propose({
      actor: { username: 'nobody', role: 'IT_ADMIN', authenticated: false },
      tenantId: 'tenant-a',
      proposal: { action: 'backup_helpdesk_data', parameters: {} },
    });
    assert.equal(result.code, 'UNAUTHENTICATED');
  });

  test('roles that may not propose automation are denied', async () => {
    const { lifecycle } = build();
    for (const role of ['VIEWER', 'AUDITOR', 'HELPDESK_L1', 'INTEGRATION_MINIERP']) {
      const result = await lifecycle.propose({
        actor: { username: `u.${role}`, role, authenticated: true },
        tenantId: 'tenant-a',
        proposal: { action: 'backup_helpdesk_data', parameters: {} },
      });
      assert.equal(result.code, 'UNAUTHORIZED', `${role} must not propose`);
    }
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: high_risk_execution_without_approval = 0
// ---------------------------------------------------------------------------
describe('approval — append-only, separation of duties, durable', () => {
  test('the proposer cannot approve their own action', async () => {
    const { lifecycle, store } = build();
    const proposed = await proposeHighRisk(lifecycle, ADMIN);
    const decision = await lifecycle.decide({
      proposalId: proposed.proposalId, actor: { ...ADMIN }, decision: 'APPROVED',
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'SELF_APPROVAL_FORBIDDEN');
    assert.equal(await store.getApproval(proposed.proposalId), null, 'no approval row may be written');
    assert.equal((await store.getProposal(proposed.proposalId)).state, 'APPROVAL_PENDING');
  });

  test('a role without approval authority cannot decide', async () => {
    const { lifecycle } = build();
    const proposed = await proposeHighRisk(lifecycle);
    const decision = await lifecycle.decide({ proposalId: proposed.proposalId, actor: L2, decision: 'APPROVED' });
    assert.equal(decision.code, 'UNAUTHORIZED_APPROVER');
  });

  test('a second administrator can approve and the decision is recorded', async () => {
    const { lifecycle, store } = build();
    const proposed = await proposeHighRisk(lifecycle);
    const decision = await lifecycle.decide({
      proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED', reason: 'verified with requester',
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.proposal.state, 'APPROVED');
    const approval = await store.getApproval(proposed.proposalId);
    assert.equal(approval.decision, 'APPROVED');
    assert.equal(approval.approver, 'linh.approver');
    assert.equal(approval.isSelfApproval, false);
  });

  test('a decision is append-only: a later decision is refused', async () => {
    const { lifecycle } = build();
    const proposed = await proposeHighRisk(lifecycle);
    await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'REJECTED' });
    const second = await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });
    assert.equal(second.ok, false);
    assert.ok(['ALREADY_DECIDED', 'NOT_AWAITING_APPROVAL'].includes(second.code), second.code);
  });

  test('a rejected proposal can never be queued or executed', async () => {
    const { lifecycle, executor } = build();
    const proposed = await proposeHighRisk(lifecycle);
    await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'REJECTED' });
    assert.equal((await lifecycle.enqueue({ proposalId: proposed.proposalId })).code, 'NOT_QUEUEABLE');
    const executed = await lifecycle.execute({ message: { proposalId: proposed.proposalId }, workerId: 'w1' });
    assert.equal(executed.code, 'WRONG_STATE');
    assert.equal(executor.calls.length, 0, 'no executor call may happen for a rejected action');
  });

  test('NEGATIVE CONTROL: a queued high-risk action with no approval row is blocked at the gate', async () => {
    const { lifecycle, store, executor } = build();
    const proposed = await proposeHighRisk(lifecycle);
    // Simulate a legacy/hostile queue message: proposal forced to QUEUED while no
    // approval row exists (e.g. written before the approval feature existed).
    const raw = await store._raw();
    raw.proposals[proposed.proposalId].state = 'QUEUED';
    const executed = await lifecycle.execute({ message: { proposalId: proposed.proposalId }, workerId: 'w1' });
    assert.equal(executed.ok, false);
    assert.equal(executed.code, 'APPROVAL_REQUIRED');
    assert.equal(executor.calls.length, 0, 'high-risk work must not run without approval');
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: duplicate_privileged_execution = 0
// ---------------------------------------------------------------------------
describe('execute — idempotency, post-check, bounded retry', () => {
  test('low-risk path: queue then execute once, ending POSTCHECKED', async () => {
    const { lifecycle, executor } = build();
    const proposed = await proposeLowRisk(lifecycle);
    const queued = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    assert.equal(queued.message.actionId, 'export_it_asset_audit');
    const executed = await lifecycle.execute({ message: queued.message, workerId: 'w1' });
    assert.equal(executed.status, 'SUCCEEDED');
    assert.equal(executor.calls.length, 1);
  });

  test('NEGATIVE CONTROL: two simultaneous deliveries execute exactly once', async () => {
    const { lifecycle, executor } = build();
    const proposed = await proposeLowRisk(lifecycle);
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });

    // Two workers, two replicas, same message — the real at-least-once scenario.
    const [a, b] = await Promise.all([
      lifecycle.execute({ message, workerId: 'replica-a' }),
      lifecycle.execute({ message, workerId: 'replica-b' }),
    ]);

    assert.equal(executor.calls.length, 1, 'privileged side effect must happen exactly once');
    const loser = a.status === 'SUCCEEDED' ? b : a;
    const winner = a.status === 'SUCCEEDED' ? a : b;
    assert.equal(winner.status, 'SUCCEEDED');
    // Both labels mean "do not execute again": IN_FLIGHT when the loser saw the
    // claim while it was still running, DUPLICATE_BLOCKED once it had finished.
    assert.ok(['DUPLICATE_BLOCKED', 'IN_FLIGHT'].includes(loser.status), loser.status);
    assert.equal(loser.executed, false);
    assert.equal(loser.duplicate, true);
  });

  test('NEGATIVE CONTROL: a re-delivery after success is blocked', async () => {
    const { lifecycle, executor } = build();
    const proposed = await proposeLowRisk(lifecycle);
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    await lifecycle.execute({ message, workerId: 'w1' });
    const replay = await lifecycle.execute({ message, workerId: 'w1' });
    assert.equal(replay.status, 'DUPLICATE_BLOCKED');
    assert.equal(replay.duplicate, true);
    assert.equal(executor.calls.length, 1);
  });

  test('DURABILITY: approval + idempotency survive a process restart (file-backed store)', async () => {
    const file = tmpFile('lifecycle.json');

    // --- process 1: propose (high risk) and approve
    const first = build({ file });
    const proposed = await proposeHighRisk(first.lifecycle);
    await first.lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });

    // --- crash: a brand-new store instance reads the same durable state
    const second = build({ file });
    const reloaded = await second.store.getProposal(proposed.proposalId);
    assert.equal(reloaded.state, 'APPROVED', 'approval must survive restart');
    const approval = await second.store.getApproval(proposed.proposalId);
    assert.equal(approval.decision, 'APPROVED');

    const { message } = await second.lifecycle.enqueue({ proposalId: proposed.proposalId });
    const executed = await second.lifecycle.execute({ message, workerId: 'w-after-restart' });
    assert.equal(executed.status, 'SUCCEEDED');

    // the ORIGINAL message, replayed against a THIRD instance, must not re-execute
    const third = build({ file });
    const replay = await third.lifecycle.execute({ message, workerId: 'w-replay' });
    assert.equal(replay.status, 'DUPLICATE_BLOCKED');
    assert.equal(third.executor.calls.length, 0, 'replay after restart must not touch the executor');
  });

  test('a failed post-check is not a success', async () => {
    const executor = fakeExecutor(() => ({ ok: true, postCheck: false }));
    const { lifecycle, store } = build({ executor });
    const proposed = await proposeLowRisk(lifecycle);
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    const executed = await lifecycle.execute({ message, workerId: 'w1' });
    assert.equal(executed.status, 'POSTCHECK_FAILED');
    assert.equal(executed.ok, false);
    assert.equal((await store.getProposal(proposed.proposalId)).state, 'FAILED');
  });
});

// ---------------------------------------------------------------------------
// Bounded retry → dead letter (CORE-8), and failure classification
// ---------------------------------------------------------------------------
describe('failure handling — transient vs permanent, bounded attempts', () => {
  test('a transient failure asks for retry within budget', async () => {
    const executor = fakeExecutor((_req, n) => {
      if (n === 1) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return { ok: true, postCheck: { verified: true } };
    });
    const { lifecycle } = build({ executor });
    const proposed = await proposeLowRisk(lifecycle);
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });

    const first = await lifecycle.execute({ message, workerId: 'w1', attempt: 1 });
    assert.equal(first.status, 'FAILED');
    assert.equal(first.retry, true);

    const second = await lifecycle.execute({ message, workerId: 'w1', attempt: 2 });
    assert.equal(second.status, 'SUCCEEDED', 'the retry must resume the same execution');
    assert.equal(executor.calls.length, 2);
  });

  test('a transient failure at the attempt ceiling is dead-lettered', async () => {
    const executor = fakeExecutor(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    const { lifecycle, store } = build({ executor, lifecycle: { maxAttempts: 3 } });
    const proposed = await proposeLowRisk(lifecycle);
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });

    const result = await lifecycle.execute({ message, workerId: 'w1', attempt: 3 });
    assert.equal(result.status, 'DEAD_LETTERED');
    const audit = await store.listAudit({ proposalId: proposed.proposalId });
    assert.ok(audit.some((e) => e.event === 'DEAD_LETTERED'), 'DLQ outcome must be audited');
  });

  test('a permanent failure never retries', async () => {
    const executor = fakeExecutor(() => { throw Object.assign(new Error('bad request'), { status: 400 }); });
    const { lifecycle } = build({ executor });
    const proposed = await proposeLowRisk(lifecycle);
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    const result = await lifecycle.execute({ message, workerId: 'w1', attempt: 1 });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.retry, false);
  });

  test('classifyFailure separates transient from permanent', () => {
    assert.equal(classifyFailure({ code: 'ETIMEDOUT' }).retryable, true);
    assert.equal(classifyFailure({ status: 503 }).retryable, true);
    assert.equal(classifyFailure({ status: 400 }).retryable, false);
    assert.equal(classifyFailure(new Error('boom')).retryable, false);
  });
});

// ---------------------------------------------------------------------------
// Executor authority, audit integrity, state machine
// ---------------------------------------------------------------------------
describe('executor authority and audit integrity', () => {
  test('NEGATIVE CONTROL: a forged persisted role cannot gain execution authority', async () => {
    const { lifecycle, store, executor } = build();
    const proposed = await proposeLowRisk(lifecycle);
    await lifecycle.enqueue({ proposalId: proposed.proposalId });
    // Hostile/legacy row: the recorded proposer role is not allowed to automate.
    const raw = await store._raw();
    raw.proposals[proposed.proposalId].requestedByRole = 'VIEWER';
    const executed = await lifecycle.execute({
      message: { proposalId: proposed.proposalId }, workerId: 'w1',
    });
    assert.equal(executed.code, 'UNAUTHORIZED_PROPOSAL');
    assert.equal(executor.calls.length, 0);
  });

  test('the queue message carries identifiers only — no command, no parameters', async () => {
    const { lifecycle } = build();
    const proposed = await proposeLowRisk(lifecycle);
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    assert.deepEqual(Object.keys(message).sort(), [
      'actionId', 'attempt', 'correlationId', 'idempotencyKey', 'proposalId', 'queuedAt', 'risk', 'tenantId',
    ]);
    for (const field of catalog.RAW_COMMAND_FIELDS) {
      assert.equal(Object.prototype.hasOwnProperty.call(message, field), false);
    }
  });

  test('the audit trail covers the full lifecycle in order', async () => {
    const { lifecycle } = build();
    const proposed = await proposeHighRisk(lifecycle);
    await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    await lifecycle.execute({ message, workerId: 'w1' });
    const events = (await lifecycle.auditTrail(proposed.proposalId)).map((e) => e.event);
    assert.deepEqual(
      events.filter((e) => e !== 'STARTED'),
      ['PROPOSED', 'APPROVAL_REQUESTED', 'APPROVED', 'QUEUED', 'SUCCEEDED', 'POSTCHECKED'],
    );
    assert.ok(events.includes('STARTED'));
  });

  test('NEGATIVE CONTROL: audit rows never contain credential-shaped values', async () => {
    const secret = 'SuperSecretPassword=Pa55w0rd-abcdef123456';
    const executor = fakeExecutor(() => { throw Object.assign(new Error(`auth failed ${secret}`), { status: 400 }); });
    const { lifecycle, store } = build({ executor });
    const proposed = await proposeLowRisk(lifecycle);
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    await lifecycle.execute({ message, workerId: 'w1' });

    const serialised = JSON.stringify(await store.listAudit({ proposalId: proposed.proposalId }));
    assert.equal(serialised.includes(secret), false, 'secret leaked into the audit ledger');
    assert.equal(serialised.includes('Pa55w0rd-abcdef123456'), false);
  });

  test('redact() masks secret-looking keys and values, keeping structure', () => {
    const input = { username: 'test-user', password: 'p@ss', nested: { api_key: 'k', ok: 'fine' } };
    assert.deepEqual(redact(input), {
      username: 'test-user', password: '[redacted]', nested: { api_key: '[redacted]', ok: 'fine' },
    });
  });

  test('the state machine refuses illegal transitions', () => {
    assert.throws(() => catalog.assertTransition('REJECTED', 'QUEUED'), /illegal transition/);
    assert.throws(() => catalog.assertTransition('APPROVAL_PENDING', 'EXECUTING'), /illegal transition/);
    assert.throws(() => catalog.assertTransition('POSTCHECKED', 'QUEUED'), /illegal transition/);
    assert.equal(catalog.assertTransition('APPROVED', 'QUEUED'), true);
    assert.equal(catalog.isTerminal('REJECTED'), true);
  });

  test('an unknown proposal id is a poison message, not a crash', async () => {
    const { lifecycle, executor } = build();
    const result = await lifecycle.execute({
      message: { proposalId: '00000000-0000-0000-0000-000000000000' }, workerId: 'w1',
    });
    assert.equal(result.status, 'POISON');
    assert.equal(executor.calls.length, 0);
  });
});