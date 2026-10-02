'use strict';

/**
 * TOCTOU binding — approval must bind to the exact payload that will run.
 *
 * The attack this file closes:
 *
 *   1. attacker submits a HIGH_RISK proposal that looks acceptable
 *   2. an approver approves it
 *   3. the proposal payload is swapped (target user, parameters, action)
 *   4. the job is queued and executed
 *
 * Step 3 is the dangerous one: approval then authorises something nobody looked
 * at. The defense is a canonical-JSON SHA-256 over `{action, parameters}`
 * written at creation, copied onto the approval row, and re-verified BOTH before
 * queueing and again in the worker before the executor is reached.
 *
 * Every test here is a negative control: it asserts that a mutation of the
 * proposal produces a REFUSAL with a stable code, and that the executor was
 * never called. The last test in each block is the positive case, because a
 * gate that blocks everything would also pass the negative ones.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createActionLifecycle } = require('../src/action-lifecycle');
const { createMemoryLifecycleStore } = require('../src/lifecycle-store-memory');
const catalog = require('../src/action-catalog');

const ADMIN = { username: 'tan.admin', role: 'IT_ADMIN', authenticated: true };
const APPROVER = { username: 'linh.approver', role: 'IT_ADMIN', authenticated: true };
const TENANT = 'tenant-a';

function fakeExecutor() {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      return { ok: true, postCheck: { verified: true } };
    },
  };
}

function build() {
  const store = createMemoryLifecycleStore({});
  const executor = fakeExecutor();
  const lifecycle = createActionLifecycle({ store, executor });
  return { store, executor, lifecycle };
}

/** A HIGH_RISK proposal that requires approval: disable_company_user. */
async function proposeHighRisk(lifecycle, parameters = { username: 'mallory' }) {
  return lifecycle.propose({
    actor: ADMIN,
    tenantId: TENANT,
    proposal: { action: 'disable_company_user', parameters, reason: 'suspicious activity' },
  });
}

