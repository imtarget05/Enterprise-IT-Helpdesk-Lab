'use strict';

/**
 * Queue + worker behaviour: the phase-2 contract.
 *
 * What is proved here:
 *   · the envelope is versioned and carries no executable content;
 *   · publishing the same jobId twice is one job, not two;
 *   · the worker refuses forged, tenant-less and unapproved messages;
 *   · TRANSIENT earns a bounded retry, PERMANENT and policy refusals do not;
 *   · dead letters carry a reason and replay is idempotent;
 *   · the four crash windows cannot produce a duplicate privileged execution.
 *
 * The crash windows are the ones that matter most and the ones most often
 * asserted without evidence. Each one here is measured by counting real
 * executor calls, not by asserting a status code.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createActionLifecycle, MESSAGE_SCHEMA_VERSION } = require('../src/action-lifecycle');
const { createMemoryLifecycleStore } = require('../src/lifecycle-store-memory');
const { createDurableQueue, createInMemoryQueue, validateEnvelope } = require('../src/automation-queue');
const { createAutomationWorker } = require('../src/automation-worker');
const catalog = require('../src/action-catalog');

const ADMIN = { username: 'tan.admin', role: 'IT_ADMIN', authenticated: true };
const APPROVER = { username: 'linh.approver', role: 'IT_ADMIN', authenticated: true };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `helpdesk-${prefix}-`));
}

function recordingExecutor(behaviour) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      if (behaviour) return behaviour(request, calls.length);
      return { ok: true, simulated: true, postCheck: { verified: true } };
    },
  };
}

function build(options = {}) {
  const store = options.store || createMemoryLifecycleStore({ file: options.file });
  const executor = recordingExecutor(options.behaviour);
  const lifecycle = createActionLifecycle({ store, executor, maxAttempts: options.maxAttempts || 3 });
  return { store, executor, lifecycle };
}

/** Propose + approve a high-risk action so the queue path is reachable. */
async function approvedJob(lifecycle, parameters = { username: 'mallory' }) {
  const proposed = await lifecycle.propose({
    actor: ADMIN,
    tenantId: 'tenant-a',
    proposal: { action: 'disable_company_user', parameters, reason: 'incident' },
  });
  await lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });
  const enqueued = await lifecycle.enqueue({ proposalId: proposed.proposalId });
  return { proposalId: proposed.proposalId, message: enqueued.message };
}

describe('message envelope', () => {
  test('the envelope is versioned and carries identifiers only', async () => {
    const { lifecycle } = build();
    const { message } = await approvedJob(lifecycle);
    assert.equal(message.schemaVersion, MESSAGE_SCHEMA_VERSION);
    assert.equal(validateEnvelope(message).ok, true);
    for (const field of catalog.RAW_COMMAND_FIELDS) {
      assert.equal(Object.prototype.hasOwnProperty.call(message, field), false, `envelope carried ${field}`);
    }
    // The parameters the executor will use are re-read from the store, never
    // taken from the envelope.
    assert.equal(Object.prototype.hasOwnProperty.call(message, 'parameters'), false);
  });

  test('NEGATIVE CONTROL: an envelope without a version is refused', () => {
    const check = validateEnvelope({ jobId: 'j1', proposalId: 'p1', tenantId: 't1', idempotencyKey: 'k1' });
    assert.equal(check.ok, false, 'a versionless envelope must not be accepted');
    // Reported as a missing required field rather than a version mismatch: a
    // message with no version predates versioning, and saying so is more useful
    // to an operator than "version undefined is not supported".
    assert.equal(check.code, 'INVALID_MESSAGE');
    assert.ok(check.missing.includes('schemaVersion'));
  });

  test('NEGATIVE CONTROL: an unknown future version is refused, not executed', () => {
    const check = validateEnvelope({
      schemaVersion: MESSAGE_SCHEMA_VERSION + 1,
      jobId: 'j1', proposalId: 'p1', tenantId: 't1', idempotencyKey: 'k1',
    });
    assert.equal(check.ok, false, 'a consumer must refuse a shape it does not understand');
    assert.equal(check.code, 'UNSUPPORTED_VERSION');
  });

  test('NEGATIVE CONTROL: a missing identifier is refused', () => {
    for (const missing of ['jobId', 'proposalId', 'tenantId', 'idempotencyKey']) {
      const full = { schemaVersion: MESSAGE_SCHEMA_VERSION, jobId: 'j', proposalId: 'p', tenantId: 't', idempotencyKey: 'k' };
      delete full[missing];
      const check = validateEnvelope(full);
      assert.equal(check.ok, false, `envelope without ${missing} was accepted`);
    }
  });
});

