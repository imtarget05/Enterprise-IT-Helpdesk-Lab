-- ---------------------------------------------------------------------------
-- TOCTOU binding.
--
-- The hash covers exactly what an approver approves: action + parameters. It is
-- written once when the proposal is created and is re-verified before the job is
-- queued and again before the executor runs. If the payload changes in between,
-- execution is blocked instead of running something nobody signed off.
--
-- `NOT NULL` plus no application UPDATE path: the column is append-only in
-- practice, and the verification is the real control, not the immutability.
-- ---------------------------------------------------------------------------
ALTER TABLE action_proposal
  ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS action_proposal_payload_hash_idx
  ON action_proposal (payload_hash);

-- ---------------------------------------------------------------------------
-- Approval also records the hash that was signed, so the audit trail shows what
-- was approved independently of the proposal row as it stands now.
-- ---------------------------------------------------------------------------
ALTER TABLE action_approval
  ADD COLUMN IF NOT EXISTS approved_payload_hash TEXT NOT NULL DEFAULT '';