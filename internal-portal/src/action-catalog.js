'use strict';

const crypto = require('node:crypto');

/**
 * Deterministic action catalog — the runtime policy for privileged automation.
 *
 * This is the Node-side counterpart of `llm-gateway/automation/policy.py`
 * (`ACTION_RISK`) and `models.py` (`SUPPORTED_ACTIONS`). The AI may PROPOSE an
 * action id from this catalog; it can never widen it. Risk classification, who
 * may propose, who may approve and the legal state transitions all live here as
 * deterministic code — never in a prompt.
 *
 * Drift between the two languages is itself a defect, so
 * `test/action-lifecycle.test.js` parses the Python files and asserts the two
 * catalogs are identical. Adding an action to one side without the other FAILS.
 */

const RISK = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  LOW_RISK: 'LOW_RISK',
  HIGH_RISK: 'HIGH_RISK',
  UNKNOWN: 'UNKNOWN',
});

/** action id → risk. Mirrors policy.ACTION_RISK exactly (parity-tested). */
const ACTION_RISK = Object.freeze({
  test_network_health: RISK.READ_ONLY,
  test_print_scan_health: RISK.READ_ONLY,
  export_it_asset_audit: RISK.LOW_RISK,
  backup_helpdesk_data: RISK.LOW_RISK,
  backup_ad_configuration: RISK.LOW_RISK,
  new_company_user: RISK.HIGH_RISK,
  disable_company_user: RISK.HIGH_RISK,
  restore_helpdesk_data: RISK.HIGH_RISK,
});

/** Roles allowed to PROPOSE automation (policy.AUTOMATION_ROLES). */
const AUTOMATION_ROLES = Object.freeze(['IT_ADMIN', 'HELPDESK_L2']);

/** Permission that grants approval authority (only IT_ADMIN holds it today). */
const APPROVAL_PERMISSION = 'change:approve';

/**
 * Fields that prove the proposer tried to smuggle an executable command.
 * Mirrors models.RAW_COMMAND_FIELDS; defense in depth only — the real boundary
 * is that no executor path accepts a command string at all.
 */
const RAW_COMMAND_FIELDS = Object.freeze([
  'command', 'powershell', 'script', 'script_text', 'script_path',
  'shell', 'cmd', 'command_text', 'ps_command', 'invoke', 'argv', 'exe',
]);

const ALLOWED_PROPOSAL_FIELDS = Object.freeze([
  'action', 'parameters', 'reason', 'ticketId', 'correlationId', 'source',
]);

/**
 * Canonical JSON: keys sorted at every depth, so two structurally equal
 * payloads always serialise identically. Without this, `{a:1,b:2}` and
 * `{b:2,a:1}` would hash differently and an approval could be invalidated by a
 * key-order change alone.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/**
 * Fingerprint of the part of a proposal an approver is actually approving:
 * the action and its parameters. Reason/ticketId are descriptive, so changing
 * them does not invalidate an approval; changing WHAT will run does.
 *
 * This is the TOCTOU binding. `decide()` records the hash with the approval and
 * `enqueue()`/`execute()` re-verify it, so a proposal that is mutated between
 * approval and execution is blocked instead of running something nobody
 * signed off.
 */
