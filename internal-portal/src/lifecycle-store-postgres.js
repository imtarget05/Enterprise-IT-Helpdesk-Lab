'use strict';

/**
 * PostgreSQL lifecycle store — the DURABLE adapter for `action-lifecycle.js`.
 *
 * Contract-identical to `lifecycle-store-memory.js`, but the atomicity comes
 * from the database instead of the process:
 *
 *   claimExecution()  → INSERT … ON CONFLICT (idempotency_key) DO NOTHING
 *                       RETURNING execution_id
 *   setState()        → SELECT … FOR UPDATE, then UPDATE (row lock)
 *   recordApproval()  → INSERT; a second decision raises 23505 on the unique
 *                       index `action_approval_one_decision_idx`
 *
 * That is what makes the security invariants hold ACROSS replicas:
 * duplicate_privileged_execution = 0 is enforced by a uniqueness constraint, so
 * two workers racing on the same message cannot both execute it — regardless of
 * which replica each one runs on or whether either one restarted.
 *
 * Migrations are real files in `internal-portal/migrations/`, applied in name
 * order and recorded in `schema_migrations` inside the same transaction, so a
 * half-applied migration cannot exist.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Pool } = require('pg');

const { assertTransition, STATES } = require('./action-catalog');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const UNIQUE_VIOLATION = '23505';

function createPostgresLifecycleStore(options = {}) {
  const pool = options.pool || new Pool({
    connectionString: options.connectionString || process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_MAX_POOL || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  async function runMigrations() {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const client = await pool.connect();
    try {
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
      );
      const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      client.release();
    }
  }

  function mapProposal(row) {
    if (!row) return null;
    return {
      proposalId: row.proposal_id,
      tenantId: row.tenant_id,
      ticketId: row.ticket_id,
      action: row.action,
      parameters: row.parameters,
      risk: row.risk,
      state: row.state,
      requestedBy: row.requested_by,
      requestedByRole: row.requested_by_role,
      correlationId: row.correlation_id,
      proposalSource: row.proposal_source,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  return {
    kind: 'postgres',
    durable: true,
    pool,
    runMigrations,

    async createProposal(row) {
      const proposalId = crypto.randomUUID();
      const res = await pool.query(
        `INSERT INTO action_proposal
           (proposal_id, tenant_id, ticket_id, action, parameters, risk, state,
            requested_by, requested_by_role, correlation_id, proposal_source)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,'PROPOSED',$7,$8,$9,$10)
         RETURNING *`,
        [proposalId, row.tenantId, row.ticketId || null, row.action,
          JSON.stringify(row.parameters || {}), row.risk, row.requestedBy,
          row.requestedByRole, row.correlationId, row.proposalSource || 'human'],
      );
      return mapProposal(res.rows[0]);
    },

    async getProposal(proposalId) {
      const res = await pool.query('SELECT * FROM action_proposal WHERE proposal_id = $1', [proposalId]);
      return mapProposal(res.rows[0]);
    },

    /** Row-locked transition: two replicas cannot both move the same proposal. */
    async setState(proposalId, nextState) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(
          'SELECT state FROM action_proposal WHERE proposal_id = $1 FOR UPDATE', [proposalId],
        );
        if (!current.rows.length) {
          throw Object.assign(new Error(`unknown proposal ${proposalId}`), { code: 'UNKNOWN_PROPOSAL' });
        }
        assertTransition(current.rows[0].state, nextState);
        const updated = await client.query(
          'UPDATE action_proposal SET state = $2, updated_at = NOW() WHERE proposal_id = $1 RETURNING *',
          [proposalId, nextState],
        );
        await client.query('COMMIT');
        return mapProposal(updated.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    /** Append-only; a second decision for the same proposal fails on the index. */
    async recordApproval(row) {
      const approvalId = crypto.randomUUID();
      try {
        const res = await pool.query(
          `INSERT INTO action_approval
             (approval_id, proposal_id, decision, approver, approver_role, proposer,
              is_self_approval, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [approvalId, row.proposalId, row.decision, row.approver, row.approverRole,
            row.proposer, Boolean(row.isSelfApproval), row.reason || ''],
        );
        const a = res.rows[0];
        return {
          ok: true,
          approval: {
            approvalId: a.approval_id,
            proposalId: a.proposal_id,
            decision: a.decision,
            approver: a.approver,
            approverRole: a.approver_role,
            proposer: a.proposer,
            isSelfApproval: a.is_self_approval,
            reason: a.reason,
            decidedAt: a.decided_at.toISOString(),
          },
        };
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) return { ok: false, code: 'ALREADY_DECIDED' };
        throw err;
      }
    },

    async getApproval(proposalId) {
      const res = await pool.query(
        'SELECT * FROM action_approval WHERE proposal_id = $1 ORDER BY decided_at DESC LIMIT 1', [proposalId],
      );
      const a = res.rows[0];
      if (!a) return null;
      return {
        approvalId: a.approval_id,
        proposalId: a.proposal_id,
        decision: a.decision,
        approver: a.approver,
        approverRole: a.approver_role,
        proposer: a.proposer,
        isSelfApproval: a.is_self_approval,
        reason: a.reason,
        decidedAt: a.decided_at.toISOString(),
      };
    },

    /**
     * THE idempotency boundary. `ON CONFLICT DO NOTHING` makes the claim atomic
     * across replicas: whoever inserts the row wins, every later delivery gets
     * rowCount 0 and must not execute. No application lock is involved, so it
     * holds even when the deliveries land on different containers.
     */
    async claimExecution(row) {
      const executionId = crypto.randomUUID();
      const res = await pool.query(
        `INSERT INTO action_execution
           (execution_id, proposal_id, idempotency_key, tenant_id, worker_id, attempt,
            status, approval_id, approval_state)
         VALUES ($1,$2,$3,$4,$5,$6,'CLAIMED',$7,$8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING execution_id`,
        [executionId, row.proposalId, row.idempotencyKey, row.tenantId, row.workerId,
          row.attempt || 1, row.approvalId || null, row.approvalState || 'NOT_REQUIRED'],
      );
      if (res.rowCount === 0) {
        const existing = await pool.query(
          'SELECT execution_id, status FROM action_execution WHERE idempotency_key = $1', [row.idempotencyKey],
        );
        return {
          claimed: false,
          duplicate: true,
          executionId: existing.rows[0] ? existing.rows[0].execution_id : null,
          status: existing.rows[0] ? existing.rows[0].status : 'UNKNOWN',
        };
      }
      return { claimed: true, duplicate: false, executionId, status: 'CLAIMED' };
    },

    async finishExecution(row) {
      const res = await pool.query(
        `UPDATE action_execution
            SET status = $2, result = $3::jsonb, post_check = $4::jsonb, finished_at = NOW()
          WHERE execution_id = $1 AND status = 'CLAIMED'
          RETURNING execution_id, status`,
        [row.executionId, row.status,
          row.result === undefined ? null : JSON.stringify(row.result),
          row.postCheck === undefined ? null : JSON.stringify(row.postCheck)],
      );
      if (res.rowCount === 0) {
        const current = await pool.query('SELECT status FROM action_execution WHERE execution_id = $1', [row.executionId]);
        return { ok: false, code: 'ALREADY_FINISHED', status: current.rows[0] ? current.rows[0].status : 'UNKNOWN' };
      }
      return { ok: true, execution: { executionId: row.executionId, status: res.rows[0].status } };
    },

    async listExecutions(proposalId) {
      const res = await pool.query(
        'SELECT * FROM action_execution WHERE ($1::uuid IS NULL OR proposal_id = $1) ORDER BY claimed_at DESC',
        [proposalId || null],
      );
      return res.rows.map((e) => ({
        executionId: e.execution_id,
        proposalId: e.proposal_id,
        idempotencyKey: e.idempotency_key,
        status: e.status,
        approvalState: e.approval_state,
        result: e.result,
        postCheck: e.post_check,
      }));
    },

    async getExecutionByKey(idempotencyKey) {
      const res = await pool.query('SELECT * FROM action_execution WHERE idempotency_key = $1', [idempotencyKey]);
      const e = res.rows[0];
      if (!e) return null;
      return {
        executionId: e.execution_id,
        proposalId: e.proposal_id,
        idempotencyKey: e.idempotency_key,
        status: e.status,
        attempt: e.attempt,
        approvalState: e.approval_state,
        result: e.result,
        postCheck: e.post_check,
      };
    },

    /** Bounded retry: only a FAILED execution may be reclaimed; the guard is in SQL. */
    async reclaimExecution(row) {
      const res = await pool.query(
        `UPDATE action_execution
            SET status = 'CLAIMED', attempt = attempt + 1, result = NULL,
                post_check = NULL, finished_at = NULL
          WHERE execution_id = $1 AND status = 'FAILED'
          RETURNING attempt`,
        [row.executionId],
      );
      if (res.rowCount === 0) return { ok: false, code: 'NOT_RECLAIMABLE' };
      return { ok: true, attempt: res.rows[0].attempt };
    },

    async appendAudit(event) {
      await pool.query(
        `INSERT INTO action_audit
           (proposal_id, execution_id, tenant_id, event, actor, actor_role, correlation_id, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [event.proposalId || null, event.executionId || null, event.tenantId, event.event,
          event.actor, event.actorRole || '', event.correlationId,
          JSON.stringify(event.detail || {})],
      );
      return { ...event, createdAt: new Date().toISOString() };
    },

    async listAudit(filter = {}) {
      const res = await pool.query(
        `SELECT * FROM action_audit
          WHERE ($1::uuid IS NULL OR proposal_id = $1)
            AND ($2::text IS NULL OR event = $2)
          ORDER BY event_id`,
        [filter.proposalId || null, filter.event || null],
      );
      return res.rows.map((e) => ({
        proposalId: e.proposal_id,
        executionId: e.execution_id,
        tenantId: e.tenant_id,
        event: e.event,
        actor: e.actor,
        actorRole: e.actor_role,
        correlationId: e.correlation_id,
        detail: e.detail,
        createdAt: e.created_at.toISOString(),
      }));
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPostgresLifecycleStore, UNIQUE_VIOLATION };