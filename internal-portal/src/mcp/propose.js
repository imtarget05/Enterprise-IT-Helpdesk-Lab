'use strict';

/**
 * `automation.propose` — the single MCP write surface.
 *
 * There is deliberately no `automation.execute`. The registry's whole argument
 * is that proposing is a business intent and executing is a deterministic
 * worker's job, and that split only holds if no code path lets the model reach
 * the executor. Adding an execute tool would collapse it.
 *
 * Authority fields — tenant, actor, roles, correlation id — come from the frozen
 * MCP context, never from the model's arguments. The model's contribution is the
 * business intent: which catalogued action, which target, which typed
 * parameters, and why.
 *
 * The tool does NOT decide risk and does NOT decide approval. It hands a typed
 * proposal to the existing deterministic policy, which is the same policy the
 * HTTP lifecycle uses. IT_ADMIN does not gain an automatic bypass of a
 * HIGH_RISK approval here; that decision belongs to policy, not to this file.
 */

const { ACTION_RISK, RISK, AUTOMATION_ROLES, RAW_COMMAND_FIELDS, canonicalize } = require('../action-catalog');
const { validateArgs, McpError } = require('./context');

/** Actions the model may propose: every catalogued action, no more. */
const PROPOSABLE = Object.freeze(Object.keys(ACTION_RISK));

const PROPOSE_TOOL = {
  name: 'automation.propose',
  description:
    'ĐỀ XUẤT một hành động tự động hoá đã được catalog. Đây KHÔNG phải thực thi: '
    + 'đề xuất được chuyển vào chính sách rủi ro và, khi cần, chờ người duyệt.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      actionType: { type: 'string', description: `Một trong: ${PROPOSABLE.join(', ')}` },
      targetId: { type: 'string', description: 'Đối tượng đích, ví dụ mã ticket hoặc user' },
      reason: { type: 'string', description: 'Lý do đề xuất, để người duyệt hiểu bối cảnh' },
      correlationId: { type: 'string', description: 'Mã định danh để truy vết, không mang ý nghĩa phân quyền' },
    },
    required: ['actionType', 'reason'],
  },

  async handler({ args, ctx }) {
    const a = validateArgs(PROPOSE_TOOL, args);

    // Defence in depth on the raw-command surface. The schema already rejects
    // these names, so reaching this branch means something upstream changed.
    for (const key of Object.keys(a)) {
      const canonical = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (RAW_COMMAND_FIELDS.map((f) => f.toLowerCase()).includes(canonical)) {
        throw new McpError('raw_command_field', `Tham số "${key}" không được chấp nhận.`, { field: key });
      }
    }

    if (!PROPOSABLE.includes(a.actionType)) {
      throw new McpError('unknown_action', `actionType "${a.actionType}" không có trong catalog.`, {
        actionType: a.actionType,
        allowed: PROPOSABLE,
      });
    }

    // Deterministic RBAC. The model cannot grant itself a role: `ctx.role` comes
    // from the authenticated session, never from the arguments.
    if (!AUTOMATION_ROLES.includes(ctx.role)) {
      throw new McpError('forbidden_role', `Vai trò ${ctx.role} không được đề xuất hành động tự động hoá.`, {
        allowed: AUTOMATION_ROLES,
      });
    }

    // Risk is a property of the catalogued action, computed here rather than
    // asked of the model. The model cannot declare an action "low risk".
    const risk = ACTION_RISK[a.actionType] || RISK.UNKNOWN;

    // `canonicalize` returns a canonical JSON STRING for hashing. The proposal
    // handed back to the caller is parsed so authority fields are addressable
    // properties rather than requiring the caller to parse a blob.
    const proposal = JSON.parse(canonicalize({
      actionType: a.actionType,
      targetId: a.targetId || '',
      parameters: {},
      reason: a.reason,
      risk,
      // Authority provenance. A reviewer reading the audit trail can see these
      // were derived, not supplied.
      tenantId: ctx.tenant,
      actor: ctx.actor,
      role: ctx.role,
      correlationId: a.correlationId || ctx.correlationId || '',
      source: 'mcp',
    }));

    return {
      proposed: true,
      // Explicitly NOT executed, and the caller is told where it goes next.
      state: 'PROPOSED',
      executed: false,
      risk,
      // High risk must not be presented as merely "proposed": the caller should
      // learn that a human is required, not discover it at the approval screen.
      requiresApproval: risk === RISK.HIGH_RISK || risk === RISK.UNKNOWN,
      proposal,
    };
  },
};

module.exports = { PROPOSE_TOOL, PROPOSABLE };