function proposalPayloadHash(proposal) {
  const material = canonicalize({
    action: proposal && proposal.action,
    parameters: (proposal && proposal.parameters) || {},
  });
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

function payloadHashMatches(expected, proposal) {
  if (typeof expected !== 'string' || !expected) return false;
  return expected === proposalPayloadHash(proposal);
}

const STATES = Object.freeze({
  PROPOSED: 'PROPOSED',
  AUTHORIZED: 'AUTHORIZED',
  DENIED: 'DENIED',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  QUEUED: 'QUEUED',
  EXECUTING: 'EXECUTING',
  EXECUTED: 'EXECUTED',
  FAILED: 'FAILED',
  POSTCHECKED: 'POSTCHECKED',
});

/**
 * Legal transitions. Anything absent is ILLEGAL and throws — a rejected
 * proposal can never reach QUEUED, and nothing can skip approval into EXECUTING
 * for a HIGH_RISK action.
 */
const TRANSITIONS = Object.freeze({
  [STATES.PROPOSED]: [STATES.AUTHORIZED, STATES.APPROVAL_PENDING, STATES.DENIED],
  [STATES.AUTHORIZED]: [STATES.QUEUED],
  [STATES.APPROVAL_PENDING]: [STATES.APPROVED, STATES.REJECTED],
  [STATES.APPROVED]: [STATES.QUEUED],
  [STATES.REJECTED]: [],
  [STATES.DENIED]: [],
  [STATES.QUEUED]: [STATES.EXECUTING],
  [STATES.EXECUTING]: [STATES.EXECUTED, STATES.FAILED],
  [STATES.EXECUTED]: [STATES.POSTCHECKED],
  [STATES.FAILED]: [],
  [STATES.POSTCHECKED]: [],
});

/** States from which a privileged side effect must never be started. */
const TERMINAL_STATES = Object.freeze([STATES.REJECTED, STATES.DENIED, STATES.FAILED, STATES.POSTCHECKED]);

function actionRisk(action) {
  return ACTION_RISK[action] || RISK.UNKNOWN;
}

function isKnownAction(action) {
  return Object.prototype.hasOwnProperty.call(ACTION_RISK, String(action));
}

function requiresApproval(action) {
  return actionRisk(action) === RISK.HIGH_RISK;
}

function canPropose(role) {
  return AUTOMATION_ROLES.includes(String(role || ''));
}

/** Fail-closed validation of the proposal shape (mirrors models.validate_proposal). */
function validateProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, code: 'INVALID', error: 'proposal must be an object' };
  }
  const rawHits = RAW_COMMAND_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(proposal, f));
  if (rawHits.length) {
    return { ok: false, code: 'INVALID', error: `raw command field rejected: ${rawHits.join(',')}`, rawFields: rawHits };
  }
  const unknown = Object.keys(proposal).filter((k) => !ALLOWED_PROPOSAL_FIELDS.includes(k));
  if (unknown.length) {
    return { ok: false, code: 'INVALID', error: `unknown top-level fields: ${unknown.join(',')}`, unknownFields: unknown };
  }
  const action = proposal.action;
  if (typeof action !== 'string' || !action) {
    return { ok: false, code: 'INVALID', error: 'missing action id' };
  }
  if (!isKnownAction(action)) {
    return { ok: false, code: 'UNKNOWN_ACTION', error: `unknown action: ${String(action).slice(0, 80)}`, action };
  }
  const parameters = proposal.parameters === undefined ? {} : proposal.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { ok: false, code: 'INVALID', error: 'parameters must be an object', action };
  }
  return {
    ok: true,
    action,
    parameters: { ...parameters },
    reason: typeof proposal.reason === 'string' ? proposal.reason : '',
    ticketId: proposal.ticketId === undefined ? null : String(proposal.ticketId),
    correlationId: proposal.correlationId === undefined ? null : String(proposal.correlationId),
    source: ['human', 'agent', 'integration'].includes(proposal.source) ? proposal.source : 'human',
  };
}

/** Throws unless `from → to` is a legal transition. Deterministic, no AI input. */
function assertTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    const error = new Error(`illegal transition ${from} → ${to}`);
    error.code = 'ILLEGAL_TRANSITION';
    error.expose = true;
    throw error;
  }
  return true;
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

module.exports = {
  RISK,
  STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  ACTION_RISK,
  AUTOMATION_ROLES,
  APPROVAL_PERMISSION,
  RAW_COMMAND_FIELDS,
  ALLOWED_PROPOSAL_FIELDS,
  actionRisk,
  isKnownAction,
  requiresApproval,
  canPropose,
  validateProposal,
  assertTransition,
  isTerminal,
  canonicalize,
  proposalPayloadHash,
  payloadHashMatches,
};