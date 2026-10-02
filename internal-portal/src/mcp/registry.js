'use strict';

/**
 * MCP registry.
 *
 * Composes the read surface (`read-tools.js`) and the single write surface
 * (`propose.js`) behind one invocation boundary that:
 *
 *   - requires an authenticated, tenant-bearing context;
 *   - validates arguments against each tool's allow-list schema;
 *   - never exposes an execution method;
 *   - records an audit entry per call.
 *
 * The "no execute" property is asserted in two places on purpose: the registry
 * refuses any name containing `execute`/`run`/`invoke`-style verbs at call time,
 * AND `toolNames()` is asserted in tests to contain no such tool. The first is
 * defence; the second is the evidence.
 */

const { createMcpContext, validateArgs, McpError } = require('./context');
const { READ_TOOLS } = require('./read-tools');
const { PROPOSE_TOOL } = require('./propose');

/**
 * Name fragments that would indicate an execution surface.
 *
 * `invoke` is excluded on purpose — every tool is invoked, so the fragment
 * would match everything. The point is to catch a tool that would let the model
 * cause an effect outside the proposal chain.
 */
const EXECUTION_NAME_FRAGMENTS = Object.freeze(['execute', 'exec_', '.exec', 'run_', 'shell', 'powershell', 'sql']);

const ALL_TOOLS = Object.freeze([...READ_TOOLS, PROPOSE_TOOL]);

function looksLikeExecution(name) {
  const n = String(name).toLowerCase();
  return EXECUTION_NAME_FRAGMENTS.some((frag) => n.includes(frag));
}

/**
 * Assert the registry carries no execution surface.
 *
 * Exported so a test can call it directly and so any future code that
 * assembles tools from elsewhere can assert the same invariant before shipping.
 */
function assertNoExecutionSurface(tools = ALL_TOOLS) {
  const offenders = tools.map((t) => t.name).filter(looksLikeExecution);
  if (offenders.length) {
    throw new Error(`MCP registry must not expose execution tools: ${offenders.join(', ')}`);
  }
  return true;
}

function createMcpRegistry(options = {}) {
  const tools = options.tools || ALL_TOOLS;
  const audit = options.audit || (() => {});
  assertNoExecutionSurface(tools);

  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    tools,
    byName,
    readOnlyNames: tools.filter((t) => t.readOnly).map((t) => t.name),
    writeNames: tools.filter((t) => !t.readOnly).map((t) => t.name),

    /** Names as exposed to a model. Descriptions are included so the model can choose. */
    toolNames() {
      return tools.map((t) => t.name);
    },

    /** Tool definitions in a model-facing shape. Contains no internal handlers. */
    describe() {
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        readOnly: t.readOnly,
        parameters: t.parameters,
      }));
    },

    /**
     * Invoke a tool.
     *
     * `ctx` must already be a frozen MCP context. It is not built here, because
     * building it per call would make it easy to pass a caller-supplied tenant
     * into a constructor that looks neutral.
     */
    async call(name, args, ctx, meta = {}) {
      const toolName = typeof name === 'string' ? name.trim() : '';
      if (!toolName) return fail('invalid_tool_name', 'Thiếu tên tool.');
      if (looksLikeExecution(toolName)) {
        // No such tool exists, so this is unreachable through the map below.
        // It is here so that a future rename cannot quietly open an execution
        // path without also having to delete this branch.
        return fail('execution_not_available', `Tool "${toolName}" không tồn tại trên bề mặt MCP.`);
      }

      const tool = byName.get(toolName);
      if (!tool) return fail('unknown_tool', `Tool không tồn tại: ${toolName}`);

      if (!ctx || !ctx.tenant || !ctx.actor) {
        return fail('unauthenticated', 'MCP call thiếu người dùng đã xác thực hoặc tenant.', 401);
      }

      try {
        const result = await tool.handler({ args: args || {}, ctx });
        audit({
          event: 'mcp.call',
          tool: toolName,
          // Business arguments only. Never the raw payload, never a secret.
          args: summariseArgs(args),
          tenant: ctx.tenant,
          actor: ctx.actor,
          correlationId: meta.correlationId || ctx.correlationId || '',
          outcome: 'ok',
        });
        return { ok: true, tool: toolName, result };
      } catch (err) {
        audit({
          event: 'mcp.call',
          tool: toolName,
          args: summariseArgs(args),
          tenant: ctx.tenant,
          actor: ctx.actor,
          correlationId: meta.correlationId || ctx.correlationId || '',
          outcome: 'error',
          code: err.code || 'tool_error',
        });
        return {
          ok: false,
          tool: toolName,
          code: err.code || 'tool_error',
          error: err.message || String(err),
          details: err.details || undefined,
          status: err.status,
        };
      }
    },
  };
}

/**
 * Argument shape for the audit log: keys and value lengths, never values.
 *
 * A ticket title or a runbook excerpt is not sensitive enough to justify
 * recording it twice, and the audit trail is a place where secrets end up if
 * anyone ever passes one. Shapes are enough to answer "who asked for what,
 * roughly how much".
 */
function summariseArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' ? { length: v.length } : { type: typeof v };
  }
  return out;
}

function fail(code, error, status) {
  return { ok: false, code, error, status };
}

module.exports = {
  createMcpRegistry,
  createMcpContext,
  validateArgs,
  assertNoExecutionSurface,
  looksLikeExecution,
  McpError,
  ALL_TOOLS,
  EXECUTION_NAME_FRAGMENTS,
};