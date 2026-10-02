'use strict';

/**
 * The four crash windows, measured by counting executor calls.
 *
 * The invariant:
 *
 *     duplicate_privileged_execution = 0
 *
 * A crash window is the interval between "the message is durable" and "the
 * outcome is durable". A worker can die anywhere in it. The queue is
 * at-least-once, so every one of these windows redelivers on restart — the
 * question is never "will it run twice" but "does the second run reach the
 * executor".
 *
 * Why count calls instead of asserting a status code. A status assertion
 * proves the worker returned something plausible. It does not prove the
 * executor was not invoked. An implementation that executes, then throws
 * APPROVAL_REQUIRED on the way out, satisfies every status-based test in this
 * repository while still performing the privileged effect. Counting calls is
 * the only assertion that survives that implementation.
 *
 * Windows, in the order a job passes through them:
 *
 *   W1  crash AFTER publish, BEFORE any receive      → 1 execution
 *   W2  crash AFTER receive, BEFORE complete/ACK     → 1 execution
 *   W3  crash AFTER execute, BEFORE durable completion → 1 execution
 *   W4  crash AFTER success recorded, BEFORE ACK      → 1 execution
 *
 * W3 and W4 are the dangerous ones: the side effect has already happened, so a
 * naive replay performs it twice. Only the durable idempotency claim can stop
 * it, and that claim has to be taken BEFORE the side effect — which is exactly
 * what these tests measure.
 *
 * No real sleeps. Each "crash" is an exception thrown at a chosen point and a
 * discarded worker, which is deterministic and fast. Real process kills are
 * covered by the durable-store suite; what matters here is that the CODE PATH
 * after a crash is safe, not that the OS is.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createActionLifecycle } = require('../src/action-lifecycle');
const { createMemoryLifecycleStore } = require('../src/lifecycle-store-memory');
const { createDurableQueue } = require('../src/automation-queue');
const { createAutomationWorker } = require('../src/automation-worker');

const ADMIN = { username: 'tan.admin', role: 'IT_ADMIN', authenticated: true };
const APPROVER = { username: 'linh.approver', role: 'IT_ADMIN', authenticated: true };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-crash-'));
}

/** Executor that records every privileged invocation. */
function countingExecutor(behaviour) {
  const calls = [];
  return {
    calls,
    get callCount() {
      return calls.length;
    },
    async run(request) {
      calls.push(request);
      if (behaviour) return behaviour(request, calls.length);
      return { ok: true, simulated: true, postCheck: { verified: true } };
    },
  };
}

/**
 * Build a lifecycle + queue + worker over ONE durable directory, so a "restart"
 * reopens the same queue and the same lifecycle store.
 */
function buildStack(options = {}) {
  const dir = options.dir || tempDir();
  const executor = countingExecutor(options.behaviour);
  const store = options.store || createMemoryLifecycleStore({ file: path.join(dir, 'lifecycle.json') });
  const lifecycle = createActionLifecycle({ store, executor, maxAttempts: options.maxAttempts || 3 });
  const queue = createDurableQueue({ dir: path.join(dir, 'queue'), maxAttempts: options.maxAttempts || 3 });

  return {
    dir,
    executor,
    store,
    lifecycle,
    queue,
    worker: createAutomationWorker({ lifecycle, queue, workerId: options.workerId || 'worker-1' }),
  };
}

/** Propose, approve, and PUBLISH a HIGH_RISK action. Returns the job envelope. */
async function enqueueApprovedJob(stack) {
  const proposed = await stack.lifecycle.propose({
    actor: ADMIN,
    tenantId: 'tenant-a',
    proposal: { action: 'disable_company_user', parameters: { username: 'mallory' }, reason: 'incident' },
  });
  await stack.lifecycle.decide({ proposalId: proposed.proposalId, actor: APPROVER, decision: 'APPROVED' });
  const enqueued = await stack.lifecycle.enqueue({ proposalId: proposed.proposalId });
  // `enqueue` RETURNS the envelope; publishing it is a separate, deliberate
  // step. The crash windows are all about what happens around that publish, so
  // the test must do it explicitly rather than assume it.
  await stack.queue.publish(enqueued.message);
  return { proposalId: proposed.proposalId, message: enqueued.message };
}

/**
 * An executor that "crashes" the worker at a chosen moment.
 *
 * `crashAt` selects WHEN the crash happens, expressed in terms of how many
 * privileged calls have been made, so each window is reachable without timers:
 *
 *   'before-execute' — die on the way in, no side effect attempted
 *   'during-execute' — perform the effect, then die before returning
 */
function crashingExecutor(crashAt) {
  return async function behaviour(request, callNumber) {
    if (callNumber === 1 && crashAt === 'before-execute') {
      throw Object.assign(new Error('simulated crash before execute'), { code: 'WORKER_CRASH' });
    }
    if (crashAt === 'during-execute') {
      // The privileged effect HAPPENS, then the worker dies before it can
      // report success. This is the window that produces duplicates.
      throw Object.assign(new Error('simulated crash after execute, before completion'), { code: 'WORKER_CRASH' });
    }
    return { ok: true, simulated: true, postCheck: { verified: true } };
  };
}