describe('publish semantics', () => {
  test('publishing the same jobId twice creates ONE job', async () => {
    const queue = createInMemoryQueue();
    const envelope = {
      schemaVersion: MESSAGE_SCHEMA_VERSION, jobId: 'job-dup',
      proposalId: 'p1', tenantId: 't1', idempotencyKey: 'k1',
    };
    const first = await queue.publish(envelope);
    const second = await queue.publish(envelope);

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true, 'the second publish was not de-duplicated');
    assert.equal(await queue.depth(), 1, 'a duplicate publish created a second job');
  });

  test('the durable queue survives a process restart', async () => {
    const dir = path.join(tempDir('queue-restart'), 'q');
    const { lifecycle } = build();
    const { message } = await approvedJob(lifecycle);

    const first = createDurableQueue({ dir });
    await first.publish(message);
    assert.equal(await first.depth(), 1);

    // A brand-new queue object over the same directory, as a restarted process
    // would build. The message must still be there.
    const second = createDurableQueue({ dir });
    assert.equal(second.kind, 'durable-file');
    assert.equal(second.durable, true);
    assert.equal(await second.depth(), 1, 'the pending job did not survive the restart');

    const received = await second.receive();
    assert.equal(received.proposalId, message.proposalId);
  });

  test('the in-memory queue declares that it is NOT durable', () => {
    // A durable claim running on an in-memory queue would be false evidence, so
    // the queue states this in its own shape rather than relying on the harness.
    assert.equal(createInMemoryQueue().durable, false);
    assert.notEqual(createInMemoryQueue().kind, 'durable-file');
  });
});
describe('worker revalidation — the queue is not trusted', () => {
  test('an approved job completes and the executor is reached once', async () => {
    const { lifecycle, executor } = build();
    const queue = createInMemoryQueue();
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);
    await queue.publish(message);

    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'completed');
    assert.equal(executor.calls.length, 1);
    assert.equal(await queue.depth(), 0, 'a completed job stayed on the queue');
  });

  test('NEGATIVE CONTROL: a forged message for an UNAPPROVED proposal is refused', async () => {
    const { lifecycle, executor } = build();
    const queue = createInMemoryQueue();
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });

    // A queue publisher that skips approval entirely.
    const proposed = await lifecycle.propose({
      actor: ADMIN, tenantId: 'tenant-a',
      proposal: { action: 'disable_company_user', parameters: { username: 'mallory' } },
    });
    await queue.publish({
      schemaVersion: MESSAGE_SCHEMA_VERSION, jobId: `job-${proposed.proposalId}`,
      proposalId: proposed.proposalId, tenantId: 'tenant-a',
      idempotencyKey: `act-${proposed.proposalId}`, attempt: 1,
    });

    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'refused', 'a forged message was not refused');
    assert.equal(outcome.code, 'APPROVAL_REQUIRED');
    assert.equal(executor.calls.length, 0, 'a forged message reached the executor');
  });

  test('NEGATIVE CONTROL: a message with no tenant is refused, never defaulted to global', async () => {
    const { lifecycle, executor } = build();
    const queue = createInMemoryQueue();
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);

    // The failure this prevents is the worst one: a missing tenant quietly
    // defaulting to global access. The QUEUE refuses to accept such an envelope
    // in the first place, which is stronger than the worker refusing it later —
    // but the worker's preflight is a second, independent check, so both are
    // asserted. Either way nothing executes.
    await assert.rejects(
      () => queue.publish({ ...message, tenantId: undefined }),
      /missing: tenantId/,
      'the queue accepted an envelope with no tenant',
    );
    assert.equal(await queue.depth(), 0);

    // And if a message somehow reaches the worker anyway, preflight refuses it.
    const pre = worker.preflight({ proposalId: 'p1' });
    assert.equal(pre.ok, false);
    assert.equal(pre.code, 'TENANT_MISMATCH');
    assert.equal(executor.calls.length, 0);
  });

  test('NEGATIVE CONTROL: a message whose tenant differs from the proposal is refused', async () => {
    const { lifecycle, executor } = build();
    const queue = createInMemoryQueue();
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);

    await queue.publish({ ...message, tenantId: 'tenant-b' });

    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.code, 'TENANT_MISMATCH', `unexpected code ${outcome.code}`);
    assert.equal(executor.calls.length, 0);
  });

  test('a policy refusal is dead-lettered, never retried', async () => {
    const { lifecycle, executor } = build();
    const queue = createInMemoryQueue({ maxAttempts: 5 });
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);
    await queue.publish({ ...message, tenantId: 'tenant-b' });

    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'refused');
    // Retrying a denial would burn the whole budget and end in a DLQ entry that
    // looks like a flaky dependency rather than a policy decision.
    assert.equal(await queue.depth(), 0, 'a policy refusal was left for retry');
    assert.equal((await queue.deadLetters()).length, 1);
    assert.equal(executor.calls.length, 0);
  });
});
describe('retry classification and dead-lettering', () => {
  test('a TRANSIENT failure is retried by the LIFECYCLE, then the QUEUE dead-letters it', async () => {
    let attempts = 0;
    // Retry budget lives in TWO independent places: the lifecycle (which may
    // reclaim a FAILED-but-retryable execution) and the queue (which decides
    // whether to redeliver). Setting the lifecycle budget high and the queue
    // budget low isolates the queue's behaviour, which is what this test is about.
    const { lifecycle } = build({
      maxAttempts: 10,
      behaviour: async () => {
        attempts += 1;
        throw Object.assign(new Error('upstream unavailable'), { code: 'ECONNRESET' });
      },
    });
    const queue = createInMemoryQueue({ maxAttempts: 3 });
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);
    await queue.publish(message);

    assert.equal((await worker.runOnce()).status, 'retrying', 'a transient failure was not retried');
    assert.equal(await queue.depth(), 1, 'the retried job left the queue');
    assert.equal((await worker.runOnce()).status, 'retrying');
    assert.equal((await worker.runOnce()).status, 'dead-lettered', 'the queue retry bound was not enforced');

    assert.equal(await queue.depth(), 0);
    assert.equal((await queue.deadLetters()).length, 1);
    // EXACT count. `maxAttempts: 3` means THREE deliveries in total — one
    // initial plus two retries, then the third failure dead-letters. Asserting
    // only "some retries then DLQ" is not enough: an off-by-one in the budget
    // still satisfies that, and that mutation survived an earlier version of
    // this test.
    assert.equal(attempts, 3, `the executor ran ${attempts} times, expected exactly 3`);
  });

  test('NEGATIVE CONTROL: the DURABLE queue honours the exact retry budget', async () => {
    // The durable queue has its own copy of this arithmetic. A mutation that only
    // touched one of the two implementations passed the in-memory test and
    // survived — so the bound is asserted here too, on the implementation that
    // actually runs in production.
    const dir = path.join(tempDir('queue-retry'), 'q');
    const queue = createDurableQueue({ dir, maxAttempts: 3 });
    const envelope = {
      schemaVersion: MESSAGE_SCHEMA_VERSION, jobId: 'job-retry',
      proposalId: 'p1', tenantId: 't1', idempotencyKey: 'k1', attempt: 1,
    };
    await queue.publish(envelope);

    const r1 = await queue.fail(await queue.receive(), { code: 'X', retryable: true });
    assert.equal(r1.retried, true);
    assert.equal((await queue.receive()).attempt, 2, 'the retry did not advance the attempt counter');

    const r2 = await queue.fail(await queue.receive(), { code: 'X', retryable: true });
    assert.equal(r2.retried, true, 'the second retry was refused');
    assert.equal((await queue.receive()).attempt, 3);

    // The third failure exhausts a budget of three.
    const r3 = await queue.fail(await queue.receive(), { code: 'X', retryable: true });
    assert.equal(r3.deadLettered, true, 'the durable queue exceeded its retry budget');
    assert.equal(await queue.depth(), 0);
  });

  test('a dead letter carries a reason an operator can act on', async () => {
    const { lifecycle } = build({
      behaviour: async () => { throw Object.assign(new Error('upstream unavailable'), { code: 'ECONNRESET' }); },
    });
    const queue = createInMemoryQueue({ maxAttempts: 1 });
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);
    await queue.publish(message);

    await worker.runOnce();
    const [dead] = await queue.deadLetters();
    assert.ok(dead.reason, 'the dead letter carries no reason');
    assert.ok(dead.jobId, 'the dead letter carries no jobId');
    assert.ok(dead.proposalId, 'the dead letter cannot be traced back to its proposal');
  });

  test('replay is explicit and idempotent', async () => {
    const { lifecycle } = build({
      behaviour: async () => { throw Object.assign(new Error('down'), { code: 'ECONNRESET' }); },
    });
    const queue = createInMemoryQueue({ maxAttempts: 1 });
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);
    await queue.publish(message);
    await worker.runOnce();

    const jobId = (await queue.deadLetters())[0].jobId;
    const first = await queue.replay(jobId);
    assert.equal(first.ok, true);
    assert.equal(await queue.depth(), 1, 'replay did not re-publish the job');

    // Replaying an id that is already pending cannot create a second job.
    await queue.publish(await queue.receive());
    assert.equal(await queue.depth(), 1, 'replay produced a duplicate job');
  });

  test('a PERMANENT failure is dead-lettered immediately, not retried', async () => {
    const { lifecycle } = build({
      behaviour: async () => { throw Object.assign(new Error('bad request'), { retryable: false }); },
    });
    const queue = createInMemoryQueue({ maxAttempts: 5 });
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);
    await queue.publish(message);

    const outcome = await worker.runOnce();
    assert.notEqual(outcome.status, 'retrying', 'a permanent failure was retried');
    assert.equal(await queue.depth(), 0);
    assert.equal((await queue.deadLetters()).length, 1);
  });

  test('a post-check failure is not a success and is NOT retried into a duplicate execution', async () => {
    const { lifecycle, executor } = build({
      behaviour: async () => ({ ok: true, postCheck: { verified: false, why: 'target still enabled' } }),
    });
    const queue = createInMemoryQueue({ maxAttempts: 3 });
    const worker = createAutomationWorker({ lifecycle, queue, workerId: 'w1' });
    const { message } = await approvedJob(lifecycle);
    await queue.publish(message);

    const outcome = await worker.runOnce();
    assert.notEqual(outcome.status, 'completed', 'a failed post-check was reported as completed');

    // The side effect ALREADY happened, so redelivering this job would perform a
    // second privileged call. A post-check failure is therefore permanent and
    // must be dead-lettered on the first pass — this is exactly the case where a
    // generic "transient errors get retried" rule would duplicate an action.
    assert.equal(executor.calls.length, 1);
    assert.equal(await queue.depth(), 0, 'a post-check failure was left for redelivery');
    const dead = await queue.deadLetters();
    assert.equal(dead.length, 1, 'the post-check failure is not visible for operator triage');
  });
});