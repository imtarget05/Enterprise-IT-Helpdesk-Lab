'use strict';

/**
 * The automation worker: the only component allowed to reach the executor.
 *
 * Its central rule is that the QUEUE IS NOT TRUSTED. A message is an untrusted
 * envelope from a transport that may be replayed, forged, stale, or written by a
 * compromised publisher. Before anything privileged happens, `runOnce` re-checks
 * against the DURABLE store rather than against the message:
 *
 *   · the envelope shape and schema version;
 *   · that the proposal exists and its tenant matches the envelope's;
 *   · that the action is still in the catalog;
 *   · that the payload still hashes to what was recorded (TOCTOU);
 *   · that a HIGH_RISK action carries an APPROVED, hash-matching approval;
 *   · idempotency, via the lifecycle's durable claim.
 *
 * Only then does `execute()` run, and even it re-checks the same conditions. A
 * forged message therefore has to defeat two independent gates, and neither gate
 * trusts a message field to decide authority.
 *
 * Retry classification is delegated to the queue: TRANSIENT earns a bounded
 * retry, PERMANENT and BUSINESS_DENIED go straight to the dead-letter queue with
 * a reason. A policy refusal is never retried — retrying it burns budget and
 * turns a denial into a flaky-looking symptom.
 */

const { isTransient } = require('./automation-queue');

/** Outcomes that must never be retried, whatever the transport thinks. */
const NON_RETRYABLE_CODES = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_PAYLOAD_MISMATCH',
  'PAYLOAD_MODIFIED',
  'UNKNOWN_ACTION',
  'UNKNOWN_PROPOSAL',
  'INVALID_MESSAGE',
  'UNSUPPORTED_VERSION',
  'TENANT_MISMATCH',
  'SELF_APPROVAL_FORBIDDEN',
]);

function createAutomationWorker(options = {}) {
  const { lifecycle, queue, metrics } = options;
  if (!lifecycle) throw new Error('createAutomationWorker requires a lifecycle');
  if (!queue) throw new Error('createAutomationWorker requires a queue');

  const id = String(options.workerId || 'worker-1');
  const count = (metric, labels) => {
    if (typeof metrics === 'function') metrics(metric, labels || {});
  };

  /**
   * Envelope-level checks that need no lifecycle. Fail-closed throughout: an
   * unknown or malformed envelope is refused, never coerced.
   */
  function preflight(message) {
    if (!message || typeof message !== 'object') {
      return { ok: false, code: 'INVALID_MESSAGE', reason: 'message is not an object' };
    }
    if (!message.proposalId) {
      return { ok: false, code: 'INVALID_MESSAGE', reason: 'missing proposalId' };
    }
    if (!message.tenantId) {
      // A message with no tenant must NOT be treated as global. That defaulting
      // is exactly the "missing tenant falls back to global access" failure.
      return { ok: false, code: 'TENANT_MISMATCH', reason: 'message carries no tenantId' };
    }
    return { ok: true };
  }

/**
   * Process one message. The queue is ALWAYS left in a consistent state:
   * completed, retried, or dead-lettered.
   */
  async function runOnce() {
    const message = await queue.receive();
    if (!message) return { status: 'idle', processed: false };

    const pre = preflight(message);
    if (!pre.ok) {
      // A malformed envelope is never retried — redelivering it wastes budget.
      await queue.fail(message, { code: pre.code, retryable: false, reason: pre.reason });
      count('worker_jobs_rejected_total', { code: pre.code });
      return { status: 'rejected', code: pre.code, processed: true, jobId: message.jobId };
    }

    try {
      const result = await lifecycle.execute({
        message,
        workerId: id,
        attempt: Number(message.attempt || 1),
      });
      count('worker_jobs_total', { status: result.status });

      if (result.ok) {
        await queue.complete(message, result);
        return { status: 'completed', processed: true, jobId: message.jobId, result };
      }

      // A refusal from the lifecycle is a POLICY decision: recorded as a rejection
      // and never retried, however the transport classified the underlying error.
      if (NON_RETRYABLE_CODES.has(result.code)) {
        await queue.fail(message, { code: result.code, retryable: false, reason: `refused: ${result.code}` });
        count('worker_jobs_rejected_total', { code: result.code });
        return { status: 'refused', code: result.code, processed: true, jobId: message.jobId, result };
      }

      // The lifecycle reports `retry` (not `retryable`) on its failure result —
      // reading `result.retryable` silently yielded `undefined`, which the queue
      // read as "not retryable" and dead-lettered a genuinely transient failure
      // on its first attempt. Passing both keys keeps the queue's contract
      // explicit without guessing which name the caller used.
      const retryable = result.retryable === true || result.retry === true;
      const outcome = await queue.fail(message, {
        code: result.code,
        retryable,
        reason: result.reason || result.error,
      });
      if (outcome.deadLettered) count('worker_dlq_total', { code: result.code || 'UNKNOWN' });
      return {
        status: outcome.retried ? 'retrying' : 'dead-lettered',
        processed: true, jobId: message.jobId, result, outcome,
      };
    } catch (err) {
      // An exception from the executor or the store is retried only when it is
      // genuinely transient; otherwise it is dead-lettered with the reason.
      const outcome = await queue.fail(message, {
        code: (err && err.code) || 'WORKER_ERROR',
        retryable: isTransient(err),
        reason: (err && err.message) || String(err),
      });
      if (outcome.deadLettered) count('worker_dlq_total', { code: (err && err.code) || 'WORKER_ERROR' });
      return {
        status: outcome.retried ? 'retrying' : 'dead-lettered',
        processed: true, jobId: message.jobId, outcome, error: err,
      };
    }
  }

  /** Drain up to `limit` messages. Returns a tally an operator can read. */
  async function drain(limit = 100) {
    const tally = { completed: 0, refused: 0, retrying: 0, deadLettered: 0, rejected: 0, idle: 0 };
    for (let i = 0; i < limit; i += 1) {
      const outcome = await runOnce();
      if (outcome.status === 'idle') { tally.idle += 1; break; }
      tally[outcome.status] = (tally[outcome.status] || 0) + 1;
    }
    return tally;
  }

  return { id, runOnce, drain, preflight, NON_RETRYABLE_CODES };
}

module.exports = { createAutomationWorker, NON_RETRYABLE_CODES };