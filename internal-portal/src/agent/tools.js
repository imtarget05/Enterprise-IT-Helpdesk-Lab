'use strict';

/**
 * Agent tool registry — các thao tác agent được phép thực hiện trên dữ liệu
 * portal, kèm schema tham số để LLM chọn tool đúng.
 *
 * Nguyên tắc bất di bất dịch (giống MAIA `agent.py` C1):
 *   Tool `sideEffect: true` KHÔNG BAO GIỜ tự chạy trong vòng lặp agent.
 *   Orchestrator chỉ nhận về `proposedAction` + `status: needs_approval`;
 *   việc ghi thật chỉ xảy ra ở `POST /api/ai/agent/approve` sau khi con người
 *   bấm duyệt. Xem src/agent/guardrails.js và src/agent/orchestrator.js.
 *
 * Mỗi tool có: name (định danh gửi LLM), description (tiếng Việt),
 * parameters (JSON-Schema rút gọn), sideEffect (có ghi dữ liệu thật không),
 * handler (async ({ args, ctx }) => object thuần).
 *
 * Zero-dependency: chỉ dùng `itsm.js` (nghiệp vụ ITIL đã kiểm thử) + store.
 * `ctx` mang { store, fetchImpl, requester } — orchestrator bơm vào lúc chạy.
 */

const { retrieve, formatContext } = require('../rag');
const {
  calculateSla,
  canonicalState,
  legacyStatus,
  priorityCodeFromLabel,
  priorityLabel,
  derivePriorityCode,
  normalizeTicketRecord,
  sanitizeText,
  str,
} = require('../itsm');

const nowIso = () => new Date().toISOString();
const upper = (v) => str(v).toUpperCase();
const compact = (v, max = 200) => sanitizeText(v, max);

// Độ trễ SLA theo mức ưu tiên (khớp SLA_POLICIES trong itsm.js).
const SLA_MINUTES = { P1: 240, P2: 480, P3: 2880, P4: 7200 };

/** Rút gọn ticket đưa về cho LLM, tránh context phình to. */
function ticketDigest(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: str(row.title),
    requester: str(row.requester),
    dept: str(row.dept),
    priority: str(row.priority) || priorityLabel(row.priorityCode),
    status: str(row.status) || legacyStatus(row.state),
    state: str(row.state) || canonicalState(row.status),
    category: str(row.category),
    assignee: str(row.assignedTo || row.assignee) || null,
    openedAt: str(row.openedAt || row.createdAt),
    slaTargetAt: str(row.slaTargetAt),
  };
}

const assetDigest = (a) => ({
  id: a.id,
  assetTag: str(a.assetTag || a.tag),
  assetType: str(a.assetType || a.type),
  manufacturer: str(a.manufacturer || a.brand),
  model: str(a.model),
  serialNumber: str(a.serialNumber || a.serial),
  assignedTo: str(a.assignedTo),
  status: str(a.lifecycleStatus || a.status),
  ipAddress: str(a.ipAddress || a.ip),
  location: str(a.location),
});

/**
 * Tạo registry tool. `options.store` là store từ createStore() — chính là
 * instance server đang dùng, nên đọc/ghi luôn nhất quán với REST API.
 */
