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
const { createAgent } = require('./agent');
const { createAuth, PERMISSIONS, normalizeTenant } = require('./auth');
const { rowsVisibleTo, findVisible } = require('./tenant-scope');
const { registerEnterpriseRoutes } = require('./enterprise-routes');
const { createActionLifecycle } = require('./action-lifecycle');
const { registerAutomationRoutes } = require('./automation-routes');
const { createLifecycleStore, createAutomationExecutor } = require('./automation-runtime');
const { createDurableQueue } = require('./automation-queue');
const { createAutomationWorker } = require('./automation-worker');

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
const upper = (v) => str(v).toUpperCase();

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
  const repoRoot = path.resolve(__dirname, '..', '..');
  const docsDir = path.join(repoRoot, 'docs');
  const scenariosDir = path.join(repoRoot, 'scenarios');
  const allowedOrigins = options.allowedOrigins ?? process.env.ALLOWED_ORIGINS;

  const store = createStore({ dataDir, seed: options.seed });
  await store.load();

  // `options.notifier` lets tests inject an offline fake (never contacts a webhook).
  const notifier = options.notifier || createNotifier({ dataDir, webhookUrl: options.webhookUrl });
  const auth = createAuth({ authMode: options.authMode, authUsers: options.authUsers });

  // AI assistant — OpenAI (tuỳ chọn) → Ollama local → playbook offline. options.ai cho test
  // inject fetchImpl/ollamaUrl; production đọc OPENAI_API_KEY/OLLAMA_URL/OLLAMA_MODEL.
  const ai = createAi(options.ai || {});

  // Agentic runtime — thêm lớp trên cùng: agent chọn tool, gọi tool, rồi trả
  // lời. options.agent cho test inject llm/fetchImpl/maxSteps. Dùng chung
  // fetchImpl với createAi để test chỉ cần giả một nguồn.
  const agent = await createAgent({
    store,
    dataDir,
    ...(options.agent || {}),
    fetchImpl: (options.agent && options.agent.fetchImpl) || (options.ai && options.ai.fetchImpl) || null,
  });

  const app = express();
  app.disable('x-powered-by');
  // --- Minimal Prometheus helper (additive; zero new dependencies) ---
  // In-memory per-route×status request counters for GET /metrics below.
  // Unauthenticated (standard for Prometheus scraping); no existing route,
  // auth, or response shape is changed.
  const httpRequestsTotal = new Map();
  app.use((req, res, next) => {
    res.on('finish', () => {
      const route = (str(req.path || req.originalUrl).split('?')[0] || '/').replace(/"/g, '');
      const key = `${req.method} ${route} ${res.statusCode}`;
      // NOTE: no `httpRequestsTotal.get(key)` here on purpose. A bare
      // `recv.get(identifier)` is indistinguishable from `app.get(path)` to the
      // fail-closed route scanner (test/route-inventory.js), which would report
      // it as an unresolved registration and fail the inventory gates. The
      // linear scan below follows the same precedent as `bucketAt` in
      // src/enterprise-routes.js; the map holds one entry per route×status.
      let prev = 0;
      for (const entry of httpRequestsTotal) {
        if (entry[0] === key) { prev = entry[1]; break; }
      }
      httpRequestsTotal.set(key, prev + 1);
    });
    next();
  });
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
  // Read-only documentation mounts keep local runbook links usable in Docker and tests.
  app.use('/docs', express.static(docsDir, { fallthrough: false, index: false }));
  app.use('/scenarios', express.static(scenariosDir, { fallthrough: false, index: false }));
  app.use('/api', auth.middleware);
  app.use('/api', (req, res, next) => {
    if (auth.mode === 'legacy') return next();
    if (req.path === '/health' || req.path === '/auth/login' || req.path === '/integrations/minierp/incidents' || req.method === 'OPTIONS') return next();
    if (!req.user) return res.status(401).json({ error: 'Authentication required.', status: 401, path: req.originalUrl });
    if (['GET', 'HEAD'].includes(req.method)) return next();
    let permission = null;
    if (/^\/assets(?:\/|$)/.test(req.path) && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) permission = PERMISSIONS.ASSET_WRITE;
    if (/^\/tickets(?:\/|$)/.test(req.path) && ['POST', 'PATCH', 'PUT'].includes(req.method)) permission = PERMISSIONS.TICKET_WRITE;
    if (req.path === '/ai/analyze') permission = PERMISSIONS.TICKET_WRITE;
    // Agent chỉ đọc được thì vẫn hỏi được về tri thức; nhưng approve (ghi dữ
    // liệu thật) và run (có thể đề xuất ghi) đều cần TICKET_WRITE.
    if (req.path === '/ai/agent' || req.path === '/ai/agent/approve') permission = PERMISSIONS.TICKET_WRITE;
    if (permission && !auth.hasPermission(req.user, permission)) return res.status(403).json({ error: 'Insufficient portal role.', requiredPermission: permission, status: 403, path: req.originalUrl });
    return next();
  });
  registerEnterpriseRoutes({ app, store, auth, notifier, options });

  // ------------------------- Governed automation lifecycle -------------------------
  //
  // The governed pipeline (proposal -> policy -> approval -> queue -> worker ->
  // executor -> post-check) is reachable over HTTP for the first time here. The
  // routes THIN: they validate shape, derive identity from the session, and hand
  // the decision to `action-lifecycle.js`, which already owns risk, approval,
  // idempotency and the TOCTOU gate. No handler executes anything.
  //
  // Store selection is explicit, never implicit:
  //   * LIFECYCLE_PG_URL set  -> PostgreSQL (durable across replicas/restarts)
  //   * otherwise             -> the file-backed memory store, which persists to
  //                              `<dataDir>/action-lifecycle.json`
  // Both are durable. The process-local map is only the `{}` in-memory variant,
  // which this wiring deliberately does not use for a running server.
  const lifecycleStore = options.lifecycleStore || await createLifecycleStore({ dataDir, options });
  const automationLifecycle = createActionLifecycle({
    store: lifecycleStore,
    executor: createAutomationExecutor({ options }),
  });

  // The queue is durable by default: `<dataDir>/automation-queue`. Previously a
  // request without an injected queue left every approved job in APPROVED with
  // nothing pending, which made "approval does not execute" true but also
  // "approval does not lead anywhere" — the pipeline dead-ended at the boundary.
  // A file-backed queue makes the enqueue real and, crucially, survives the crash
  // windows the worker tests exercise.
  const automationQueue = options.queue || createDurableQueue({
    dir: options.queueDir || path.join(dataDir, 'automation-queue'),
    maxAttempts: options.queueMaxAttempts,
  });
  const automationWorker = createAutomationWorker({
    lifecycle: automationLifecycle,
    queue: automationQueue,
    workerId: options.workerId || 'worker-1',
    metrics: options.metrics,
  });

  registerAutomationRoutes({
    app,
    auth,
    lifecycle: automationLifecycle,
    store: lifecycleStore,
    queue: automationQueue,
  });

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
      // UI cần biết chế độ auth để quyết định hiển thị login panel hay không.
      authMode: auth.mode,
      counts: store.summary(),
      webhook: notifier.webhookUrl ? 'configured' : 'mock',
    });
  });

  // ---------------------------- Prometheus ---------------
  app.get('/metrics', (req, res) => {
    // Prometheus text exposition — aggregate counts only, no PII/ticket bodies.
    const { assets, tickets, licenses } = store.data;
    const openTickets = tickets.filter((t) => t.status === 'Open').length;
    const resolvedTickets = tickets.filter((t) => t.status === 'Resolved').length;
    const criticalTickets = tickets.filter((t) => t.priority === 'Critical').length;
    const activeAssets = assets.filter((a) => a.status === 'Active').length;
    const lines = [
      '# HELP helpdesk_tickets_total Total tickets in store.',
      '# TYPE helpdesk_tickets_total counter',
      `helpdesk_tickets_total ${tickets.length}`,
      '# HELP helpdesk_tickets_open Currently open tickets.',
      '# TYPE helpdesk_tickets_open gauge',
      `helpdesk_tickets_open ${openTickets}`,
      '# HELP helpdesk_tickets_resolved Resolved tickets.',
      '# TYPE helpdesk_tickets_resolved counter',
      `helpdesk_tickets_resolved ${resolvedTickets}`,
      '# HELP helpdesk_tickets_critical Critical-priority tickets.',
      '# TYPE helpdesk_tickets_critical gauge',
      `helpdesk_tickets_critical ${criticalTickets}`,
      '# HELP helpdesk_assets_total Total IT assets tracked.',
      '# TYPE helpdesk_assets_total gauge',
      `helpdesk_assets_total ${assets.length}`,
      '# HELP helpdesk_assets_active Active assets.',
      '# TYPE helpdesk_assets_active gauge',
      `helpdesk_assets_active ${activeAssets}`,
      '# HELP helpdesk_licenses_total Software licenses tracked.',
      '# TYPE helpdesk_licenses_total gauge',
      `helpdesk_licenses_total ${licenses.length}`,
      '# HELP helpdesk_uptime_seconds Process uptime.',
      '# TYPE helpdesk_uptime_seconds gauge',
      `helpdesk_uptime_seconds ${Number(process.uptime().toFixed(2))}`,
      '# HELP http_requests_total Total HTTP requests by route and status.',
      '# TYPE http_requests_total counter',
      ...[...httpRequestsTotal.entries()].sort().map(([key, n]) => {
        const [method, route, status] = key.split(' ');
        return `http_requests_total{method="${method}",route="${route}",status="${status}"} ${n}`;
      }),
      '# HELP process_uptime_seconds Process uptime in seconds.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${Number(process.uptime().toFixed(2))}`,
      '# HELP ticket_count Tickets currently in store.',
      '# TYPE ticket_count gauge',
      `ticket_count ${tickets.length}`,
    ];
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
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
      slaBreached: tickets.filter((t) => t.slaBreached).length,
      monitoring: {
        up: store.data.monitoringChecks.filter((c) => c.status === 'UP').length,
        down: store.data.monitoringChecks.filter((c) => c.status === 'DOWN').length,
        degraded: store.data.monitoringChecks.filter((c) => c.status === 'DEGRADED').length,
      },
      openProblems: store.data.problems.filter((p) => !['CLOSED', 'RESOLVED'].includes(upper(p.status))).length,
      openChanges: store.data.changes.filter((c) => c.implementationState !== 'CLOSED').length,
      pendingAccessRequests: store.data.accessRequests.filter((r) => r.executionState !== 'COMPLETED').length,
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
    // Tenant-scoped: an export must not become the side door around the
    // tenant filter that GET /api/assets applies.
    return filterRows(rowsVisibleTo(store.data.assets, req.user), req.query, ASSET_SEARCH_FIELDS);
  }

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

  // Tenant-scoped with the 404 disclosure policy: an asset owned by another
  // tenant must be indistinguishable from one that does not exist.
  app.get('/api/assets/:id', (req, res, next) => {
    const hit = findVisible(store.data.assets, req.user, req.params.id);
    if (!hit.found) return next(notFound('Tài sản', req.params.id));
    res.json(hit.row);
  });

  app.delete('/api/assets/:id', async (req, res, next) => {
    try {
      const hit = findVisible(store.data.assets, req.user, req.params.id);
      if (!hit.found) throw notFound('Tài sản', req.params.id);
      const asset = hit.row;
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
  const ticketSearch = (req) => filterRows(rowsVisibleTo(store.data.tickets, req.user), req.query, TICKET_SEARCH_FIELDS);

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

  // ================== AI ASSISTANT (OPENAI → OLLAMA → OFFLINE) ==================
  // GET /api/ai/status — báo cáo provider hiện tại, model và trạng thái reachability.
  // POST /api/ai/analyze — OpenAI tuỳ chọn, fallback Ollama rồi playbook rule-based.
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

  // POST /api/ai/log-analysis — FPT AI Camera evidence: LLM/SRE root-cause từ log thật.
  // Body: { logs: string[], service?: string, metrics?: object }. Luôn 200 khi input hợp lệ.
  app.post('/api/ai/log-analysis', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.logs) || body.logs.length === 0) {
        throw httpError(400, 'Thiếu logs.', ['Body cần { logs: string[] } ít nhất 1 dòng.']);
      }
      const out = await ai.analyzeLogs({ logs: body.logs, service: body.service, metrics: body.metrics || null });
      try {
        // store KHÔNG có method add() (chỉ data/commit/flush/nextId) — bản cũ
        // gọi store.add() và bị catch(_) nuốt lặng lẽ nên audit không bao giờ
        // được ghi. Ghi thẳng vào collection theo đúng schema auditEvents.
        const rows = store.data.auditEvents || (store.data.auditEvents = []);
        rows.unshift({
          id: store.nextId('auditEvents'),
          at: new Date().toISOString(),
          actor: 'ai-log-analysis',
          role: 'SYSTEM',
          action: 'log-analysis',
          entityType: 'service',
          entityId: null,
          details: { service: out.service, severity: out.severity, errors: out.errorCount },
        });
        if (rows.length > 5000) rows.length = 5000;
        store.commit();
      } catch (_) { /* audit best-effort */ }
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  // ============ Agentic runtime (tools + memory + guardrails) ============
  // GET  /api/ai/agent/status — engine, tool registry, số phiên/ký ức.
  app.get('/api/ai/agent/status', (req, res) => {
    try {
      res.json(agent.describe());
    } catch (err) {
      next(err);
    }
  });

  // POST /api/ai/agent — body: { question, sessionId? }.
  // Chạy vòng lặp PLAN→ACT→OBSERVE. Tool ghi KHÔNG tự chạy: kết quả trả về
  // status 'needs_approval' + proposedAction.token để người dùng duyệt riêng.
  app.post('/api/ai/agent', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => {
    try {
      const body = req.body || {};
      const question = str(body.question || body.q);
      if (!question) {
        throw httpError(400, 'Thiếu câu hỏi.', ['Cần trường "question" trong body.']);
      }
      const result = await agent.run({
        question,
        sessionId: str(body.sessionId) || `api-${req.user.username}`,
        user: str(req.user.username),
        // Tenant comes from the SESSION, never from body.tenant: an AI route
        // that accepts a client-named tenant would let any caller drive the
        // agent inside another tenant's context.
        tenant: normalizeTenant(req.user.tenant),
        requester: str(req.user.username),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/ai/agent/approve — body: { token, approved? }.
  // Điểm duy nhất nơi tool side-effect thực sự ghi dữ liệu. approved=false →
  // từ chối, huỷ token (không thể duyệt lại).
  app.post('/api/ai/agent/approve', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => {
    try {
      const body = req.body || {};
      const token = str(body.token);
      if (!token) {
        throw httpError(400, 'Thiếu token phê duyệt.', ['Cần trường "token" trong body.']);
      }
      if (body.approved === false) {
        const rejected = agent.reject(token);
        if (!rejected) throw httpError(404, 'Token không hợp lệ, đã hết hạn hoặc đã dùng.');
        return res.json({ approved: false, rejected: true });
      }
      const outcome = await agent.approve({
        token,
        user: str(req.user.username),
        // Session tenant, same reasoning as POST /api/ai/agent: an approval
        // decision must not be attributable to a tenant the caller named.
        tenant: normalizeTenant(req.user.tenant),
        requester: str(req.user.username),
      });
      if (!outcome.ok) {
        return res.status(outcome.status || 400).json({ error: outcome.error, code: outcome.code, status: outcome.status || 400 });
      }
      return res.json(outcome);
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
    [/^\/auth\/login$/, ['POST']],
    [/^\/auth\/logout$/, ['POST']],
    [/^\/auth\/me$/, ['GET']],
    [/^\/tickets\/[^/]+\/timeline$/, ['GET']],
    [/^\/tickets\/[^/]+\/assign$/, ['POST']],
    [/^\/tickets\/[^/]+\/work-notes$/, ['POST']],
    [/^\/tickets\/[^/]+\/transition$/, ['POST']],
    [/^\/assets\/[^/]+\/(assign|recover)$/, ['POST']],
    [/^\/problems$/, ['GET', 'POST']],
    [/^\/problems\/[^/]+$/, ['GET', 'PATCH']],
    [/^\/problems\/[^/]+\/link-ticket$/, ['POST']],
    [/^\/changes$/, ['GET', 'POST']],
    [/^\/changes\/[^/]+$/, ['GET', 'PATCH']],
    [/^\/changes\/[^/]+\/(approve|implement|close)$/, ['POST']],
    [/^\/access-requests$/, ['GET', 'POST']],
    [/^\/access-requests\/[^/]+$/, ['GET']],
    [/^\/access-requests\/[^/]+\/handoff$/, ['GET']],
    [/^\/access-requests\/[^/]+\/(approve|complete|offboard)$/, ['POST']],
    [/^\/monitoring\/checks$/, ['GET', 'POST']],
    [/^\/monitoring\/status$/, ['GET']],
    [/^\/monitoring\/history$/, ['GET']],
    [/^\/monitoring\/checks\/[^/]+$/, ['GET', 'PATCH']],
    [/^\/monitoring\/checks\/[^/]+\/run$/, ['POST']],
    [/^\/integrations\/minierp\/incidents$/, ['POST']],
    [/^\/audit$/, ['GET']],
    [/^\/ai\/status$/, ['GET']],
    [/^\/ai\/analyze$/, ['POST']],
    [/^\/ai\/agent$/, ['POST']],
    [/^\/ai\/agent\/status$/, ['GET']],
    [/^\/ai\/agent\/approve$/, ['POST']],
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

  // `automationLifecycle` is exposed so tests (and an embedding worker) can drive
  // the worker side of the boundary. It is the SAME object the routes use — a
  // test cannot accidentally exercise a different, laxer lifecycle.
  // `lifecycleStoreRef` exposes the durable store so a test can plant or tamper
  // with a row the way a writer with database access could.
  return {
    app, store, notifier, agent,
    automationLifecycle, lifecycleStoreRef: lifecycleStore,
    automationQueue, automationWorker,
    dataDir, version: VERSION,
  };
}




module.exports = { createApp, ASSET_STATUSES, TICKET_STATUSES, PRIORITIES, TICKET_COLUMNS, stamp, httpError, filterRows, str, notFound };
