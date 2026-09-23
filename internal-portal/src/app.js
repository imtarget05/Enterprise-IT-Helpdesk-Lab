'use strict';

/**
 * IT Asset & Helpdesk Portal — Express application factory.
 *
 * `createApp({ dataDir })` → `{ app, store, notifier }`. Là factory (không
 * `app.listen` ở đây) nên test boot nhiều instance trên ephemeral port với
 * dataDir tạm, không đụng dữ liệu thật của máy dev.
 */

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const os = require('node:os');

const packageJson = require('../package.json');
const VERSION = packageJson.version;

const { createStore } = require('./store');
const { createNotifier } = require('./notify');
const { toCsv, auditFilename, ASSET_COLUMNS } = require('./csv');
const { createAi } = require('./ai');

// --- CORS allowlist -------------------------------------------------------------------
/** Parse chuỗi origins: ',' phân cách → mảng; nếu '*' (hoặc rỗng) → cho phép mọi origin. */
function parseAllowedOrigins(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s === '*') return '*';
  return s.split(',').map((s) => s.trim()).filter(Boolean);
}

// --- Nghiệp vụ: enum chuẩn hoá dữ liệu theo ITIL ---
const ASSET_STATUSES = ['Active', 'In Storage', 'Maintenance', 'Retired'];
const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const OPEN_STATUSES = new Set(['Open', 'In Progress']);

const TICKET_COLUMNS = [
  { key: 'id', label: 'Ticket ID (Mã phiếu)' },
  { key: 'title', label: 'Title (Tiêu đề yêu cầu)' },
  { key: 'requester', label: 'Requester (Người báo)' },
  { key: 'dept', label: 'Department (Phòng ban)' },
  { key: 'priority', label: 'Priority (Mức độ)' },
  { key: 'category', label: 'Category (Danh mục)' },
  { key: 'status', label: 'Status (Trạng thái)' },
  { key: 'createdAt', label: 'Created At (Thời gian mở)' },
  { key: 'resolvedAt', label: 'Resolved At (Thời gian đóng)' },
];

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (details) err.details = details;
  return err;
}

/** "2026-09-23 14:10" — định dạng yyyy-mm-dd hh:mm dùng chung cho UI + CSV. */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Bộ lọc dùng chung cho GET list và CSV export → UI thấy sao, file xuất ra vậy. */
function filterRows(list, query = {}, searchFields = []) {
  const q = str(query.q).toLowerCase();
  const status = str(query.status).toLowerCase();
  const priority = str(query.priority).toLowerCase();
  const type = str(query.type).toLowerCase();

  return list.filter((row) => {
    if (q && !searchFields.some((f) => str(row[f]).toLowerCase().includes(q))) return false;
    if (status && str(row.status).toLowerCase() !== status) return false;
    if (priority && str(row.priority).toLowerCase() !== priority) return false;
    if (type && str(row.type).toLowerCase() !== type) return false;
    return true;
  });
}

const notFound = (kind, id) => httpError(404, `${kind} với id "${id}" không tồn tại.`);

