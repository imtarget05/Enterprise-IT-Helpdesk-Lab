'use strict';

// Bridges queue jobs of the governed action family into the durable
// action-lifecycle pipeline (src/action-lifecycle.js). The lifecycle owns
// authorization, approval, idempotency, execution and audit — the bridge only
// translates identifiers and reports the outcome, and never executes anything.
function createLifecycleBridge(options = {}) {
  if (!options.lifecycle) throw new Error('createLifecycleBridge requires a lifecycle');
  const lifecycle = options.lifecycle;
  const actor = options.actor || null;

  return {
    // A job is governed when it carries the lifecycle identifiers produced by
    // enqueue() (actionId + proposalId). It never carries a command, a script
    // path or an executor input — validateProposal rejects those shapes.
    isGoverned(job) {
      return Boolean(job && typeof job === 'object'
        && typeof job.proposalId === 'string' && job.proposalId !== ''
        && (typeof job.actionId === 'string' || typeof job.action === 'string'));
    },

    async execute(job) {
      const message = {
        proposalId: job.proposalId,
        idempotencyKey: job.idempotencyKey,
        attempt: job.attempt,
      };
      const result = await lifecycle.execute({
        message,
        workerId: String(job.workerId || 'servicebus-worker'),
        attempt: Number(job.attempt || 1),
      });
      return {
        governed: true,
        governedStatus: result.status === 'SUCCEEDED' ? 'completed'
          : result.status === 'DUPLICATE_BLOCKED' ? 'duplicate_skipped'
          : 'governed_blocked',
        detail: { governedResult: result },
      };
    },

    actor,
  };
}

module.exports = { createLifecycleBridge };