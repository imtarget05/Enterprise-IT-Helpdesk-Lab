'use strict';

/**
 * Governed action lifecycle — the deterministic authority for privileged work.
 *
 *   LLM proposes · code authorizes · human approves · deterministic executor executes
 *
 * Everything in this file is deterministic. Nothing here calls an LLM, and
 * nothing here accepts a command string: the only executable input is an action
 * id from `action-catalog.js`, which maps to an allowlisted argv inside the
 * (injected) executor. `test/action-lifecycle.test.js` includes negative
 * controls that plant a `powershell`/`command` field and assert it is rejected.
 *
 * Invariants enforced here (each has a test):
 *   unauthorized_privileged_execution = 0   → role check from the PERSISTED role
 *   high_risk_execution_without_approval = 0 → approval must exist and be APPROVED
 *   duplicate_privileged_execution = 0       → durable claim before any side effect
 */

const crypto = require('node:crypto');

const catalog = require('./action-catalog');
const { rolePermissions } = require('./auth');

const { RISK, STATES } = catalog;

/**
 * Version of the queue message envelope.
 *
 * A consumer must be able to tell a v1 job from a v2 job and refuse the one it
 * does not understand, instead of silently executing a message whose fields
 * moved. Bump this whenever the envelope changes shape.
 */
const MESSAGE_SCHEMA_VERSION = 1;

const DECISION = Object.freeze({
  ALLOWED: 'ALLOWED',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  DENIED: 'DENIED',
  INVALID: 'INVALID',
});

/** Transient failures MAY be retried within the bounded attempt budget. */
const TRANSIENT_CODES = Object.freeze([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND',
  'EHOSTUNREACH', 'TIMEOUT', 'PROVIDER_429', 'PROVIDER_502', 'PROVIDER_503', 'PROVIDER_504',
]);
const TRANSIENT_HTTP = Object.freeze([429, 500, 502, 503, 504]);

/** Anything that looks like credential material must never reach the audit log. */
const SECRET_PATTERN = /(password|passwd|secret|api[_-]?key|accountkey=|sharedaccesskey=|bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN)/i;
const REDACTED = '[redacted]';

