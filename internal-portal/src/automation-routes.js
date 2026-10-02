'use strict';

/**
 * Governed automation over HTTP — the authority boundary made reachable.
 *
 * This module EXPOSES the lifecycle that already existed in
 * `src/action-lifecycle.js` but had no HTTP surface. Before this, the governed
 * pipeline was reachable only from a test or a worker, so any new consumer (an
 * AI agent above all) would have been tempted to reach for the store directly
 * instead of going through policy.
 *
 * Two rules shape every handler here:
 *
 *  1. **No route executes anything.** `POST /proposals` proposes, `/approve`
 *     decides, `/reject` decides. Execution happens only in the worker, from a
 *     queue message, after the lifecycle's own gates have passed. There is
 *     deliberately no `/execute` endpoint — an endpoint that turns an HTTP
 *     request into a privileged side effect is exactly what this architecture
 *     refuses.
 *
 *  2. **Tenant comes from the session, never from the body.** `body.tenant` is
 *     not read anywhere in this file. A caller who can name their own tenant
 *     turns every scope below into decoration.
 *
 * Error semantics: a proposal belonging to another tenant answers 404, not 403.
 * "It exists but is not yours" is itself a disclosure.
 */

const { PERMISSIONS } = require('./auth');
const catalog = require('./action-catalog');

/** Stable HTTP status for each lifecycle denial code. */
const DENIED_STATUS = Object.freeze({
  INVALID: 400,
  UNKNOWN_ACTION: 400,
  INVALID_DECISION: 400,
  UNAUTHENTICATED: 401,
  UNAUTHORIZED_ROLE: 403,
  UNAUTHORIZED_APPROVER: 403,
  SELF_APPROVAL_FORBIDDEN: 403,
  APPROVAL_REQUIRED: 409,
  APPROVAL_CONFLICT: 409,
  NOT_AWAITING_APPROVAL: 409,
  NOT_QUEUEABLE: 409,
  PAYLOAD_MODIFIED: 409,
  APPROVAL_PAYLOAD_MISMATCH: 409,
  UNKNOWN_PROPOSAL: 404,
});