// ---------------------------------------------------------------------------
// W1 — crash after publish, before any receive.
// ---------------------------------------------------------------------------

describe('W1 — crash after publish, before receive', () => {
  test('the job is still pending and executes exactly once after restart', async () => {
    const stack = buildStack();
    const { message } = await enqueueApprovedJob(stack);

    // The "crash": the worker never ran. The process could have died the
    // instant after publish and before the loop picked the job up.
    assert.equal(await stack.queue.depth(), 1, 'the job should be durable in the queue');

    // Restart: a brand new worker over the same directory.
    const restarted = buildStack({ dir: stack.dir, store: stack.store });
    await restarted.worker.drain();

    assert.equal(
      restarted.executor.callCount,
      1,
      `executor ran ${restarted.executor.callCount} times for one published job`,
    );
    assert.equal(await restarted.queue.depth(), 0);
  });

  test('republishing the same job after the crash does not create a second job', async () => {
    const stack = buildStack();
    const { message } = await enqueueApprovedJob(stack);

    // At-least-once transport redelivers the same jobId.
    const again = await stack.queue.publish(message);
    assert.equal(again.deduplicated, true, 'a duplicate jobId was queued as a second job');

    const restarted = buildStack({ dir: stack.dir, store: stack.store });
    await restarted.worker.drain();
    assert.equal(restarted.executor.callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// W2 — crash after receive, before complete/ACK.
// ---------------------------------------------------------------------------

describe('W2 — crash after receive, before ACK', () => {
  test('a job received but never completed is redelivered, and executes once', async () => {
    const stack = buildStack();
    const { message } = await enqueueApprovedJob(stack);

    // `receive()` peeks; it does not remove. The worker then dies before
    // completing, so the message is still there on restart. That is the whole
    // point of at-least-once delivery.
    const peeked = await stack.queue.receive();
    assert.equal(peeked.jobId, message.jobId);
    assert.equal(await stack.queue.depth(), 1, 'receive() must not delete the message');

    const restarted = buildStack({ dir: stack.dir, store: stack.store });
    await restarted.worker.drain();

    assert.equal(
      restarted.executor.callCount,
      1,
      `executor ran ${restarted.executor.callCount} times after a receive-without-ack`,
    );
  });

  test('two workers racing the same pending job still execute once', async () => {
    const stack = buildStack();
    await enqueueApprovedJob(stack);

    // Two replicas drain the same durable queue concurrently.
    const a = buildStack({ dir: stack.dir, store: stack.store, workerId: 'worker-a' });
    const b = buildStack({ dir: stack.dir, store: stack.store, workerId: 'worker-b' });
    await Promise.all([a.worker.drain(), b.worker.drain()]);

    const total = a.executor.callCount + b.executor.callCount;
    assert.equal(total, 1, `two workers performed ${total} privileged executions for one job`);
  });
});

// ---------------------------------------------------------------------------
// W3 — crash AFTER the side effect, BEFORE durable completion.
//
// This is the window that produces duplicates in a naive implementation: the
// privileged effect has already happened, the worker dies before recording it,
// and at-least-once delivery hands the same job to a fresh worker.
// ---------------------------------------------------------------------------

describe('W3 — crash after execute, before durable completion', () => {
  test('a side effect that happened then crashed is NOT performed again', async () => {
    // The executor performs the effect and then the worker dies. From the
    // queue's perspective nothing succeeded, so the job will be redelivered.
    const crashing = buildStack({ behaviour: crashingExecutor('during-execute') });
    const { proposalId } = await enqueueApprovedJob(crashing);

    await crashing.worker.drain();
    const firstPassCalls = crashing.executor.callCount;
    assert.equal(firstPassCalls, 1, 'the first pass should have attempted exactly one execution');

    // Restart over the same durable state and let the redelivery run.
    const restarted = buildStack({
      dir: crashing.dir,
      store: crashing.store,
      behaviour: crashingExecutor('during-execute'),
    });
    await restarted.worker.drain();
    await restarted.worker.drain();

    const totalCalls = crashing.executor.callCount + restarted.executor.callCount;
    assert.equal(
      totalCalls,
      1,
      `the privileged action ran ${totalCalls} times after a crash between execute and completion`,
    );

    // The durable record must show exactly ONE execution for this proposal, and
    // the executor must have been reached exactly once. Both are asserted from
    // the SAME store the first pass used — a fresh store would report zero rows
    // and make the assertion vacuously true. `listExecutions` takes the id
    // itself, not an options object: passing `{ proposalId }` matches nothing
    // and reports 0 rows, which reads as "no execution ever happened".
    const executions = await crashing.store.listExecutions(proposalId);
    assert.equal(executions.length, 1, `expected one execution row, found ${executions.length}`);
    assert.equal(
      crashing.executor.callCount + restarted.executor.callCount,
      1,
      'the privileged executor was reached more than once across the restart',
    );
  });

  test('a redelivered job is reported as BLOCKED, not as a success', async () => {
    // The other half of the boundary. Even with the durable claim detecting the
    // duplicate, returning `ok: true` would let the worker COMPLETE the message
    // and clear it from the queue — the blocked delivery would then read as a
    // success to every operator looking at the outcome, and the DLQ would stay
    // empty. "No duplicate execution" is not the same as "duplicate visible".
    const stack = buildStack();
    const { message } = await enqueueApprovedJob(stack);

    const first = await stack.lifecycle.execute({ message, workerId: 'worker-1', attempt: 1 });
    assert.equal(first.ok, true, 'the first delivery should succeed');

    const second = await stack.lifecycle.execute({ message, workerId: 'worker-2', attempt: 1 });
    assert.equal(second.ok, false, 'a redelivered envelope was reported as a success');
    assert.equal(second.duplicate, true, 'the second delivery was not flagged as a duplicate');
    assert.equal(second.executed, false);
    assert.ok(
      ['DUPLICATE_BLOCKED', 'IN_FLIGHT'].includes(second.status),
      `unexpected duplicate status: ${second.status}`,
    );
    assert.equal(stack.executor.callCount, 1, 'the redelivery reached the executor');
  });

  test('the blocked redelivery is recorded in the audit trail', async () => {
    // An operator investigating "did this job run twice?" needs the refusal to
    // be visible. Without the DUPLICATE_BLOCKED event, a blocked replay is
    // indistinguishable from one that never arrived.
    const stack = buildStack();
    const { proposalId, message } = await enqueueApprovedJob(stack);

    await stack.lifecycle.execute({ message, workerId: 'worker-1', attempt: 1 });
    await stack.lifecycle.execute({ message, workerId: 'worker-2', attempt: 1 });

    const audit = await stack.store.listAudit(proposalId);
    const events = audit.map((e) => e.event);
    assert.ok(events.includes('DUPLICATE_BLOCKED'), `no DUPLICATE_BLOCKED in: ${events.join(', ')}`);
    assert.equal(stack.executor.callCount, 1);
  });

  test('a second delivery of an already-executed job is blocked, not repeated', async () => {
    const stack = buildStack();
    const { message } = await enqueueApprovedJob(stack);

    await stack.worker.drain();
    assert.equal(stack.executor.callCount, 1);

    // Replay the SAME envelope into a fresh worker. The durable claim taken on
    // the first pass must refuse it.
    const replayed = await stack.queue.publish(message);
    assert.equal(replayed.ok, true);
    await stack.worker.drain();
    await stack.worker.drain();

    assert.equal(
      stack.executor.callCount,
      1,
      're-delivering a completed envelope reached the executor again',
    );
  });
});

// ---------------------------------------------------------------------------
// W4 — crash AFTER success is recorded, BEFORE the queue ACK.
//
// The side effect happened and the outcome is durable. Only the ACK is missing,
// so the queue still holds the message. This is the window a naive design turns
// into a duplicate, because the worker cannot distinguish "never ran" from "ran
// and the ACK was lost" without consulting the durable record.
// ---------------------------------------------------------------------------

describe('W4 — crash after success recorded, before ACK', () => {
  test('a completed job whose ACK was lost is not re-executed', async () => {
    const stack = buildStack();
    const { message } = await enqueueApprovedJob(stack);

    // Simulate the lost ACK directly: run the lifecycle to success (which
    // records the durable outcome), then throw the message away without
    // completing it. The queue now holds a message whose work is already done.
    await stack.lifecycle.execute({ message, workerId: 'worker-1', attempt: 1 });
    assert.equal(stack.executor.callCount, 1);
    assert.equal(await stack.queue.depth(), 1, 'the un-ACKed message should still be pending');

    // A fresh worker picks up the stale message.
    await stack.worker.drain();
    await stack.worker.drain();

    assert.equal(
      stack.executor.callCount,
      1,
      'a job whose success was already durable was executed again after a lost ACK',
    );
  });

  test('a worker that crashes while ACKing still does not duplicate', async () => {
    const stack = buildStack();
    const { message } = await enqueueApprovedJob(stack);

    // Complete the work, then make `complete()` throw so the ACK is lost.
    await stack.lifecycle.execute({ message, workerId: 'worker-1', attempt: 1 });
    const original = stack.queue.complete;
    stack.queue.complete = async () => {
      throw Object.assign(new Error('simulated crash during ACK'), { code: 'WORKER_CRASH' });
    };
    void original;

    const outcome = await stack.worker.runOnce();
    assert.equal(outcome.status !== 'completed', true, 'the ACK was supposed to fail');

    // Restore the queue and redeliver.
    stack.queue.complete = original;
    await stack.worker.drain();
    await stack.worker.drain();

    assert.equal(stack.executor.callCount, 1, 'a lost ACK produced a second execution');
  });
});