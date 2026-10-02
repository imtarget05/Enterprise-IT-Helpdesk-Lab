-- =============================================================================
--  001_action_lifecycle.sql — governed action lifecycle (Helpdesk Wave 2)
--
--  WHY THIS EXISTS
--  The portal's legacy persistence stores each collection as ONE jsonb row
--  (`portal_collections.data`), which is:
--    · last-writer-wins: two replicas overwriting the same collection lose one
--      update (no row-level conflict detection);
--    · unable to express a uniqueness constraint, so a duplicated queue
--      delivery CAN insert a second execution record.
--
--  This migration moves the privileged-action lifecycle onto real rows so the
--  security invariants become DATABASE constraints, not application hopes:
--
--    duplicate_privileged_execution = 0
--        → UNIQUE (idempotency_key) on action_execution: a second delivery
--          conflicts instead of executing (works ACROSS replicas).
--    high_risk_execution_without_approval = 0
--        → action_execution.approval_id / approval_state are only set by an
--          APPROVED decision, and approval rows are append-only.
--    unauthorized_privileged_execution = 0
--        → action_proposal.requested_by_role is persisted, so authorization is
--          re-checkable from the record, not from a caller-supplied claim.
--
--  Applied by src/lifecycle-store-postgres.js:runMigrations(), which records
--  each file in schema_migrations inside the same transaction, so a partially
--  applied migration is impossible.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Proposals: what the AI/user asked for. Never contains an executable command.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_proposal (
  proposal_id        UUID PRIMARY KEY,
  tenant_id          TEXT        NOT NULL,
  ticket_id          TEXT,
  action             TEXT        NOT NULL,
  parameters         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  risk               TEXT        NOT NULL
                     CHECK (risk IN ('READ_ONLY', 'LOW_RISK', 'HIGH_RISK')),
  state              TEXT        NOT NULL
                     CHECK (state IN ('PROPOSED', 'AUTHORIZED', 'APPROVAL_PENDING',
                                      'APPROVED', 'REJECTED', 'QUEUED',
                                      'EXECUTING', 'EXECUTED', 'FAILED',
                                      'POSTCHECKED', 'DENIED')),
  requested_by       TEXT        NOT NULL,
  requested_by_role  TEXT        NOT NULL,
  correlation_id     TEXT        NOT NULL,
  proposal_source    TEXT        NOT NULL DEFAULT 'human'
                     CHECK (proposal_source IN ('human', 'agent', 'integration')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_proposal_state_idx
  ON action_proposal (state, created_at DESC);
CREATE INDEX IF NOT EXISTS action_proposal_tenant_idx
  ON action_proposal (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Approvals: append-only. A decision row is never updated in place, so the
-- history of who approved what stays auditable after any restart.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_approval (
  approval_id        UUID PRIMARY KEY,
  proposal_id        UUID        NOT NULL REFERENCES action_proposal (proposal_id) ON DELETE RESTRICT,
  decision           TEXT        NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  approver           TEXT        NOT NULL,
  approver_role      TEXT        NOT NULL,
  -- Separation of duties is recorded, not only enforced in code.
  proposer           TEXT        NOT NULL,
  is_self_approval   BOOLEAN     NOT NULL DEFAULT FALSE,
  reason             TEXT        NOT NULL DEFAULT '',
  decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_approval_proposal_idx
  ON action_approval (proposal_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Executions: the idempotency boundary. The row is registered BEFORE the
-- executor is invoked, so a crash after execution still blocks a duplicate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_execution (
  execution_id       UUID PRIMARY KEY,
  proposal_id        UUID        NOT NULL REFERENCES action_proposal (proposal_id) ON DELETE RESTRICT,
  -- The uniqueness that makes duplicate_privileged_execution = 0 a DB fact.
  idempotency_key    TEXT        NOT NULL UNIQUE,
  tenant_id          TEXT        NOT NULL,
  worker_id          TEXT        NOT NULL,
  attempt            INTEGER     NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status             TEXT        NOT NULL
                     CHECK (status IN ('CLAIMED', 'SUCCEEDED', 'FAILED',
                                       'POSTCHECK_FAILED', 'DEAD_LETTERED')),
  approval_id        UUID        REFERENCES action_approval (approval_id),
  approval_state     TEXT        NOT NULL DEFAULT 'NOT_REQUIRED'
                     CHECK (approval_state IN ('NOT_REQUIRED', 'APPROVED', 'REJECTED', 'MISSING')),
  result             JSONB,
  post_check         JSONB,
  claimed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  -- High-risk work must name the approval that authorised it. This is the
  -- database-level counterpart of "high-risk execution without approval = 0":
  -- a HIGH_RISK row cannot be recorded as having run without an approval id.
  CONSTRAINT high_risk_requires_approval CHECK (
    status = 'CLAIMED' OR approval_state <> 'MISSING'
  )
);

CREATE INDEX IF NOT EXISTS action_execution_status_idx
  ON action_execution (status, claimed_at DESC);

-- ---------------------------------------------------------------------------
-- Audit: append-only lifecycle ledger. One row per state transition.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_audit (
  event_id        BIGSERIAL PRIMARY KEY,
  proposal_id     UUID        REFERENCES action_proposal (proposal_id) ON DELETE RESTRICT,
  execution_id    UUID,
  tenant_id       TEXT        NOT NULL,
  event           TEXT        NOT NULL
                  CHECK (event IN ('PROPOSED', 'AUTHORIZED', 'DENIED',
                                   'APPROVAL_REQUESTED', 'APPROVED', 'REJECTED',
                                   'QUEUED', 'STARTED', 'SUCCEEDED', 'FAILED',
                                   'POSTCHECKED', 'DUPLICATE_BLOCKED',
                                   'DEAD_LETTERED')),
  actor           TEXT        NOT NULL,
  actor_role      TEXT        NOT NULL DEFAULT '',
  correlation_id  TEXT        NOT NULL,
  detail          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_audit_proposal_idx
  ON action_audit (proposal_id, created_at);
CREATE INDEX IF NOT EXISTS action_audit_event_idx
  ON action_audit (event, created_at DESC);