function redact(value, depth = 0) {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return SECRET_PATTERN.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_PATTERN.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function classifyFailure(error) {
  if (!error) return { retryable: false, reason: 'no error' };
  const code = error.code || error.name || '';
  if (TRANSIENT_CODES.includes(code)) return { retryable: true, reason: `transient ${code}` };
  const status = Number(error.status || error.statusCode || 0);
  if (TRANSIENT_HTTP.includes(status)) return { retryable: true, reason: `transient http ${status}` };
  return { retryable: false, reason: `${code || 'error'}: ${String(error.message || '').slice(0, 200)}` };
}

/** Stable per-operation key: a re-delivery of the same action cannot re-execute. */
function idempotencyKeyFor(proposalId) {
  return `act-${proposalId}`;
}

/**
 * Is this outcome a verified success?
 *
 * The previous check was `outcome.postCheck !== false`, which treated an object
 * like `{ verified: false, why: 'target still enabled' }` as a SUCCESS: only a
 * literal `false` failed. A post-check that reports the state was NOT confirmed
 * therefore produced SUCCEEDED — precisely the "exit code 0 is not proof"
 * failure this stage exists to prevent. The defect was found by CASE 10 of the
 * HTTP end-to-end suite, not by the unit tests, because every unit-test executor
 * returned `{ verified: true }`.
 *
 * Accepted shapes, all explicit:
 *   - absent / undefined -> trusted (nothing was asked to verify)
 *   - `true`              -> verified
 *   - `false`             -> NOT verified
 *   - `{verified: true}`  -> verified
 *   - `{verified: false}` -> NOT verified
 *
 * An object post-check carrying no boolean `verified` is treated as UNVERIFIED.
 * Guessing "probably fine" is how a post-check becomes decoration.
 */
function isPostCheckVerified(outcome) {
  const postCheck = outcome && outcome.postCheck;
  if (postCheck === undefined || postCheck === null) return true;
  if (typeof postCheck === 'boolean') return postCheck;
  if (typeof postCheck !== 'object') return false;
  return postCheck.verified === true;
}

function createActionLifecycle(options = {}) {
  if (!options.store) throw new Error('createActionLifecycle requires a store');
  const store = options.store;
  const executor = options.executor || null;
  const maxAttempts = Number(options.maxAttempts || 10); // mirrors Service Bus maxDeliveryCount
  const clock = typeof options.now === 'function' ? options.now : () => new Date();

  async function audit(event) {
    const row = {
      proposalId: event.proposalId || null,
      executionId: event.executionId || null,
      tenantId: event.tenantId || 'unknown',
      event: event.event,
      actor: event.actor || 'system',
      actorRole: event.actorRole || '',
      correlationId: event.correlationId || 'uncorrelated',
      detail: redact(event.detail || {}),
    };
    return store.appendAudit(row);
  }

  function denied(code, reason, extra = {}) {
    return { ...extra, ok: false, code, reason };
  }

  // -------------------------------------------------------------------------
  // propose — deterministic authorization, risk classification, routing
  // -------------------------------------------------------------------------
  async function propose(input = {}) {
    const actor = input.actor || null;
    const tenantId = String(input.tenantId || '');
    const correlationId = String(input.correlationId || `corr_${crypto.randomBytes(6).toString('hex')}`);
    const checked = catalog.validateProposal(input.proposal || {});

    if (!checked.ok) {
      await audit({
        tenantId, correlationId, event: 'DENIED', actor: actor && actor.username,
        actorRole: actor && actor.role, detail: { stage: 'schema', code: checked.code, reason: checked.error },
      });
      return denied(checked.code || 'INVALID', checked.error || 'invalid proposal', { correlationId });
    }
    if (!actor || !actor.authenticated) {
      await audit({
        tenantId, correlationId, event: 'DENIED', actor: 'anonymous',
        detail: { stage: 'authn', action: checked.action },
      });
      return denied('UNAUTHENTICATED', 'actor is not authenticated', { correlationId });
    }
    if (!catalog.canPropose(actor.role)) {
      await audit({
        tenantId, correlationId, event: 'DENIED', actor: actor.username, actorRole: actor.role,
        detail: { stage: 'authz', action: checked.action, reason: 'role may not propose automation' },
      });
      return denied('UNAUTHORIZED', `role ${actor.role} may not propose automation`, { correlationId });
    }

    const risk = catalog.actionRisk(checked.action);
    const proposal = await store.createProposal({
      tenantId,
      ticketId: checked.ticketId,
      action: checked.action,
      parameters: checked.parameters,
      risk,
      requestedBy: String(actor.username),
      requestedByRole: String(actor.role),
      correlationId,
      proposalSource: checked.source,
    });

    await audit({
      proposalId: proposal.proposalId, tenantId, correlationId, event: 'PROPOSED',
      actor: actor.username, actorRole: actor.role,
      detail: { action: checked.action, risk },
    });

    if (catalog.requiresApproval(checked.action)) {
      await store.setState(proposal.proposalId, STATES.APPROVAL_PENDING);
      await audit({
        proposalId: proposal.proposalId, tenantId, correlationId, event: 'APPROVAL_REQUESTED',
        actor: actor.username, actorRole: actor.role, detail: { risk, action: checked.action },
      });
      return {
        ok: true,
        status: DECISION.NEEDS_APPROVAL,
        risk,
        proposalId: proposal.proposalId,
        proposal: { ...proposal, state: STATES.APPROVAL_PENDING },
        correlationId,
      };
    }

    await store.setState(proposal.proposalId, STATES.AUTHORIZED);
    await audit({
      proposalId: proposal.proposalId, tenantId, correlationId, event: 'AUTHORIZED',
      actor: actor.username, actorRole: actor.role, detail: { risk, action: checked.action },
    });
    return {
      ok: true,
      status: DECISION.ALLOWED,
      risk,
      proposalId: proposal.proposalId,
      proposal: { ...proposal, state: STATES.AUTHORIZED },
      correlationId,
    };
  }

  // -------------------------------------------------------------------------
  // decide — human approval. Append-only, one decision per proposal,
  // separation of duties (the proposer can never approve their own action).
  // -------------------------------------------------------------------------
  async function decide(input = {}) {
    const proposalId = String(input.proposalId || '');
    const decided = String(input.decision || '').toUpperCase();
    const actor = input.actor || null;
    const proposal = await store.getProposal(proposalId);

    if (!proposal) return denied('UNKNOWN_PROPOSAL', `unknown proposal ${proposalId}`);
    if (!['APPROVED', 'REJECTED'].includes(decided)) {
      return denied('INVALID_DECISION', 'decision must be APPROVED or REJECTED');
    }
    if (proposal.state !== STATES.APPROVAL_PENDING) {
      await audit({
        proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
        event: 'DENIED', actor: actor && actor.username, actorRole: actor && actor.role,
        detail: { stage: 'state', reason: `proposal is ${proposal.state}, not awaiting approval` },
      });
      return denied('NOT_AWAITING_APPROVAL', `proposal is ${proposal.state}`);
    }
    if (!actor || !actor.authenticated) {
      return denied('UNAUTHENTICATED', 'actor is not authenticated');
    }
    if (!hasApprovalAuthority(actor)) {
      await audit({
        proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
        event: 'DENIED', actor: actor.username, actorRole: actor.role,
        detail: { stage: 'authz', reason: 'actor lacks approval authority' },
      });
      return denied('UNAUTHORIZED_APPROVER', `role ${actor.role} may not approve`);
    }

    const isSelfApproval = String(actor.username) === proposal.requestedBy;
    if (isSelfApproval) {
      await audit({
        proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
        event: 'DENIED', actor: actor.username, actorRole: actor.role,
        detail: { stage: 'separation-of-duties', reason: 'proposer cannot approve own action' },
      });
      return denied('SELF_APPROVAL_FORBIDDEN', 'the proposer cannot approve their own action');
    }

    const recorded = await store.recordApproval({
      proposalId,
      decision: decided,
      approver: String(actor.username),
      approverRole: String(actor.role),
      proposer: proposal.requestedBy,
      isSelfApproval,
      reason: String(input.reason || ''),
      // TOCTOU binding: the approver signs THIS payload, and the hash travels
      // with the approval so queue and execution can re-verify it later.
      payloadHash: proposal.payloadHash || catalog.proposalPayloadHash(proposal),
    });
    if (!recorded.ok) {
      return denied(recorded.code || 'APPROVAL_CONFLICT', 'a decision already exists for this proposal');
    }

    const nextState = decided === 'APPROVED' ? STATES.APPROVED : STATES.REJECTED;
    await store.setState(proposalId, nextState);
    await audit({
      proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
      event: decided, actor: actor.username, actorRole: actor.role,
      detail: { risk: proposal.risk, action: proposal.action, reason: String(input.reason || '') },
    });
    const updated = await store.getProposal(proposalId);
    return { ok: true, status: decided, proposal: updated, approval: recorded.approval };
  }

  // -------------------------------------------------------------------------
  // enqueue — only an AUTHORIZED (low risk) or APPROVED (high risk) proposal
  // may produce a queue message. A REJECTED/DENIED proposal cannot, because the
  // transition is not in the state machine.
  // -------------------------------------------------------------------------
  async function enqueue(input = {}) {
    const proposalId = String(input.proposalId || '');
    const proposal = await store.getProposal(proposalId);
    if (!proposal) return denied('UNKNOWN_PROPOSAL', `unknown proposal ${proposalId}`);

    // TOCTOU GATE (1/2). The payload must still hash to what it hashed to when
    // the proposal was created — and, for a high-risk action, to what the
    // approver signed. A proposal edited after approval is refused here, before
    // any job exists, rather than executing something nobody signed off.
    if (!catalog.payloadHashMatches(proposal.payloadHash, proposal)) {
      await audit({
        proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
        event: 'DENIED', actor: 'system',
        detail: { stage: 'toctou', reason: 'proposal payload no longer matches its recorded hash' },
      });
      return denied('PAYLOAD_MODIFIED', 'proposal payload changed after it was recorded');
    }
    if (proposal.state === STATES.APPROVED) {
      const approval = await store.getApproval(proposalId);
      const signed = approval && approval.approvedPayloadHash;
      if (signed && !catalog.payloadHashMatches(signed, proposal)) {
        await audit({
          proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
          event: 'DENIED', actor: 'system',
          detail: { stage: 'toctou', reason: 'proposal payload no longer matches the approved hash' },
        });
        return denied('APPROVAL_PAYLOAD_MISMATCH', 'proposal changed after it was approved');
      }
    }

    try {
      await store.setState(proposalId, STATES.QUEUED);
    } catch (err) {
      if (err.code === 'ILLEGAL_TRANSITION') {
        await audit({
          proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
          event: 'DENIED', actor: 'system',
          detail: { stage: 'queue', reason: `${proposal.state} cannot be queued` },
        });
        return denied('NOT_QUEUEABLE', `proposal is ${proposal.state}`);
      }
      throw err;
    }

    await audit({
      proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
      event: 'QUEUED', actor: String((input.actor && input.actor.username) || 'system'),
      actorRole: String((input.actor && input.actor.role) || ''),
      detail: { action: proposal.action, risk: proposal.risk },
    });

    // The message carries identifiers only — never a command, never a parameter
    // the executor would trust blindly (parameters are re-read from the store).
    //
    // `schemaVersion` is mandatory: a consumer must be able to tell a v1 job from
    // a v2 job and refuse the one it does not understand, rather than silently
    // executing a message whose fields moved. `actionId` is carried for routing
    // and observability ONLY — execute() re-reads the action from the store, so a
    // tampered actionId here changes nothing.
    return {
      ok: true,
      status: STATES.QUEUED,
      message: {
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        jobId: `job-${proposalId}`,
        actionId: proposal.action,
        proposalId,
        tenantId: proposal.tenantId,
        correlationId: proposal.correlationId,
        risk: proposal.risk,
        payloadHash: proposal.payloadHash,
        idempotencyKey: idempotencyKeyFor(proposalId),
        attempt: 1,
        queuedAt: clock().toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // execute — the worker path. Re-checks authorization from the PERSISTED
  // record (never from the message), enforces the approval gate, claims a
  // durable idempotency slot BEFORE the side effect, then post-checks.
  // -------------------------------------------------------------------------
  async function execute(input = {}) {
    const message = input.message || {};
    const workerId = String(input.workerId || 'worker-1');
    const attempt = Number(input.attempt || message.attempt || 1);
    const proposalId = String(message.proposalId || '');
    const proposal = await store.getProposal(proposalId);

    if (!proposal) {
      return { ok: false, status: 'POISON', executed: false, code: 'UNKNOWN_PROPOSAL' };
    }

    const base = {
      proposalId, tenantId: proposal.tenantId, correlationId: proposal.correlationId,
    };

    // TENANT GATE. The envelope's tenant must AGREE with the persisted proposal's.
    //
    // Re-reading the tenant from the store (which is what the rest of this
    // function does) is not on its own enough: a message that claims tenant-b
    // while pointing at a tenant-a proposal would otherwise execute successfully
    // under tenant-a's authority while the transport recorded tenant-b. That is a
    // cross-tenant confusion — the job would be reported against the wrong tenant
    // in audit, metrics and DLQ triage, and a corrupted or spoofed envelope could
    // be laundered into another tenant's queue.
    //
    // Refusing on mismatch means a tampered envelope fails closed instead of
    // silently "correcting itself".
    if (message.tenantId && String(message.tenantId) !== String(proposal.tenantId)) {
      await audit({
        ...base, event: 'DENIED', actor: workerId,
        detail: { stage: 'worker', reason: 'envelope tenant does not match the proposal tenant' },
      });
      return { ok: false, status: 'POISON', executed: false, code: 'TENANT_MISMATCH' };
    }

    // TOCTOU GATE (2/2). The worker must NOT trust the queue message. A forged
    // or stale message is refused before the idempotency slot is claimed and
    // before the executor is reached:
    //
    //   · the action must still be in the catalog and hash to what was recorded;
    //   · a HIGH_RISK action must carry an APPROVED, hash-matching approval.
    //
    // This is why "it came from the queue" is not treated as authority.
    if (!catalog.isKnownAction(proposal.action)) {
      await audit({ ...base, event: 'DENIED', actor: workerId, detail: { stage: 'worker', reason: 'action is not in the catalog' } });
      return { ok: false, status: 'POISON', executed: false, code: 'UNKNOWN_ACTION' };
    }
    if (!catalog.payloadHashMatches(proposal.payloadHash, proposal)) {
      await audit({ ...base, event: 'DENIED', actor: workerId, detail: { stage: 'worker', reason: 'payload no longer matches recorded hash' } });
      return { ok: false, status: 'POISON', executed: false, code: 'PAYLOAD_MODIFIED' };
    }
    if (catalog.requiresApproval(proposal.action)) {
      const approval = await store.getApproval(proposalId);
      if (!approval || approval.decision !== 'APPROVED') {
        await audit({ ...base, event: 'DENIED', actor: workerId, detail: { stage: 'worker', reason: 'high-risk action delivered without an approved decision' } });
        return { ok: false, status: 'POISON', executed: false, code: 'APPROVAL_REQUIRED' };
      }
      if (approval.approvedPayloadHash && !catalog.payloadHashMatches(approval.approvedPayloadHash, proposal)) {
        await audit({ ...base, event: 'DENIED', actor: workerId, detail: { stage: 'worker', reason: 'approved payload does not match what will run' } });
        return { ok: false, status: 'POISON', executed: false, code: 'APPROVAL_PAYLOAD_MISMATCH' };
      }
    }

    const idempotencyKey = String(message.idempotencyKey || idempotencyKeyFor(proposalId));

    // Duplicate detection comes FIRST so a re-delivery is classified as a
    // duplicate (what the metric reports) instead of a generic state error.
    // A FAILED-but-retryable execution is not a duplicate: it may resume.
    const preExisting = await store.getExecutionByKey(idempotencyKey);
    if (preExisting) {
      const resumable = preExisting.status === 'FAILED'
        && preExisting.result && preExisting.result.retryable === true
        && preExisting.attempt < maxAttempts;
      if (!resumable) {
        const duplicateStatus = preExisting.status === 'CLAIMED' ? 'IN_FLIGHT' : 'DUPLICATE_BLOCKED';
        await audit({
          ...base, executionId: preExisting.executionId, event: 'DUPLICATE_BLOCKED',
          actor: workerId,
          detail: { idempotencyKey, existingStatus: preExisting.status, attempt },
        });
        return {
          ok: false, status: duplicateStatus, executed: false, duplicate: true,
          executionId: preExisting.executionId, existingStatus: preExisting.status,
        };
      }
    }

    // Only a QUEUED (or crash-interrupted EXECUTING) proposal may run.
    if (![STATES.QUEUED, STATES.EXECUTING].includes(proposal.state)) {
      await audit({
        ...base, event: 'DENIED', actor: workerId,
        detail: { stage: 'executor-state', reason: `proposal is ${proposal.state}` },
      });
      return { ok: false, status: 'BLOCKED', executed: false, code: 'WRONG_STATE', state: proposal.state };
    }

    // Authorization is re-derived from the PERSISTED role, so a forged queue
    // message cannot widen authority.
    if (!catalog.canPropose(proposal.requestedByRole)) {
      await audit({
        ...base, event: 'DENIED', actor: workerId,
        detail: { stage: 'executor-authz', role: proposal.requestedByRole },
      });
      return { ok: false, status: 'BLOCKED', executed: false, code: 'UNAUTHORIZED_PROPOSAL' };
    }

    // Approval gate: high-risk work without an APPROVED decision never executes.
    let approvalId = null;
    let approvalState = 'NOT_REQUIRED';
    if (catalog.requiresApproval(proposal.action)) {
      const approval = await store.getApproval(proposalId);
      if (!approval || approval.decision !== 'APPROVED') {
        await audit({
          ...base, event: 'FAILED', actor: workerId,
          detail: { stage: 'approval-gate', reason: approval ? approval.decision : 'missing approval' },
        });
        return { ok: false, status: 'BLOCKED', executed: false, code: 'APPROVAL_REQUIRED' };
      }
      approvalId = approval.approvalId;
      approvalState = 'APPROVED';
    }

    let claim = await store.claimExecution({
      proposalId, idempotencyKey, tenantId: proposal.tenantId, workerId,
      attempt, approvalId, approvalState,
    });

    // The attempt number that the budget checks below must reflect the CURRENT
    // attempt, which can be higher than `attempt` after a reclaim.
    let effectiveAttempt = attempt;

    if (!claim.claimed) {
      const existing = await store.getExecutionByKey(idempotencyKey);
      const retryable = existing && existing.status === 'FAILED'
        && existing.result && existing.result.retryable === true;
      if (retryable && attempt <= maxAttempts && existing.attempt < maxAttempts) {
        const reclaimed = await store.reclaimExecution({ executionId: existing.executionId });
        if (reclaimed.ok) {
          claim = { claimed: true, duplicate: false, executionId: existing.executionId };
          // Adopt the store's attempt counter. `attempt` still held the PREVIOUS
          // attempt number here, so the `attempt >= maxAttempts` budget check
          // further down compared against a stale value — a retried job was
          // therefore told it had exhausted its budget one attempt early, and a
          // genuinely retryable failure was reported as permanently dead.
          effectiveAttempt = reclaimed.attempt;
        }
      }
      if (!claim.claimed) {
        const status = existing && existing.status === 'CLAIMED' ? 'IN_FLIGHT' : 'DUPLICATE_BLOCKED';
        await audit({
          ...base, executionId: existing && existing.executionId, event: 'DUPLICATE_BLOCKED',
          actor: workerId,
          detail: { idempotencyKey, existingStatus: existing && existing.status },
        });
        return {
          ok: false, status, executed: false, duplicate: true,
          executionId: existing && existing.executionId,
        };
      }
    }

    if (proposal.state === STATES.QUEUED) {
      await store.setState(proposalId, STATES.EXECUTING);
    }
    await audit({
      ...base, executionId: claim.executionId, event: 'STARTED', actor: workerId,
      detail: { action: proposal.action, risk: proposal.risk, attempt },
    });

    if (!executor || typeof executor.run !== 'function') {
      await store.finishExecution({
        executionId: claim.executionId, status: 'FAILED',
        result: { error: 'no executor bound', retryable: false },
      });
      await store.setState(proposalId, STATES.FAILED);
      return { ok: false, status: 'FAILED', executed: true, code: 'NO_EXECUTOR', executionId: claim.executionId };
    }

    let outcome;
    try {
      outcome = await executor.run({
        action: proposal.action,
        parameters: proposal.parameters,
        proposalId,
        executionId: claim.executionId,
        correlationId: proposal.correlationId,
      });
    } catch (err) {
      const failure = classifyFailure(err);
      const exhausted = !failure.retryable || effectiveAttempt >= maxAttempts;
      const failStatus = exhausted && failure.retryable ? 'DEAD_LETTERED' : 'FAILED';
      await store.finishExecution({
        executionId: claim.executionId, status: failStatus,
        result: { error: failure.reason, retryable: failure.retryable && !exhausted, attempt },
      });
      if (exhausted) await store.setState(proposalId, STATES.FAILED);
      await audit({
        ...base, executionId: claim.executionId, event: failStatus, actor: workerId,
        detail: { reason: failure.reason, attempt, retryable: failure.retryable },
      });
      return {
        ok: false, status: failStatus, executed: true,
        retry: failure.retryable && !exhausted,
        executionId: claim.executionId, error: failure.reason,
      };
    }

    const postCheckOk = isPostCheckVerified(outcome);
    const status = postCheckOk
      ? (outcome && outcome.ok === false ? 'FAILED' : 'SUCCEEDED')
      : 'POSTCHECK_FAILED';

    await store.finishExecution({
      executionId: claim.executionId, status,
      result: { ok: Boolean(outcome && outcome.ok), attempt, retryable: false },
      postCheck: outcome ? (outcome.postCheck === undefined ? null : outcome.postCheck) : null,
    });
    await store.setState(proposalId, status === 'SUCCEEDED' ? STATES.EXECUTED : STATES.FAILED);
    if (status === 'SUCCEEDED') {
      await audit({
        ...base, executionId: claim.executionId, event: 'SUCCEEDED', actor: workerId,
        detail: { action: proposal.action, postCheck: outcome && outcome.postCheck },
      });
      await store.setState(proposalId, STATES.POSTCHECKED);
      await audit({
        ...base, executionId: claim.executionId, event: 'POSTCHECKED', actor: workerId,
        detail: { postCheck: outcome && outcome.postCheck },
      });
    } else {
      await audit({
        ...base, executionId: claim.executionId, event: 'FAILED', actor: workerId,
        detail: { status, postCheck: outcome && outcome.postCheck },
      });
    }

    return {
      ok: status === 'SUCCEEDED',
      status,
      executed: true,
      executionId: claim.executionId,
      postCheck: outcome && outcome.postCheck,
    };
  }

  return {
    propose,
    decide,
    enqueue,
    execute,
    auditTrail: (proposalId) => store.listAudit({ proposalId }),
    idempotencyKeyFor,
  };

  function hasApprovalAuthority(actor) {
    if (typeof options.hasApprovalAuthority === 'function') return Boolean(options.hasApprovalAuthority(actor));
    const permissions = Array.isArray(actor.permissions)
      ? actor.permissions
      : rolePermissions(actor.role);
    return permissions.includes(catalog.APPROVAL_PERMISSION);
  }
}

module.exports = {
  createActionLifecycle,
  DECISION,
  MESSAGE_SCHEMA_VERSION,
  classifyFailure,
  idempotencyKeyFor,
  isPostCheckVerified,
  redact,
};