'use strict';

/**
 * MCP READ tools.
 *
 * Architecturally separate from the proposal surface (`propose.js`) on purpose.
 * A read server that also held a write method is one refactor away from exposing
 * execution; keeping them in different modules makes "the read surface cannot
 * mutate anything" checkable by import alone.
 *
 * Every tool takes its tenant from the frozen MCP context and refuses to run
 * without one. Tenant is not an argument, so there is no argument to get wrong.
 *
 * `knowledge.search` delegates to the Wave A RAG entry point rather than
 * reimplementing retrieval. A second retrieval path would be a second place for
 * the tenant filter to be wrong, and the point of Wave A was that the filter
 * lives before ranking in exactly one function.
 */

const { rowsVisibleTo, findVisible } = require('../tenant-scope');
const { retrieve, formatContext } = require('../rag');
const { validateArgs, McpError } = require('./context');

/** Fields returned for a ticket. Deliberately an allow-list, never the row. */
function ticketSummary(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    category: row.category,
    dept: row.dept,
    requester: row.requester,
  };
}

function assetSummary(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    assignedTo: row.assignedTo,
    location: row.location,
  };
}

/** Clamp a caller-supplied page size into a range the model cannot exceed. */
function limitOf(value, fallback, max) {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

const READ_TOOLS = [
  {
    name: 'ticket.get',
    description: 'Đọc một ticket theo mã. Chỉ trả về ticket thuộc tenant của phiên đã xác thực.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: { ticketId: { type: 'string', description: 'Mã ticket' } },
      required: ['ticketId'],
    },
    async handler({ args, ctx }) {
      const a = validateArgs(READ_TOOLS[0], args);
      const rows = rowsVisibleTo(ctx.store.data.tickets, ctx.user);
      const hit = findVisible(rows, ctx.user, a.ticketId);
      // 404 for both "absent" and "belongs to someone else": distinguishing them
      // is itself a cross-tenant disclosure.
      if (!hit.found) throw new McpError('not_found', `Không tìm thấy ticket ${a.ticketId}.`);
      return { ticket: ticketSummary(hit.row) };
    },
  },
  {
    name: 'ticket.search',
    description: 'Tìm ticket thuộc tenant hiện tại theo từ khoá.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Từ khoá trong tiêu đề/mô tả' },
        limit: { type: 'string', description: 'Số kết quả tối đa (1-50)' },
      },
      required: ['query'],
    },
    async handler({ args, ctx }) {
      const a = validateArgs(READ_TOOLS[1], args);
      const needle = a.query.toLowerCase();
      const rows = rowsVisibleTo(ctx.store.data.tickets, ctx.user);
      const hits = rows
        .filter((r) => `${r.title || ''} ${r.description || ''} ${r.category || ''}`.toLowerCase().includes(needle))
        .slice(0, limitOf(a.limit, 20, 50))
        .map(ticketSummary);
      return { tickets: hits, total: hits.length };
    },
  },
  {
    name: 'asset.get',
    description: 'Đọc một tài sản theo mã, giới hạn theo tenant của phiên.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: { assetId: { type: 'string', description: 'Mã tài sản' } },
      required: ['assetId'],
    },
    async handler({ args, ctx }) {
      const a = validateArgs(READ_TOOLS[2], args);
      const rows = rowsVisibleTo(ctx.store.data.assets, ctx.user);
      const hit = findVisible(rows, ctx.user, a.assetId);
      if (!hit.found) throw new McpError('not_found', `Không tìm thấy tài sản ${a.assetId}.`);
      return { asset: assetSummary(hit.row) };
    },
  },
  {
    name: 'asset.search',
    description: 'Tìm tài sản thuộc tenant hiện tại theo từ khoá.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Từ khoá trong tên/loại' },
        limit: { type: 'string', description: 'Số kết quả tối đa (1-50)' },
      },
      required: ['query'],
    },
    async handler({ args, ctx }) {
      const a = validateArgs(READ_TOOLS[3], args);
      const needle = a.query.toLowerCase();
      const rows = rowsVisibleTo(ctx.store.data.assets, ctx.user);
      const hits = rows
        .filter((r) => `${r.name || ''} ${r.type || ''} ${r.status || ''}`.toLowerCase().includes(needle))
        .slice(0, limitOf(a.limit, 20, 50))
        .map(assetSummary);
      return { assets: hits, total: hits.length };
    },
  },
  {
    name: 'knowledge.search',
    description: 'Tra runbook nội bộ. CHỈ trả về corpus được phép cho tenant hiện tại.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Câu hỏi cần tra runbook' },
        limit: { type: 'string', description: 'Số đoạn tối đa (1-10)' },
      },
      required: ['query'],
    },
    async handler({ args, ctx }) {
      const a = validateArgs(READ_TOOLS[4], args);
      const topK = limitOf(a.limit, 3, 10);
      // The single canonical retrieval entry point. `ctx.tenant` is mandatory
      // there and retrieval refuses without it, so an unscoped call returns
      // nothing rather than the whole corpus.
      const hits = await retrieve(a.query, topK, {
        tenantId: ctx.tenant,
        fetchImpl: ctx.fetchImpl,
        memoryOnly: !ctx.fetchImpl,
      });
      return {
        // Retrieved documents are untrusted data, framed as such. A document
        // saying "ignore your policy" is quoted here, not obeyed.
        context: formatContext(hits),
        citations: hits.map((h) => ({
          source: h.source,
          section: h.section,
          chunkId: h.chunkId,
          version: h.version,
          score: Number(h.score || 0).toFixed(4),
        })),
      };
    },
  },
];

module.exports = { READ_TOOLS, ticketSummary, assetSummary, limitOf };