describe('payload hash — the fingerprint itself', () => {
  test('key order does not change the hash (canonical JSON)', () => {
    const a = catalog.proposalPayloadHash({ action: 'x', parameters: { one: 1, two: { three: 3, four: 4 } } });
    const b = catalog.proposalPayloadHash({ action: 'x', parameters: { two: { four: 4, three: 3 }, one: 1 } });
    assert.equal(a, b, 'reordering keys must not invalidate an approval');
  });

  test('changing the action changes the hash', () => {
    const a = catalog.proposalPayloadHash({ action: 'x', parameters: {} });
    const b = catalog.proposalPayloadHash({ action: 'y', parameters: {} });
    assert.notEqual(a, b);
  });

  test('changing a nested parameter changes the hash', () => {
    const a = catalog.proposalPayloadHash({ action: 'x', parameters: { users: ['a', 'b'] } });
    const b = catalog.proposalPayloadHash({ action: 'x', parameters: { users: ['a', 'c'] } });
    assert.notEqual(a, b);
  });

  test('NEGATIVE CONTROL: a missing or empty hash never matches', () => {
    const p = { action: 'x', parameters: {} };
    assert.equal(catalog.payloadHashMatches('', p), false);
    assert.equal(catalog.payloadHashMatches(undefined, p), false);
    assert.equal(catalog.payloadHashMatches('not-a-hash', p), false);
  });

  test('descriptive fields are outside the fingerprint on purpose', () => {
    // Changing the reason must NOT invalidate an approval — the approver signed
    // what runs, not the wording. If this ever flips, approvals become brittle.
    const a = catalog.proposalPayloadHash({ action: 'x', parameters: { p: 1 }, reason: 'first' });
    const b = catalog.proposalPayloadHash({ action: 'x', parameters: { p: 1 }, reason: 'second' });
    assert.equal(a, b);
  });
});
describe('TOCTOU — a high-risk proposal cannot be edited after approval', () => {
  test('the approval records the hash of the payload it signed', async () => {
    const { lifecycle, store } = build();
    const proposed = await proposeHighRisk(lifecycle);
    const decided = await lifecycle.decide({
      proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED',
    });

    assert.equal(decided.ok, true);
    const approval = await store.getApproval(proposed.proposalId);
    const stored = await store.getProposal(proposed.proposalId);

    assert.ok(approval.approvedPayloadHash, 'the approval must carry the signed hash');
    assert.equal(approval.approvedPayloadHash, stored.payloadHash);
    assert.equal(catalog.payloadHashMatches(approval.approvedPayloadHash, stored), true);
  });

  test('EDIT AFTER APPROVAL: enqueue refuses and nothing is queued', async () => {
    const { lifecycle, store } = build();
    const proposed = await proposeHighRisk(lifecycle, { username: 'mallory' });
    await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });

    // The swap: a different victim.
    const row = await store.getProposal(proposed.proposalId);
    row.parameters = { username: 'ceo.ceo' };

    const queued = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    assert.equal(queued.ok, false);

    // The SPECIFIC code matters. enqueue() has two independent TOCTOU checks:
    // the payload no longer matching what was recorded (PAYLOAD_MODIFIED), and
    // it no longer matching what the approver signed
    // (APPROVAL_PAYLOAD_MISMATCH). Asserting the union of both made this test
    // pass while the first check was deleted — the mutation then SURVIVED.
    // Pinning the exact code is what gives the check teeth.
    assert.equal(queued.code, 'PAYLOAD_MODIFIED', `expected the recorded-hash check to fire, got ${queued.code}`);

    const after = await store.getProposal(proposed.proposalId);
    assert.notEqual(after.state, 'QUEUED', 'the proposal must not have been queued');
  });

  test('EDIT AFTER APPROVAL: the approval hash also blocks a queued-but-changed job', async () => {
    // Covers the SECOND enqueue check. Here the proposal's own recorded hash is
    // rewritten to match the tampered payload — so only the approval's signed
    // hash can catch it. This is the strongest form of the attack: the tamperer
    // can reach the proposal row, and only the immutable approval stands.
    const { lifecycle, store } = build();
    const proposed = await proposeHighRisk(lifecycle, { username: 'mallory' });
    await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });

    const row = await store.getProposal(proposed.proposalId);
    row.parameters = { username: 'ceo.ceo' };
    row.payloadHash = catalog.proposalPayloadHash(row); // tamperer repairs the self-consistency

    const queued = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    assert.equal(queued.ok, false);
    assert.equal(queued.code, 'APPROVAL_PAYLOAD_MISMATCH', `expected the approved-hash check to fire, got ${queued.code}`);
    assert.notEqual((await store.getProposal(proposed.proposalId)).state, 'QUEUED');
  });

  test('EDIT AFTER APPROVAL: the worker refuses even when a job is already queued', async () => {
    const { lifecycle, store, executor } = build();
    const proposed = await proposeHighRisk(lifecycle, { username: 'mallory' });
    await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });

    // Force the state to QUEUED directly — simulating a job published before the
    // payload was swapped, or a hostile queue writer.
    const row = await store.getProposal(proposed.proposalId);
    row.state = 'QUEUED';
    row.parameters = { username: 'ceo.ceo' };

    const result = await lifecycle.execute({
      message: { proposalId: proposed.proposalId }, workerId: 'w1',
    });

    assert.equal(result.ok, false);
    assert.equal(result.executed, false);
    // Exact code, not a union: execute() re-checks BOTH the recorded hash and
    // the approval's signed hash. The recorded-hash check is what fires here.
    assert.equal(result.code, 'PAYLOAD_MODIFIED', `unexpected code ${result.code}`);
    assert.equal(executor.calls.length, 0, 'the executor must never be reached');
  });

  test('an UNCHANGED proposal still executes — the gate discriminates', async () => {
    // A gate that blocks everything would also pass the tests above. This is the
    // positive case proving the check is not simply "always refuse".
    const { lifecycle, executor } = build();
    const proposed = await proposeHighRisk(lifecycle, { username: 'mallory' });
    await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });

    const queued = await lifecycle.enqueue({ proposalId: proposed.proposalId });
    assert.equal(queued.ok, true, 'an untouched approved proposal must still be queueable');

    const result = await lifecycle.execute({ message: { proposalId: proposed.proposalId }, workerId: 'w1' });
    assert.equal(result.ok, true, 'an untouched approved proposal must still execute');
    assert.equal(executor.calls.length, 1);
  });
});
describe('TOCTOU — the worker does not trust the queue message', () => {
  test('NEGATIVE CONTROL: an action outside the catalog is refused', async () => {
    const { lifecycle, executor } = build();

    // First through the public API, which must refuse it.
    const proposed = await lifecycle.propose({
      actor: ADMIN,
      tenantId: TENANT,
      proposal: { action: 'rm_rf_slash', parameters: {} },
    });
    assert.equal(proposed.ok, false, 'propose() must reject an action outside the catalog');
    assert.equal(proposed.code, 'UNKNOWN_ACTION');
    assert.equal(executor.calls.length, 0);
  });

  test('NEGATIVE CONTROL: a high-risk job with no approval row is refused', async () => {
    const { lifecycle, store, executor } = build();

    // Plant a row the way a compromised queue writer or DB holder could: a
    // HIGH_RISK proposal forced straight to QUEUED with no decision recorded.
    const created = await store.createProposal({
      tenantId: TENANT, action: 'disable_company_user', parameters: { username: 'mallory' },
      risk: 'HIGH_RISK', requestedBy: 'attacker', requestedByRole: 'IT_ADMIN',
      correlationId: 'corr-noapproval',
    });
    const row = await store.getProposal(created.proposalId);
    row.state = 'QUEUED';

    const result = await lifecycle.execute({ message: { proposalId: created.proposalId }, workerId: 'w1' });
    assert.equal(result.ok, false);
    assert.equal(result.executed, false);
    // Exact code: the whole point is that the worker refuses for the MISSING
    // APPROVAL, not incidentally for some other reason.
    assert.equal(result.code, 'APPROVAL_REQUIRED', `unexpected code ${result.code}`);
    assert.equal(executor.calls.length, 0, 'the executor must never be reached');
  });

  test('NEGATIVE CONTROL: a REJECTED approval does not authorise execution', async () => {
    const { lifecycle, store, executor } = build();
    const proposed = await proposeHighRisk(lifecycle);
    await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'REJECTED' });

    // The hostile-writer case: force it to QUEUED anyway.
    const row = await store.getProposal(proposed.proposalId);
    row.state = 'QUEUED';

    const result = await lifecycle.execute({ message: { proposalId: proposed.proposalId }, workerId: 'w1' });
    assert.equal(result.ok, false);
    assert.equal(executor.calls.length, 0);
  });

  test('NEGATIVE CONTROL: a row planted with an out-of-catalog action never reaches the executor', async () => {
    // The catalog check in the worker guards against a different threat than the
    // propose() schema check: a row that reached the database WITHOUT going
    // through propose() — a compromised queue writer, a stale row from an older
    // catalog, or a direct database edit. propose() cannot produce such a row,
    // so this test plants one the way that writer would.
    const { lifecycle, store, executor } = build();
    const created = await store.createProposal({
      tenantId: TENANT, action: 'delete_everything', parameters: { path: '/' },
      risk: 'HIGH_RISK', requestedBy: 'attacker', requestedByRole: 'IT_ADMIN',
      correlationId: 'corr-outofcatalog',
    });
    const row = await store.getProposal(created.proposalId);
    row.state = 'QUEUED';

    const result = await lifecycle.execute({ message: { proposalId: created.proposalId }, workerId: 'w1' });
    assert.equal(result.ok, false);
    assert.equal(result.executed, false);
    // Exact code: the refusal must name the catalog, not some downstream state
    // error, or the catalog check itself would be removable without effect.
    assert.equal(result.code, 'UNKNOWN_ACTION', `unexpected code ${result.code}`);
    assert.equal(executor.calls.length, 0, 'an out-of-catalog action must never be executed');

    const events = await store.listAudit({ proposalId: created.proposalId });
    assert.ok(events.some((e) => e.event === 'DENIED'), 'the refusal must be audited');
  });

  test('the refusal is audited, not silent', async () => {
    const { lifecycle, store, executor } = build();
    const created = await store.createProposal({
      tenantId: TENANT, action: 'disable_company_user', parameters: { username: 'mallory' },
      risk: 'HIGH_RISK', requestedBy: 'attacker', requestedByRole: 'IT_ADMIN',
      correlationId: 'corr-audit',
    });
    const row = await store.getProposal(created.proposalId);
    row.state = 'QUEUED';

    await lifecycle.execute({ message: { proposalId: created.proposalId }, workerId: 'w-auditor' });
    const events = await store.listAudit({ proposalId: created.proposalId });
    const denial = events.find((e) => e.event === 'DENIED');
    assert.ok(denial, 'a refused execution must leave an audit record');
    assert.equal(denial.actor, 'w-auditor');
    assert.equal(executor.calls.length, 0);
  });
});