function registerAutomationRoutes({ app, auth, lifecycle, queue, store }) {
  if (!lifecycle) throw new Error('registerAutomationRoutes requires a lifecycle');
  if (!store) throw new Error('registerAutomationRoutes requires a store');

  const actorOf = (req) => ({
    username: String(req.user.username),
    role: String(req.user.role),
    authenticated: true,
    // Re-derived from the role table on each call, never taken from the body.
    permissions: auth.rolePermissions(req.user.role),
  });

  const tenantOf = (req) => String(req.user.tenant || '');

  /** Fail-closed: no signed-in tenant, no routes. */
  function refuseUnlessSignedIn(req, res) {
    if (!req.user || !req.user.tenant) {
      res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHENTICATED' });
      return true;
    }
    return false;
  }

  function sendDenied(res, result) {
    const status = DENIED_STATUS[result.code] || 400;
    // The code is stable and safe to expose; the reason never carries a command,
    // a parameter dump, or anything from the executor.
    return res.status(status).json({ error: result.reason || result.code, code: result.code, status });
  }

  /** A proposal the caller is allowed to know about, or null. */
  async function ownedProposal(req) {
    const proposal = await store.getProposal(String(req.params.id));
    if (!proposal) return null;
    return proposal.tenantId === tenantOf(req) ? proposal : null;
  }

  // ------------------------------------------------------------------- propose
  app.post('/api/automation/proposals', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => {
    try {
      if (refuseUnlessSignedIn(req, res)) return;
      const body = req.body || {};

      // Only catalog fields are forwarded. `body.tenant` is NOT among them, and
      // an unknown top-level field (including a smuggled `command`) is rejected
      // by validateProposal. Validating here as well as inside propose() keeps
      // the 400 specific to a malformed request instead of a policy denial.
      const shaped = {
        action: body.action,
        parameters: body.parameters,
        reason: body.reason,
        ticketId: body.ticketId,
        correlationId: body.correlationId,
        source: body.source,
      };
      const checked = catalog.validateProposal(shaped);
      if (!checked.ok) {
        return res.status(400).json({ error: checked.error, code: checked.code || 'INVALID' });
      }

      const result = await lifecycle.propose({
        actor: actorOf(req),
        tenantId: tenantOf(req),
        proposal: shaped,
      });
      if (!result.ok) return sendDenied(res, result);
      return res.status(201).json(publicView(result.proposal));
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------- read
  app.get('/api/automation/proposals/:id', auth.requireAuth(PERMISSIONS.READ), async (req, res, next) => {
    try {
      if (refuseUnlessSignedIn(req, res)) return;
      const proposal = await ownedProposal(req);
      // 404 for both "absent" and "another tenant's": the caller must not be able
      // to probe for the existence of a foreign proposal.
      if (!proposal) return res.status(404).json({ error: 'Proposal not found.', code: 'NOT_FOUND' });
      return res.json(publicView(proposal));
    } catch (err) {
      next(err);
    }
  });
  // ------------------------------------------------------------------- approve
  app.post('/api/automation/proposals/:id/approve', auth.requireAuth(PERMISSIONS.CHANGE_APPROVE), async (req, res, next) => {
    try {
      if (refuseUnlessSignedIn(req, res)) return;
      const proposalId = String(req.params.id);
      const existing = await ownedProposal(req);
      if (!existing) return res.status(404).json({ error: 'Proposal not found.', code: 'NOT_FOUND' });

      const result = await lifecycle.decide({
        proposalId,
        actor: actorOf(req),
        decision: 'APPROVED',
        reason: (req.body || {}).reason,
      });
      if (!result.ok) return sendDenied(res, result);

      // APPROVAL IS NOT EXECUTION. Approving only makes the proposal queueable;
      // the side effect happens in the worker. If publishing fails, the proposal
      // stays APPROVED and the response says so — it is never reported as queued
      // when it is not.
      let queued = false;
      let queueError = null;
      if (queue && typeof queue.publish === 'function') {
        try {
          const enqueued = await lifecycle.enqueue({ proposalId });
          if (enqueued.ok) {
            await queue.publish(enqueued.message);
            queued = true;
          } else {
            queueError = enqueued.code || 'not_queueable';
          }
        } catch (err) {
          queueError = 'publish-failed';
        }
      }

      return res.json({
        ...publicView(result.proposal),
        approval: result.approval,
        queued,
        ...(queueError ? { queueError } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------- reject
  app.post('/api/automation/proposals/:id/reject', auth.requireAuth(PERMISSIONS.CHANGE_APPROVE), async (req, res, next) => {
    try {
      if (refuseUnlessSignedIn(req, res)) return;
      const proposalId = String(req.params.id);
      const existing = await ownedProposal(req);
      if (!existing) return res.status(404).json({ error: 'Proposal not found.', code: 'NOT_FOUND' });

      const result = await lifecycle.decide({
        proposalId,
        actor: actorOf(req),
        decision: 'REJECTED',
        reason: (req.body || {}).reason,
      });
      if (!result.ok) return sendDenied(res, result);
      // A rejection queues nothing, by construction — there is no code path from
      // REJECTED into QUEUED in the state machine.
      return res.json({ ...publicView(result.proposal), queued: false });
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------- execution
  // There is intentionally NO `/execute` route. Execution is reached only by the
  // worker consuming a queue message, and even then the lifecycle re-validates
  // catalog membership, approval and the payload hash before the executor runs.

  return true;
}
  /**
 * What a client is allowed to see.
 *
 * `payloadHash` is included deliberately: it is a SHA-256 digest, not a secret,
 * and an approver verifying a proposal is better served when they can see the
 * exact fingerprint that will be re-checked at queue time and in the worker.
 */
function publicView(proposal) {
  if (!proposal) return null;
  return {
    proposalId: proposal.proposalId,
    action: proposal.action,
    parameters: proposal.parameters,
    risk: proposal.risk,
    state: proposal.state,
    tenantId: proposal.tenantId,
    ticketId: proposal.ticketId,
    correlationId: proposal.correlationId,
    requestedBy: proposal.requestedBy,
    requestedByRole: proposal.requestedByRole,
    proposalSource: proposal.proposalSource,
    payloadHash: proposal.payloadHash,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

module.exports = { registerAutomationRoutes, publicView, DENIED_STATUS };