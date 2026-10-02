'use strict';

/**
 * In-memory lifecycle store — the LOCAL/TEST adapter for `action-lifecycle.js`.
 *
 * Contract-complete with `lifecycle-store-postgres.js` (same method names, same
 * return shapes) so the governed pipeline is tested once and both adapters are
 * interchangeable. The difference that matters is stated plainly:
 *
 *   · in-memory: atomic claim = a synchronous Map check. True for ONE process.
 *     It is NOT durable across replicas: two processes share nothing.
 *   · postgres:  atomic claim = `UNIQUE (idempotency_key)` + INSERT … ON
 *     CONFLICT, which is atomic across every replica.
 *
 * `file` is opt-in and exists only to SIMULATE a process restart in tests
 * (state is written after every mutation and rehydrated at construction). It is
 * not a multi-process concurrency mechanism and must not be used as one.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { assertTransition, STATES } = require('./action-catalog');

function newId() {
  return crypto.randomUUID();
}

function emptyState() {
  return { proposals: {}, approvals: {}, executions: {}, executionByKey: {}, audit: [] };
}

function createMemoryLifecycleStore(options = {}) {
  const file = options.file ? path.resolve(options.file) : null;
  let state = emptyState();

  if (file && fs.existsSync(file)) {
    state = { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file); // atomic rename on POSIX/NTFS same volume (as store.js)
  }

  function mutate(fn) {
    const out = fn();
    persist();
    return out;
  }

  return {
    kind: 'memory',
    durable: Boolean(file),

    async createProposal(row) {
      return mutate(() => {
        const record = {
          proposalId: newId(),
          tenantId: row.tenantId,
          ticketId: row.ticketId || null,
          action: row.action,
          parameters: row.parameters || {},
          risk: row.risk,
          state: STATES.PROPOSED,
          requestedBy: row.requestedBy,
          requestedByRole: row.requestedByRole,
          correlationId: row.correlationId,
          proposalSource: row.proposalSource || 'human',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.proposals[record.proposalId] = record;
        return record;
      });
    },

    async getProposal(proposalId) {
      return state.proposals[proposalId] || null;
    },

    async setState(proposalId, nextState) {
      return mutate(() => {
        const row = state.proposals[proposalId];
        if (!row) throw Object.assign(new Error(`unknown proposal ${proposalId}`), { code: 'UNKNOWN_PROPOSAL' });
        assertTransition(row.state, nextState);
        row.state = nextState;
        row.updatedAt = new Date().toISOString();
        return row;
      });
    },

    /** Append-only: mirrors the UNIQUE (proposal_id) index in the migration. */
    async recordApproval(row) {
      return mutate(() => {
        if (state.approvals[row.proposalId]) {
          return { ok: false, code: 'ALREADY_DECIDED' };
        }
        const approval = {
          approvalId: newId(),
          proposalId: row.proposalId,
          decision: row.decision,
          approver: row.approver,
          approverRole: row.approverRole,
          proposer: row.proposer,
          isSelfApproval: Boolean(row.isSelfApproval),
          reason: row.reason || '',
          decidedAt: new Date().toISOString(),
        };
        state.approvals[row.proposalId] = approval;
        return { ok: true, approval };
      });
    },

    async getApproval(proposalId) {
      return state.approvals[proposalId] || null;
    },

    /**
     * Atomic claim on `idempotencyKey`. A second caller for the same key gets
     * `{claimed:false, duplicate:true}` and MUST NOT execute.
     */
    async claimExecution(row) {
      return mutate(() => {
        const existingId = state.executionByKey[row.idempotencyKey];
        if (existingId) {
          const existing = state.executions[existingId];
          return { claimed: false, duplicate: true, executionId: existingId, status: existing.status };
        }
        const execution = {
          executionId: newId(),
          proposalId: row.proposalId,
          idempotencyKey: row.idempotencyKey,
          tenantId: row.tenantId,
          workerId: row.workerId,
          attempt: row.attempt || 1,
          status: 'CLAIMED',
          approvalId: row.approvalId || null,
          approvalState: row.approvalState || 'NOT_REQUIRED',
          result: null,
          postCheck: null,
          claimedAt: new Date().toISOString(),
          finishedAt: null,
        };
        state.executions[execution.executionId] = execution;
        state.executionByKey[row.idempotencyKey] = execution.executionId;
        return { claimed: true, duplicate: false, executionId: execution.executionId, status: 'CLAIMED' };
      });
    },

    async finishExecution(row) {
      return mutate(() => {
        const execution = state.executions[row.executionId];
        if (!execution) throw Object.assign(new Error(`unknown execution ${row.executionId}`), { code: 'UNKNOWN_EXECUTION' });
        if (execution.status !== 'CLAIMED') {
          return { ok: false, code: 'ALREADY_FINISHED', status: execution.status };
        }
        execution.status = row.status;
        execution.result = row.result === undefined ? null : row.result;
        execution.postCheck = row.postCheck === undefined ? null : row.postCheck;
        execution.finishedAt = new Date().toISOString();
        return { ok: true, execution };
      });
    },

    async listExecutions(proposalId) {
      return Object.values(state.executions).filter((e) => !proposalId || e.proposalId === proposalId);
    },

    async getExecutionByKey(idempotencyKey) {
      const id = state.executionByKey[idempotencyKey];
      return id ? state.executions[id] : null;
    },

    /** Bounded retry: only a FAILED (retryable) execution may be reclaimed. */
    async reclaimExecution(row) {
      return mutate(() => {
        const execution = state.executions[row.executionId];
        if (!execution || execution.status !== 'FAILED') {
          return { ok: false, code: 'NOT_RECLAIMABLE' };
        }
        execution.status = 'CLAIMED';
        execution.attempt += 1;
        execution.result = null;
        execution.finishedAt = null;
        return { ok: true, execution, attempt: execution.attempt };
      });
    },

    async appendAudit(event) {
      return mutate(() => {
        const row = { ...event, createdAt: new Date().toISOString() };
        state.audit.push(row);
        return row;
      });
    },

    async listAudit(filter = {}) {
      return state.audit.filter((e) => (!filter.proposalId || e.proposalId === filter.proposalId)
        && (!filter.event || e.event === filter.event));
    },

    /** Test-only: inspect raw state (never used by the pipeline). */
    async _raw() {
      return state;
    },

    async close() {
      return undefined;
    },
  };
}

module.exports = { createMemoryLifecycleStore };