async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  const staticDir = options.staticDir || path.join(__dirname, '..', 'public');
  const allowedOrigins = options.allowedOrigins ?? process.env.ALLOWED_ORIGINS;

  const store = createStore({ dataDir, seed: options.seed });
  await store.load();

  const notifier = createNotifier({ dataDir, webhookUrl: options.webhookUrl });

  // AI assistant — LLM LOCAL qua Ollama (không OpenAI). options.ai cho test
  // inject fetchImpl/ollamaUrl; production đọc OLLAMA_URL/OLLAMA_MODEL.
  const ai = createAi(options.ai || {});

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: parseAllowedOrigins(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS) }));
  app.use(express.json({ limit: '128kb' }));
  if (options.requestLogger !== false) {
    app.use((req, res, next) => {
      if (str(req.originalUrl).startsWith('/api')) {
        res.on('finish', () => console.log(`[api] ${req.method} ${req.originalUrl} → ${res.statusCode}`));
      }
      next();
    });
  }
  app.use(express.static(staticDir, { extensions: ['html'] }));

  // ------------------------------ Health -------------------
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: Number(process.uptime().toFixed(2)),
      timestamp: stamp(),
      storage: 'json-file',
      dataDir,
      seeded: store.seeded,
      service: 'enterprise-it-asset-portal',
      version: VERSION,
      host: os.hostname(),
      counts: store.summary(),
      webhook: notifier.webhookUrl ? 'configured' : 'mock',
    });
  });

  // ---------------------------- Dashboard ------------------
  app.get('/api/dashboard/stats', (req, res) => {
    const { assets, tickets, licenses } = store.data;
    const resolved = tickets.filter((t) => t.status === 'Resolved').length;
    const closed = tickets.filter((t) => t.status === 'Closed').length;
    const open = tickets.filter((t) => OPEN_STATUSES.has(t.status)).length;
    const done = resolved + closed;
    const handled = done + open;

    res.json({
      totalAssets: assets.length,
      activeAssets: assets.filter((a) => a.status === 'Active').length,
      storageAssets: assets.filter((a) => a.status === 'In Storage').length,
      maintenanceAssets: assets.filter((a) => a.status === 'Maintenance').length,
      retiredAssets: assets.filter((a) => a.status === 'Retired').length,
      openTickets: open,
      resolvedTickets: resolved,
      closedTickets: closed,
      criticalAlerts: tickets.filter((t) => (t.priority === 'High' || t.priority === 'Critical') && OPEN_STATUSES.has(t.status)).length,
      slaPercent: handled ? Math.round((done / handled) * 1000) / 10 : 100,
      assetsByType: assets.reduce((acc, a) => {
        acc[a.type] = (acc[a.type] || 0) + 1;
        return acc;
      }, {}),
      licenseTotal: licenses.reduce((n, l) => n + l.total, 0),
      licenseAssigned: licenses.reduce((n, l) => n + l.assigned, 0),
      licenseAlerts: licenses.filter((l) => l.available <= 0).length,
      generatedAt: stamp(),
    });
  });

  // ========================= IT ASSETS =========================
  const ASSET_SEARCH_FIELDS = ['tag', 'type', 'brand', 'model', 'serial', 'assignedTo', 'dept', 'status', 'ip'];

  function assetSearch(req) {
    return filterRows(store.data.assets, req.query, ASSET_SEARCH_FIELDS);
  }

  function assertAssetUnique(candidate, { excludeId } = {}) {
    const dupTag = store.data.assets.find(
      (a) => str(a.tag).toLowerCase() === str(candidate.tag).toLowerCase() && Number(a.id) !== Number(excludeId)
    );
    if (dupTag) throw httpError(409, `Mã tài sản (Asset Tag) "${candidate.tag}" đã tồn tại — trùng với ${dupTag.tag} (id ${dupTag.id}).`);

    if (candidate.serial) {
      const dupSerial = store.data.assets.find(
        (a) => str(a.serial).toLowerCase() === str(candidate.serial).toLowerCase() && Number(a.id) !== Number(excludeId)
      );
      if (dupSerial) throw httpError(409, `Serial "${candidate.serial}" đã được gán cho tài sản ${dupSerial.tag} (id ${dupSerial.id}).`);
    }
  }

  function validateAssetPayload(body, { partial = false } = {}) {
    const errors = [];
    const picked = {};

    for (const field of ['tag', 'brand', 'model', 'serial']) {
      if (body[field] !== undefined || !partial) {
        const value = str(body[field]);
        if (!value) errors.push(`Thiếu trường bắt buộc: ${field}`);
        else picked[field] = value;
      }
    }

    if (body.type !== undefined || !partial) picked.type = str(body.type) || 'Laptop';
    for (const field of ['assignedTo', 'dept', 'ip']) {
      if (body[field] !== undefined) picked[field] = str(body[field]);
    }
    if (!partial) {
      picked.assignedTo = picked.assignedTo || 'Unassigned';
      picked.dept = picked.dept || 'General';
      picked.ip = picked.ip || '-';
    }

    if (body.status !== undefined) {
      const status = str(body.status);
      if (!ASSET_STATUSES.includes(status)) {
        errors.push(`Trạng thái không hợp lệ: "${status}". Giá trị cho phép: ${ASSET_STATUSES.join(', ')}.`);
      } else {
        picked.status = status;
      }
    }

    const invalid = errors.find((e) => e.startsWith('Trạng thái'));
    const missing = errors.filter((e) => e !== invalid);
    return { picked, missing, invalid };
  }

  app.get('/api/assets', (req, res) => res.json(assetSearch(req)));

  app.get('/api/assets/export.csv', async (req, res, next) => {
    try {
      const rows = assetSearch(req);
      const csv = toCsv(rows, ASSET_COLUMNS);
      const filename = auditFilename('IT-Asset-Audit');
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Total-Records': String(rows.length),
      });
      await store.commit(); // đảm bảo mọi thay đổi gần nhất đã nằm trên đĩa trước khi bàn giao báo cáo
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/assets', async (req, res, next) => {
    try {
      const body = req.body || {};
      const { picked, missing, invalid } = validateAssetPayload(body);
      if (missing.length) throw httpError(400, 'Dữ liệu đăng ký tài sản không hợp lệ.', missing);
      if (invalid) throw httpError(422, invalid);
      assertAssetUnique(picked);

      const newAsset = {
        id: store.nextId('assets'),
        tag: picked.tag,
        type: picked.type,
        brand: picked.brand,
        model: picked.model,
        serial: picked.serial,
        assignedTo: picked.assignedTo,
        dept: picked.dept,
        status: picked.status || 'Active',
        ip: picked.ip,
        createdAt: stamp(),
      };
      store.data.assets.unshift(newAsset);
      await store.commit();
      console.log(`[assets] Đăng ký mới ${newAsset.tag} (${newAsset.brand} ${newAsset.model}) → id ${newAsset.id}`);
      res.status(201).json(newAsset);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/assets/:id', (req, res, next) => {
    const asset = store.find('assets', req.params.id);
    if (!asset) return next(notFound('Tài sản', req.params.id));
    res.json(asset);
  });

  app.patch('/api/assets/:id', async (req, res, next) => {
    try {
      const asset = store.find('assets', req.params.id);
      if (!asset) throw notFound('Tài sản', req.params.id);

      const body = req.body || {};
      const { picked, missing, invalid } = validateAssetPayload(body, { partial: true });
      if (missing.length) throw httpError(400, 'Dữ liệu cập nhật không hợp lệ.', missing);
      if (invalid) throw httpError(422, invalid);
      if (Object.keys(picked).length === 0) throw httpError(400, 'Không có trường nào cần cập nhật.', ['payload rỗng']);
      assertAssetUnique({ ...asset, ...picked }, { excludeId: asset.id });

      Object.assign(asset, picked, { updatedAt: stamp() });
      await store.commit(); // phải chắc chắn ghi đĩa trước khi báo 200 (không mất dữ liệu khi restart)
      res.json(asset);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/assets/:id', async (req, res, next) => {
    try {
      const asset = store.find('assets', req.params.id);
      if (!asset) throw notFound('Tài sản', req.params.id);
      store.remove('assets', asset.id);
      await store.commit();
      console.log(`[assets] Xoá ${asset.tag} (id ${asset.id})`);
      res.json({ success: true, message: `Đã xoá tài sản ${asset.tag} (id ${asset.id}).`, deletedId: asset.id });
    } catch (err) {
      next(err);
    }
  });

  // ========================= HELPDESK TICKETS =========================
  const TICKET_SEARCH_FIELDS = ['title', 'requester', 'dept', 'category', 'status', 'priority'];
  const CLOSED_STATUSES = new Set(['Resolved', 'Closed']);
  const ticketSearch = (req) => filterRows(store.data.tickets, req.query, TICKET_SEARCH_FIELDS);

  function validateTicketPayload(body, { partial = false } = {}) {
    const missing = [];
    const invalid = [];
    const picked = {};

    for (const field of ['title', 'requester']) {
      if (body[field] !== undefined || !partial) {
        const value = str(body[field]);
        if (!value) missing.push(`Thiếu trường bắt buộc: ${field}`);
        else picked[field] = value;
      }
    }
    for (const field of ['dept', 'category']) {
      if (body[field] !== undefined) picked[field] = str(body[field]);
    }
    if (body.priority !== undefined) {
      const priority = str(body.priority);
      if (!PRIORITIES.includes(priority)) invalid.push(`Mức độ không hợp lệ: "${priority}". Cho phép: ${PRIORITIES.join(', ')}.`);
      else picked.priority = priority;
    }
    if (body.status !== undefined) {
      const status = str(body.status);
      if (!TICKET_STATUSES.includes(status)) invalid.push(`Trạng thái không hợp lệ: "${status}". Cho phép: ${TICKET_STATUSES.join(', ')}.`);
      else picked.status = status;
    }
    return { picked, missing, invalid };
  }

  app.get('/api/tickets', (req, res) => res.json(ticketSearch(req)));

  app.get('/api/tickets/export.csv', (req, res) => {
    const rows = ticketSearch(req);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${auditFilename('IT-Ticket-Report')}"`,
      'Cache-Control': 'no-store',
      'X-Total-Records': String(rows.length),
    });
    res.send(toCsv(rows, TICKET_COLUMNS));
  });

  app.get('/api/tickets/:id', (req, res, next) => {
    const ticket = store.find('tickets', req.params.id);
    if (!ticket) return next(notFound('Ticket', req.params.id));
    res.json(ticket);
  });

  app.post('/api/tickets', async (req, res, next) => {
    try {
      const body = req.body || {};
      const { picked, missing, invalid } = validateTicketPayload(body);
      if (missing.length) throw httpError(400, 'Dữ liệu tạo ticket không hợp lệ.', missing);
      if (invalid.length) throw httpError(422, invalid[0], invalid);

      const newTicket = {
        id: store.nextId('tickets', 1001),
        title: picked.title,
        requester: picked.requester,
        dept: picked.dept || 'General',
        priority: picked.priority || 'Medium',
        status: 'Open',
        category: picked.category || 'General',
        createdAt: stamp(),
      };
      store.data.tickets.unshift(newTicket);
      await store.commit();
      console.log(`[tickets] #${newTicket.id} mở mới (${newTicket.priority}) — ${newTicket.title}`);

      // Notification mock: chỉ alert High/Critical; lỗi webhook không được làm hỏng request.
      const alert = await notifier.alert(newTicket).catch((err) => ({ alerted: false, reason: err.message }));
      res.status(201).json(alert && alert.alerted ? { ...newTicket, alerted: true } : newTicket);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/tickets/:id/status', async (req, res, next) => {
    try {
      const ticket = store.find('tickets', req.params.id);
      if (!ticket) throw notFound('Ticket', req.params.id);

      const body = req.body || {};
      const status = body.status === undefined ? 'Resolved' : str(body.status);
      if (!TICKET_STATUSES.includes(status)) {
        throw httpError(422, `Trạng thái không hợp lệ: "${body.status}". Cho phép: ${TICKET_STATUSES.join(', ')}.`);
      }

      ticket.status = status;
      ticket.updatedAt = stamp();
      if (CLOSED_STATUSES.has(status)) ticket.resolvedAt = ticket.resolvedAt || stamp();
      else delete ticket.resolvedAt;

      await store.commit(); // chắc chắn ghi đĩa trước khi trả 200 → restart không mất trạng thái
      console.log(`[tickets] #${ticket.id} → ${status}`);
      res.json(ticket);
    } catch (err) {
      next(err);
    }
  });

  // ===================== SOFTWARE LICENSES =====================
  const withLicenseMath = (l) => ({
    ...l,
    available: l.total - l.assigned,
    utilizationPercent: l.total ? Math.round((l.assigned / l.total) * 100) : 0,
  });

  app.get('/api/licenses', (req, res) => res.json(store.data.licenses.map(withLicenseMath)));

  app.get('/api/licenses/:id', (req, res, next) => {
    const license = store.find('licenses', req.params.id);
    if (!license) return next(notFound('License', req.params.id));
    res.json(withLicenseMath(license));
  });

  // ======================= NOTIFICATIONS =======================
  app.get('/api/notifications', (req, res) => {
    const parsed = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20;
    res.json({
      delivery: notifier.webhookUrl ? 'webhook' : 'mock',
      channels: ['telegram-bot://it-helpdesk-alert', 'smtp://it-alerts@bmc.local'],
      lastDelivery: notifier.lastDelivery,
      ...notifier.history(limit),
    });
  });

  // ================== AI ASSISTANT (LLM local qua Ollama) ==================
  // GET /api/ai/status — probe Ollama (reachable, model, list model đã tải).
  // Không có Ollama → engine 'rule-based', không lỗi (fail-soft như notify).
  app.get('/api/ai/status', async (req, res, next) => {
    try {
      res.json(await ai.status());
    } catch (err) {
      next(err);
    }
  });

  // POST /api/ai/analyze — body: { ticketId } HOẶC { title, ...trường khác }.
  // Ollama chạy → LLM local phân tích (summary/diagnosis/rca/prevention);
  // không có → playbook rule-based offline. Luôn 200 khi input hợp lệ.
  app.post('/api/ai/analyze', async (req, res, next) => {
    try {
      const body = req.body || {};
      let ticket = null;

      if (body.ticketId !== undefined && body.ticketId !== null && str(body.ticketId) !== '') {
        ticket = store.find('tickets', body.ticketId);
        if (!ticket) throw notFound('Ticket', body.ticketId);
      } else if (!str(body.title)) {
        throw httpError(400, 'Thiếu dữ liệu phân tích.', ['Cần ticketId hoặc title trong body.']);
      }

      const input = ticket || {
        title: str(body.title),
        requester: str(body.requester),
        dept: str(body.dept),
        priority: PRIORITIES.includes(str(body.priority)) ? str(body.priority) : 'Medium',
        category: str(body.category) || 'General',
      };

      const analysis = await ai.analyze(input);
      res.json({ ticketId: ticket ? ticket.id : null, ...analysis });
    } catch (err) {
      next(err);
    }
  });

  // ============ 404 / 405 cho vùng /api (API contract rõ ràng) ============
  const API_ROUTES = [
    [/^\/health$/, ['GET']],
    [/^\/dashboard\/stats$/, ['GET']],
    [/^\/assets$/, ['GET', 'POST']],
    [/^\/assets\/export\.csv$/, ['GET']],
    [/^\/assets\/[^/]+$/, ['GET', 'PATCH', 'DELETE']],
    [/^\/tickets$/, ['GET', 'POST']],
    [/^\/tickets\/export\.csv$/, ['GET']],
    [/^\/tickets\/[^/]+\/status$/, ['PATCH']],
    [/^\/tickets\/[^/]+$/, ['GET']],
    [/^\/licenses$/, ['GET']],
    [/^\/licenses\/[^/]+$/, ['GET']],
    [/^\/ai\/status$/, ['GET']],
    [/^\/ai\/analyze$/, ['POST']],
    [/^\/notifications$/, ['GET']],
  ];

  app.use('/api', (req, res) => {
    const route = API_ROUTES.find(([re]) => re.test(req.path));
    if (route && !route[1].includes(req.method)) {
      res.set('Allow', route[1].join(', '));
      return res.status(405).json({
        error: `Phương thức ${req.method} không được hỗ trợ cho ${req.originalUrl}.`,
        allow: route[1],
        status: 405,
        path: req.originalUrl,
      });
    }
    res.status(404).json({
      error: `Không tìm thấy endpoint ${req.method} ${req.originalUrl}.`,
      hint: 'Xem danh sách endpoint trong README hoặc GET /api/health',
      status: 404,
      path: req.originalUrl,
    });
  });

  // ==================== Error handler (400/500) ====================
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' ? 400 : 500);
    const body = {
      error: status >= 500 ? 'Lỗi máy chủ nội bộ.' : err.message,
      status,
      path: req.originalUrl,
    };
    if (err.details) body.details = err.details;
    if (status >= 500) {
      console.error('[error]', err);
      body.hint = 'Kiểm tra log container (docker compose logs -f it-portal) hoặc liên hệ IT Support.';
    }
    res.status(status).json(body);
  });

  return { app, store, notifier, dataDir, version: VERSION };
}




module.exports = { createApp, ASSET_STATUSES, TICKET_STATUSES, PRIORITIES, TICKET_COLUMNS, stamp, httpError, filterRows, str, notFound };