function createToolRegistry(options = {}) {
  const store = options.store;
  if (!store) throw new Error('createToolRegistry cần options.store');

  /** Tìm ticket theo id — dùng chung cho mọi tool thao tác lên ticket. */
  const requireTicket = (id) => {
    const row = store.find('tickets', id);
    if (!row) {
      const e = new Error(`Ticket ${str(id)} không tồn tại.`);
      e.status = 404;
      throw e;
    }
    return row;
  };

  const tools = [
    {
      name: 'search_tickets',
      sideEffect: false,
      description: 'Tìm kiếm ticket theo từ khoá trong title/mô tả, lọc theo trạng thái hoặc mức ưu tiên. Dùng khi người dùng hỏi "ticket nào đang mở", "có ticket nào về VPN không".',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Từ khoá tìm kiếm (optional)' },
          status: { type: 'string', description: 'Open | In Progress | Resolved | Closed (optional)' },
          priority: { type: 'string', description: 'Low | Medium | High | Critical (optional)' },
        },
        required: [],
      },
      async handler({ args }) {
        const q = str(args.q).toLowerCase();
        const status = str(args.status).toLowerCase();
        const priority = str(args.priority).toLowerCase();
        const rows = (store.data.tickets || []).filter((t) => {
          if (q && !JSON.stringify(t).toLowerCase().includes(q)) return false;
          if (status) {
            const a = str(t.status).toLowerCase();
            const b = str(t.state).toLowerCase();
            if (a !== status && b !== status && legacyStatus(t.state).toLowerCase() !== status) return false;
          }
          if (priority) {
            const a = str(t.priority).toLowerCase();
            const b = str(t.priorityCode).toLowerCase();
            if (a !== priority && b !== priority && priorityLabel(t.priorityCode).toLowerCase() !== priority) return false;
          }
          return true;
        });
        // Ưu tiên cao trước, ticket mới sau — đúng thứ L2 cần thấy nhất.
        rows.sort((a, b) => {
          const pa = SLA_MINUTES[priorityCodeFromLabel(a.priorityCode) || a.priorityCode] ?? 1e9;
          const pb = SLA_MINUTES[priorityCodeFromLabel(b.priorityCode) || b.priorityCode] ?? 1e9;
          if (pa !== pb) return pa - pb;
          return Number(b.id) - Number(a.id);
        });
        return { count: rows.length, tickets: rows.slice(0, 10).map(ticketDigest) };
      },
    },
    {
      name: 'get_ticket',
      sideEffect: false,
      description: 'Lấy chi tiết một ticket theo id, kèm trạng thái SLA còn lại. Dùng khi cần xem đầy đủ nội dung và tiến độ của một ticket cụ thể.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Mã ticket (số)' } },
        required: ['id'],
      },
      async handler({ args }) {
        const row = requireTicket(args.id);
        const sla = calculateSla(row.priorityCode, row.openedAt);
        const remainingMinutes = Math.round((new Date(sla.resolveTargetAt).getTime() - Date.now()) / 60000);
        return {
          ticket: ticketDigest(row),
          description: str(row.description) || null,
          relatedAssetId: row.relatedAssetId ?? null,
          sla: {
            priorityCode: sla.priorityCode,
            acknowledgeTargetAt: sla.acknowledgeTargetAt,
            resolveTargetAt: sla.resolveTargetAt,
            remainingMinutes,
            breached: remainingMinutes < 0 && !/RESOLVED|CLOSED/i.test(str(row.state)),
          },
        };
      },
    },
    {
      name: 'find_assets',
      sideEffect: false,
      description: 'Tra cứu tài sản theo người được cấp phát hoặc mã tài sản. Dùng khi cần biết máy, serial, IP của một nhân viên để chẩn đoán sự cố phần cứng hoặc mạng.',
      parameters: {
        type: 'object',
        properties: {
          assignedTo: { type: 'string', description: 'Tên người dùng được cấp tài sản (optional)' },
          assetTag: { type: 'string', description: 'Mã tài sản, ví dụ LT-0001 (optional)' },
        },
        required: [],
      },
      async handler({ args }) {
        const who = str(args.assignedTo).toLowerCase();
        const tag = str(args.assetTag).toLowerCase();
        const rows = (store.data.assets || []).filter((a) => {
          if (who && str(a.assignedTo).toLowerCase() !== who) return false;
          if (tag && str(a.assetTag).toLowerCase() !== tag && str(a.tag).toLowerCase() !== tag) return false;
          return true;
        });
        return { count: rows.length, assets: rows.slice(0, 10).map(assetDigest) };
      },
    },
    {
      name: 'search_knowledge',
      sideEffect: false,
      description: 'Tra runbook và quy trình nội bộ của công ty qua RAG. LUÔN gọi tool này TRƯỚC khi đưa ra khuyến nghị kỹ thuật, để trả lời đúng quy trình nội bộ thay vì kiến thức chung. Trả về các đoạn runbook liên quan kèm nguồn.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Câu hỏi hoặc từ khoá cần tra runbook' } },
        required: ['query'],
      },
      async handler({ args, ctx }) {
        // Chỉ đi qua RAG thật khi caller cấp `fetchImpl` (server/test đã cấu hình).
        // Không có `fetchImpl` thì ép `memoryOnly`: tránh lần đầu phải embed
        // toàn bộ corpus qua Ollama (10s/chunk, hàng chụs chunk → hàng phút),
        // vốn làm treo request agent trong demo offline.
        const fetchImpl = (ctx || {}).fetchImpl;
        const hits = await retrieve(str(args.query), 3, { memoryOnly: !fetchImpl, fetchImpl });
        return {
          context: formatContext(hits),
          sources: hits.map((h) => ({ source: h.source, section: h.section, score: Number(h.score || 0).toFixed(4) })),
        };
      },
    },
    {
      name: 'create_ticket',
      sideEffect: true,
      description: 'Tạo ticket mới trong portal. Đây là hành động GHI DỮ LIỆU THẬT — agent chỉ được ĐỀ XUẤT, không tự tạo. Người dùng phải duyệt trước khi ticket thực sự được tạo.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Tiêu đề ticket, mô tả ngắn gọn vấn đề' },
          description: { type: 'string', description: 'Mô tả chi tiết triệu chứng' },
          requester: { type: 'string', description: 'Người báo' },
          dept: { type: 'string', description: 'Phòng ban' },
          priority: { type: 'string', description: 'Low | Medium | High | Critical' },
          category: { type: 'string', description: 'NETWORK | ACCOUNT | HARDWARE | SOFTWARE | SECURITY | OTHER' },
        },
        required: ['title'],
      },
      async handler({ args, ctx }) {
        const code = priorityCodeFromLabel(args.priority) || derivePriorityCode(args.impact, args.urgency);
        const category = upper(args.category);
        const allowed = ['NETWORK', 'ACCOUNT', 'HARDWARE', 'SOFTWARE', 'ERP', 'MES', 'WMS', 'PRINTER', 'SCANNER', 'SECURITY', 'OTHER'];
        const row = normalizeTicketRecord({
          id: store.nextId('tickets'),
          title: compact(args.title, 200),
          description: compact(args.description, 2000),
          requester: compact(args.requester || (ctx || {}).requester || 'Unknown', 120),
          dept: compact(args.dept, 120),
          priority: priorityLabel(code),
          priorityCode: code,
          category: allowed.includes(category) ? category : 'OTHER',
          type: 'INCIDENT',
          state: 'NEW',
          source: 'IT',
          openedAt: nowIso(),
          createdAt: nowIso(),
          requestedByAgent: true,
        });
        store.append('tickets', row);
        await store.commit();
        return { created: true, ticket: ticketDigest(row), sla: { resolveTargetAt: row.slaTargetAt } };
      },
    },
    {
      name: 'add_work_note',
      sideEffect: true,
      description: 'Ghi work note vào timeline của một ticket để bàn giao kết quả chẩn đoán cho kỹ thuật viên. Hành động ghi dữ liệu thật — cần người dùng duyệt.',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string', description: 'Mã ticket cần ghi chú' },
          note: { type: 'string', description: 'Nội dung work note' },
        },
        required: ['ticketId', 'note'],
      },
      async handler({ args }) {
        const ticket = requireTicket(args.ticketId);
        const note = compact(args.note, 2000);
        if (!note) {
          const e = new Error('Work note rỗng.');
          e.status = 422;
          throw e;
        }
        const event = { id: store.nextId('ticketEvents'), ticketId: ticket.id, at: nowIso(), type: 'WORK_NOTE', actor: 'agent', details: { note } };
        store.append('ticketEvents', event);
        await store.commit();
        return { recorded: true, ticketId: ticket.id, eventId: event.id };
      },
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    tools,
    byName,
    readOnly: tools.filter((t) => !t.sideEffect),
    sideEffectNames: tools.filter((t) => t.sideEffect).map((t) => t.name),

    /** Tool cho phép tự chạy trong vòng lặp. Tool ghi LUÔN bị chặn ở đây. */
    isAutoAllowed(name) {
      const tool = byName.get(str(name));
      return Boolean(tool && !tool.sideEffect);
    },

    /** Chạy tool; lỗi nghiệp vụ trả `{ ok:false, error }` thay vì throw. */
    async invoke(name, args, ctx = {}) {
      const tool = byName.get(str(name));
      if (!tool) return { ok: false, error: `Tool không tồn tại: ${str(name)}`, code: 'unknown_tool' };
      if (tool.sideEffect && !ctx.approved) {
        return { ok: false, error: `Tool ${tool.name} cần phê duyệt của con người.`, code: 'needs_approval', sideEffect: true };
      }
      try {
        const result = await tool.handler({ args: args || {}, ctx });
        return { ok: true, result, sideEffect: tool.sideEffect };
      } catch (err) {
        return { ok: false, error: err.message || String(err), code: err.status === 404 ? 'not_found' : 'tool_error', status: err.status };
      }
    },
  };
}

module.exports = { createToolRegistry, ticketDigest };
