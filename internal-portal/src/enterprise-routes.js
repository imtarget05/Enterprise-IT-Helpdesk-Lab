'use strict';

const net = require('node:net');
const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { PERMISSIONS } = require('./auth');
const { rowsVisibleTo, findVisible, stampTenant } = require('./tenant-scope');
const { canonicalState, assertTransition, isResolutionState, normalizeTicketRecord, sanitizeText, stableHash, str } = require('./itsm');
const { buildOpsReport, renderMarkdown } = require('./ops-report');

const upper = (v) => str(v).toUpperCase();
const compact = (v, max = 200) => sanitizeText(v, max);
const nowIso = () => new Date().toISOString();
const legacyStamp = (date = new Date()) => { const pad = (n) => String(n).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const fail = (status, message, details) => { const e = new Error(message); e.status = status; e.expose = true; if (details) e.details = details; return e; };
const sameSecret = (expected, actual) => { const a = Buffer.from(String(expected || '')); const b = Buffer.from(String(actual || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };

function registerEnterpriseRoutes({ app, store, auth, notifier, options = {} }) {
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const integrationKey = options.miniErpIntegrationKey || process.env.MINIERP_INTEGRATION_KEY || '';
  const monitoring = options.monitoring || {};
  // ---- Owned-change transaction journal -------------------------------------
  // A whole-collection snapshot restored across an `await` is a STALE write.
  // `POST /api/monitoring/checks/:id/run` parks inside `probe()` for up to five
  // seconds, and `store.commit()` only serialises the disk write - it takes no
  // in-memory mutation lock. Another request can therefore commit rows into the
  // SAME collections while this transaction is suspended, and restoring the
  // pre-await clone would silently erase that committed row from memory; a later
  // commit would then overwrite db.json without it.
  //
  // The journal records only what THIS transaction actually did:
  //   * `add(collection, row)`  - the exact row object inserted here;
  //   * `edit(collection, row)` - a proxy that snapshots a field's previous
  //                               value the first time this transaction
  //                               overwrites or deletes it.
  // Rollback removes the inserted rows by reference identity and rewrites only
  // the recorded fields, so a concurrent commit is never deleted, replaced or
  // reordered, and rows that outlive the transaction keep their identity.
  // `AsyncLocalStorage` scopes a journal to one request, so a concurrent request
  // never records into a transaction it is not part of.
  const ABSENT = Symbol('field-absent');
  const cloneValue = (value) => (value !== null && typeof value === 'object' ? structuredClone(value) : value);
  const journalContext = new AsyncLocalStorage();
  const activeJournal = () => journalContext.getStore() || null;
  // A bare `recv.get(identifier)` is indistinguishable from `app.get(path)` to
  // the fail-closed route scanner, so map lookups go through this iterator
  // instead of teaching the scanner a new exemption. The cost is a linear scan
  // of a Map with one entry per collection and one entry per edited row; a
  // transaction edits a couple of rows at most, so this stays trivial.
  const bucketAt = (map, key) => { for (const entry of map) if (entry[0] === key) return entry[1]; return undefined; };
  const bucketFor = (map, collection) => { let bucket = bucketAt(map, collection); if (!bucket) { bucket = new Map(); map.set(collection, bucket); } return bucket; };
  const createJournal = () => {
    const inserted = new Map();
    const edited = new Map();
    const record = (collection, row, key) => {
      const perRow = bucketFor(edited, collection);
      let perField = bucketAt(perRow, row);
      if (!perField) { perField = new Map(); perRow.set(row, perField); }
      if (!perField.has(key)) perField.set(key, Object.prototype.hasOwnProperty.call(row, key) ? cloneValue(row[key]) : ABSENT);
    };
    return {
      add(collection, row) { let bucket = bucketAt(inserted, collection); if (!bucket) { bucket = new Set(); inserted.set(collection, bucket); } bucket.add(row); return row; },
      edit(collection, row) {
        if (!row || typeof row !== 'object') return row;
        return new Proxy(row, {
          set(target, key, value) { record(collection, target, key); target[key] = value; return true; },
          deleteProperty(target, key) { record(collection, target, key); return Reflect.deleteProperty(target, key); },
        });
      },
      rollback() {
        // Single-element splices only: the argument list never grows with the
        // collection size, so a large store cannot make the rollback itself throw
        // and mask the original commit error.
        for (const [collection, rows] of inserted) {
          const list = store.data[collection];
          if (!Array.isArray(list)) continue;
          for (let index = list.length - 1; index >= 0; index -= 1) if (rows.has(list[index])) list.splice(index, 1);
        }
        for (const perRow of edited.values()) {
          for (const [row, perField] of perRow) {
            for (const [key, previous] of perField) {
              if (previous === ABSENT) delete row[key];
              else row[key] = cloneValue(previous);
            }
          }
        }
      },
    };
  };
  // Every insert funnels through here, so a transaction owns its new rows
  // without each call site having to remember to register them.
  const insertRow = (collection, row) => { store.data[collection].unshift(row); const journal = activeJournal(); if (journal) journal.add(collection, row); return row; };
  const editRow = (collection, row) => { const journal = activeJournal(); return journal ? journal.edit(collection, row) : row; };
  const audit = (action, req, type, id, details = {}) => { const row = { id: store.nextId('auditEvents'), at: nowIso(), actor: req.user?.username || 'system', role: req.user?.role || 'SYSTEM', action, entityType: type, entityId: id ?? null, details }; insertRow('auditEvents', row); if (store.data.auditEvents.length > 5000) store.data.auditEvents.length = 5000; return row; };
  const addEvent = (ticket, type, req, details = {}) => { const row = { id: store.nextId('ticketEvents'), ticketId: ticket.id, at: nowIso(), type, actor: req.user?.username || 'system', details }; insertRow('ticketEvents', row); if (store.data.ticketEvents.length > 10000) store.data.ticketEvents.length = 10000; return row; };
  const save = () => store.commit();
  const transact = (mutate) => journalContext.run(createJournal(), async () => {
    const journal = activeJournal();
    try {
      const result = await mutate();
      await save();
      return result;
    } catch (err) {
      journal.rollback();
      throw err;
    }
  });
  // Single fail-soft notifier adapter. `notifier.alert(x).catch(...)` only
  // protects a rejected Promise: a synchronous throw, or a non-Promise return,
  // escapes it. This wraps the call in try/catch AND awaits the result, so every
  // failure shape (sync throw, sync return, async reject, null/undefined) is
  // normalized to `{ alerted: false }` and can never break the surrounding
  // request or leave a committed record in a half-written state.
  const NO_ALERT = Object.freeze({ alerted: false, reason: 'notifier-failed' });
  const configuredNotifyTimeout = Number(process.env.IT_NOTIFY_TIMEOUT_MS);
  const NOTIFY_TIMEOUT_MS = Number.isFinite(configuredNotifyTimeout) && configuredNotifyTimeout > 0 ? configuredNotifyTimeout : 2000;
  const safeNotify = async (ticket) => {
    const controller = new AbortController();
    const deadline = Date.now() + NOTIFY_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('notifier-timeout'));
        resolve({ alerted: false, reason: 'notifier-timeout' });
      }, NOTIFY_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      const settled = await Promise.race([
        (async () => notifier.alert(ticket, { signal: controller.signal, deadline }))(),
        timeout,
      ]);
      if (controller.signal.aborted) return { ...NO_ALERT, reason: 'notifier-aborted' };
      if (!settled || typeof settled !== 'object') return { ...NO_ALERT, reason: 'notifier-returned-non-object' };
      return settled;
    } catch (err) {
      controller.abort(err);
      return { ...NO_ALERT, reason: (err && err.message) || 'notifier-failed' };
    } finally {
      clearTimeout(timer);
    }
  };
  const find = (collection, id, label) => { const row = store.find(collection, id); if (!row) throw fail(404, `${label} không tồn tại.`); return row; };
  // Tenant-scoped reads. `findVisible` answers 404 for a row owned by another
  // tenant, which is deliberate: a 403 would confirm the row exists.
  const findForUser = (collection, id, label, req) => {
    const hit = findVisible(store.data[collection], req.user, id);
    if (!hit.found) throw fail(404, `${label} không tồn tại.`);
    return hit.row;
  };
  const ticketForUser = (id, req) => findForUser('tickets', id, 'Ticket', req);
  // Enhanced collection routes are registered before the legacy handlers below.
  // They keep the old field names while adding factory aliases and lifecycle data.
  app.get('/api/assets', (req, res) => {
    const rows = rowsVisibleTo(store.data.assets, req.user).filter((a) => {
      if (req.query.status && str(a.status).toLowerCase() !== str(req.query.status).toLowerCase() && str(a.lifecycleStatus).toLowerCase() !== str(req.query.status).toLowerCase()) return false;
      if (req.query.type && str(a.assetType || a.type).toLowerCase() !== str(req.query.type).toLowerCase()) return false;
      if (req.query.q) { const q = str(req.query.q).toLowerCase(); if (!JSON.stringify(a).toLowerCase().includes(q)) return false; }
      return true;
    });
    res.json(rows);
  });
  app.post('/api/assets', auth.requireAuth(PERMISSIONS.ASSET_WRITE), async (req, res, next) => {
    try {
      const body = req.body || {}; const assetTag = text(body, 'assetTag', false, 100) || text(body, 'tag', false, 100); const manufacturer = text(body, 'manufacturer', false, 120) || text(body, 'brand', false, 120); const model = text(body, 'model', false, 160); const serialNumber = text(body, 'serialNumber', false, 160) || text(body, 'serial', false, 160); const missing = [['assetTag', assetTag], ['manufacturer', manufacturer], ['model', model], ['serialNumber', serialNumber]].filter(([, value]) => !value).map(([field]) => field); if (missing.length) throw fail(400, 'Dữ liệu tài sản không hợp lệ.', missing);
      const assetType = upper(body.assetType || body.type || 'LAPTOP');
      if (!['LAPTOP', 'DESKTOP', 'SERVER', 'SWITCH', 'AP', 'PRINTER', 'LABEL_PRINTER', 'SCANNER', 'UPS', 'OTHER'].includes(assetType)) throw fail(422, 'assetType không hợp lệ.');
      const ipAddress = compact(body.ipAddress || body.ip, 45) || '-'; const vlan = body.vlan ? upper(body.vlan).replace(/^VLAN/, '') : null; if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ipAddress) && ipAddress !== '-') throw fail(422, 'IP không hợp lệ.'); if (vlan && !['10', '20', '30', '40', '50', '99'].includes(vlan)) throw fail(422, 'VLAN không hợp lệ.');
      const duplicate = store.data.assets.find((a) => str(a.assetTag || a.tag).toLowerCase() === assetTag.toLowerCase() || (serialNumber !== '-' && str(a.serialNumber || a.serial).toLowerCase() === serialNumber.toLowerCase())); if (duplicate) throw fail(409, 'Asset Tag hoặc serial đã tồn tại.');
      const legacy = body.assetTag === undefined && body.assetType === undefined; const requestedStatus = body.status || body.lifecycleStatus; const allowedStatuses = ['Active', 'In Storage', 'Maintenance', 'Retired', 'IN_STOCK', 'ASSIGNED', 'REPAIR', 'LOST']; if (requestedStatus && !allowedStatuses.includes(requestedStatus)) throw fail(422, 'Trạng thái tài sản không hợp lệ.'); const status = requestedStatus || (legacy ? 'Active' : 'IN_STOCK');
      const asset = { id: store.nextId('assets'), assetTag, tag: assetTag, assetType, type: assetType, manufacturer, brand: manufacturer, model, serialNumber, serial: serialNumber, assignedTo: compact(body.assignedTo || body.employee, 200) || 'Unassigned', dept: compact(body.dept || body.businessArea, 120) || 'General', businessArea: compact(body.businessArea || body.dept, 120) || 'General', location: compact(body.location, 160) || '-', ipAddress, ip: ipAddress, vlan: vlan ? `VLAN${vlan}` : null, status, lifecycleStatus: ({ Active: 'ASSIGNED', 'In Storage': 'IN_STOCK', Maintenance: 'REPAIR', Retired: 'RETIRED' })[status] || status, criticality: upper(body.criticality || 'MEDIUM'), createdAt: nowIso() };
      // The response must be the STAMPED row, not the pre-stamp literal: returning
      // the original would report a row without the tenant the store actually
      // persisted, which is exactly the kind of drift the isolation test exists
      // to catch.
      const owned = stampTenant(asset, req.user);
      store.data.assets.unshift(owned); audit('ASSET_CREATED', req, 'asset', asset.id, { assetTag }); await save(); res.status(201).json(owned);
    } catch (e) { next(e); }
  });
  app.get('/api/tickets', (req, res) => {
    const rows = rowsVisibleTo(store.data.tickets, req.user).filter((t) => { if (req.query.status && str(t.status).toLowerCase() !== str(req.query.status).toLowerCase() && str(t.state).toLowerCase() !== str(req.query.status).toLowerCase()) return false; if (req.query.priority && str(t.priority).toLowerCase() !== str(req.query.priority).toLowerCase() && str(t.priorityCode).toLowerCase() !== str(req.query.priority).toLowerCase()) return false; if (req.query.source && upper(t.source) !== upper(req.query.source)) return false; if (req.query.q && !JSON.stringify(t).toLowerCase().includes(str(req.query.q).toLowerCase())) return false; return true; });
    res.json(rows.map((row) => { slaBreach(row); return row; }));
  });
  app.post('/api/tickets', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.priority && !['Low', 'Medium', 'High', 'Critical'].includes(body.priority)) throw fail(422, 'Priority không hợp lệ.');
      const row = await transact(async () => {
        const created = await createTicket(body, req);
        if (!body.category) created.category = 'General';
        return created;
      });
      const alert = await safeNotify(row);
      res.status(201).json({ ...row, alerted: Boolean(alert && alert.alerted) });
    } catch (e) { next(e); }
  });


  // Legacy compatibility status endpoint. openapi.yaml documents the sequence
  // Open -> In Progress -> Resolved -> Closed, and the UI "Mở lại" action sends
  // `In Progress` for BOTH Resolved and Closed tickets, so the reopen path must
  // accept CLOSED -> IN_PROGRESS as well. Transitions are still constrained:
  // only the three statuses this endpoint has always exposed are reachable, and
  // CANCELLED stays terminal. `note` is part of the documented request DTO, so
  // it is persisted on the ticket and recorded in the timeline + audit trail.
  // `Open` is part of the documented compatibility contract: openapi.yaml
  // states that reopening to `Open` or `In Progress` clears `resolvedAt`, and
  // the removed legacy handler accepted any member of TICKET_STATUSES.
  const COMPAT_STATUS_TARGETS = new Set(['NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
  const COMPAT_STATUS_FROM = {
    NEW: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
    ASSIGNED: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
    IN_PROGRESS: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
    PENDING: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
    RESOLVED: ['NEW', 'IN_PROGRESS', 'CLOSED'],
    CLOSED: ['NEW', 'IN_PROGRESS'],
    CANCELLED: [],
  };
  const COMPAT_STATUS_LABEL = { NEW: 'Open', ASSIGNED: 'Assigned', IN_PROGRESS: 'In Progress', PENDING: 'Pending', RESOLVED: 'Resolved', CLOSED: 'Closed', CANCELLED: 'Cancelled' };
  // An unrecognised status must be rejected, not silently coerced to NEW.
  const parseCompatStatus = (raw) => {
    const value = str(raw);
    if (!value) return 'RESOLVED';
    const canonical = canonicalState(value, null);
    if (!canonical) throw fail(422, `Trạng thái không hợp lệ: ${value}.`);
    return canonical;
  };
  app.patch('/api/tickets/:id/status', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => {
    try {
      const row = ticketForUser(req.params.id, req);
      const requested = parseCompatStatus(req.body?.status);
      const allowed = (COMPAT_STATUS_FROM[row.state] || []).includes(requested);
      if (requested !== row.state && (!COMPAT_STATUS_TARGETS.has(requested) || !allowed)) throw fail(422, `Trạng thái không hợp lệ: ${req.body?.status}.`);
      const previous = row.state;
      row.state = requested; row.status = COMPAT_STATUS_LABEL[requested]; row.updatedAt = nowIso();
      if (requested === 'RESOLVED' || requested === 'CLOSED') { row.resolvedAt ||= legacyStamp(); row.resolvedAtIso ||= nowIso(); if (requested === 'CLOSED') row.closedAt ||= legacyStamp(); }
      // Reopening (to NEW or IN_PROGRESS) clears every resolution artefact so a
      // reopened ticket does not keep a stale resolve timestamp or resolution.
      else if (requested === 'NEW' || requested === 'IN_PROGRESS') { delete row.resolvedAt; delete row.resolvedAtIso; delete row.closedAt; row.resolutionCode = null; row.resolutionSummary = null; }
      const note = sanitizeText(req.body?.note, 2000);
      if (note) row.lastStatusNote = note;
      addEvent(row, 'STATUS_CHANGED', req, { from: previous, to: requested, compatibility: true, ...(note ? { note } : {}) });
      audit('TICKET_STATUS_COMPATIBILITY', req, 'ticket', row.id, { from: previous, target: requested, ...(note ? { note } : {}) });
      await save(); res.json(row);
    } catch (e) { next(e); }
  });
  app.get('/api/tickets/:id', (req, res, next) => { if (req.params.id === 'export.csv') return next(); try { const row = ticketForUser(req.params.id, req); slaBreach(row); res.json(row); } catch (e) { next(e); } });
  app.patch('/api/assets/:id', auth.requireAuth(PERMISSIONS.ASSET_WRITE), async (req, res, next) => {
    try {
      const asset = findForUser('assets', req.params.id, 'Tài sản', req); const body = req.body || {};
      const nextTag = body.assetTag ?? body.tag; const nextType = body.assetType ?? body.type; const nextBrand = body.manufacturer ?? body.brand; const nextSerial = body.serialNumber ?? body.serial;
      // openapi.yaml documents a 400 for this endpoint and the removed legacy
      // validator rejected a no-op patch. Reject BEFORE any audit row, mutation
      // or commit so an empty patch leaves no trace.
      const PATCHABLE = ['assetTag', 'tag', 'assetType', 'type', 'manufacturer', 'brand', 'model', 'serialNumber', 'serial', 'assignedTo', 'employee', 'dept', 'businessArea', 'location', 'hostname', 'macAddress', 'notes', 'ipAddress', 'ip', 'vlan', 'criticality', 'status', 'lifecycleStatus'];
      if (!PATCHABLE.some((field) => body[field] !== undefined)) throw fail(400, 'Không có trường nào cần cập nhật.', ['payload rỗng']);
      if (nextTag !== undefined && store.data.assets.some((a) => Number(a.id) !== Number(asset.id) && str(a.assetTag || a.tag).toLowerCase() === str(nextTag).toLowerCase())) throw fail(409, 'Asset Tag đã tồn tại.');
      if (nextSerial && String(nextSerial) !== '-' && store.data.assets.some((a) => Number(a.id) !== Number(asset.id) && str(a.serialNumber || a.serial).toLowerCase() === str(nextSerial).toLowerCase())) throw fail(409, 'Serial đã tồn tại.');
      if (nextType !== undefined && !['LAPTOP', 'DESKTOP', 'SERVER', 'SWITCH', 'AP', 'PRINTER', 'LABEL_PRINTER', 'SCANNER', 'UPS', 'OTHER'].includes(upper(nextType))) throw fail(422, 'assetType không hợp lệ.');
      if (body.status !== undefined || body.lifecycleStatus !== undefined) { const status = body.lifecycleStatus || body.status; if (!['Active', 'In Storage', 'Maintenance', 'Retired', 'IN_STOCK', 'ASSIGNED', 'REPAIR', 'LOST'].includes(status)) throw fail(422, 'Trạng thái tài sản không hợp lệ.'); asset.status = status; asset.lifecycleStatus = ({ Active: 'ASSIGNED', 'In Storage': 'IN_STOCK', Maintenance: 'REPAIR', Retired: 'RETIRED' })[status] || status; }
      if (nextTag !== undefined) { asset.assetTag = compact(nextTag, 100); asset.tag = asset.assetTag; }
      if (nextType !== undefined) { asset.assetType = upper(nextType); asset.type = asset.assetType; }
      if (nextBrand !== undefined) { asset.manufacturer = compact(nextBrand, 120); asset.brand = asset.manufacturer; }
      if (body.model !== undefined) asset.model = compact(body.model, 160);
      if (nextSerial !== undefined) { asset.serialNumber = compact(nextSerial, 160) || '-'; asset.serial = asset.serialNumber; }
      for (const field of ['assignedTo', 'dept', 'businessArea', 'location', 'hostname', 'macAddress', 'notes']) if (body[field] !== undefined) asset[field] = compact(body[field], 500);
      if (body.employee !== undefined && body.assignedTo === undefined) asset.assignedTo = compact(body.employee, 200);
      if (body.ipAddress !== undefined || body.ip !== undefined) { const ip = compact(body.ipAddress ?? body.ip, 45) || '-'; if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip !== '-') throw fail(422, 'IP không hợp lệ.'); asset.ipAddress = ip; asset.ip = ip; }
      if (body.vlan !== undefined) { const vlan = upper(body.vlan).replace(/^VLAN/, ''); if (!['10', '20', '30', '40', '50', '99'].includes(vlan)) throw fail(422, 'VLAN không hợp lệ.'); asset.vlan = `VLAN${vlan}`; }
      if (body.criticality !== undefined) asset.criticality = upper(body.criticality); asset.updatedAt = nowIso(); audit('ASSET_UPDATED', req, 'asset', asset.id); await save(); res.json(asset);
    } catch (e) { next(e); }
  });

  app.post('/api/auth/login', (req, res) => { const session = auth.login(req.body?.username, req.body?.password); if (!session) { audit('LOGIN_FAILED', req, 'auth', null, { username: compact(req.body?.username, 100) }); return res.status(401).json({ error: 'Invalid lab credentials.', status: 401 }); } audit('LOGIN_SUCCESS', req, 'auth', null, { username: session.username, role: session.role }); res.json(session); });
  app.post('/api/auth/logout', auth.requireAuth(), (req, res) => { const token = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]; if (token) auth.revoke(token); res.json({ success: true }); });
  app.get('/api/auth/me', auth.requireAuth(), (req, res) => res.json({ user: req.user, permissions: auth.rolePermissions(req.user.role) }));
  app.post('/api/assets/:id/assign', auth.requireAuth(PERMISSIONS.ASSET_ASSIGN), async (req, res, next) => { try { const asset = findForUser('assets', req.params.id, 'Tài sản', req); const assignedTo = text(req.body, 'assignedTo', true, 200); Object.assign(asset, { assignedTo, lifecycleStatus: 'ASSIGNED', status: 'ASSIGNED', dept: compact(req.body?.dept || asset.dept, 120), businessArea: compact(req.body?.businessArea || asset.businessArea, 120), updatedAt: nowIso() }); audit('ASSET_ASSIGNED', req, 'asset', asset.id, { assignedTo }); await save(); res.json(asset); } catch (e) { next(e); } });
  app.post('/api/assets/:id/recover', auth.requireAuth(PERMISSIONS.ASSET_ASSIGN), async (req, res, next) => { try { const asset = findForUser('assets', req.params.id, 'Tài sản', req); Object.assign(asset, { assignedTo: 'Unassigned', lifecycleStatus: 'IN_STOCK', status: 'IN_STOCK', updatedAt: nowIso() }); audit('ASSET_RECOVERED', req, 'asset', asset.id); await save(); res.json(asset); } catch (e) { next(e); } });

  app.get('/api/tickets/:id/timeline', (req, res, next) => { try { const row = ticketForUser(req.params.id, req); res.json(store.data.ticketEvents.filter((item) => Number(item.ticketId) === Number(row.id)).sort((a, b) => a.id - b.id)); } catch (e) { next(e); } });
  app.post('/api/tickets/:id/assign', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => { try { const row = ticketForUser(req.params.id, req); Object.assign(row, { assignee: compact(req.body?.assignee, 200) || null, assignedGroup: compact(req.body?.assignedGroup, 160) || null, acknowledgedAt: row.acknowledgedAt || nowIso() }); if (row.state === 'NEW') { row.state = 'ASSIGNED'; row.status = 'Assigned'; } addEvent(row, 'ASSIGNMENT_CHANGED', req, { assignee: row.assignee, assignedGroup: row.assignedGroup }); audit('TICKET_ASSIGNED', req, 'ticket', row.id); await save(); res.json(row); } catch (e) { next(e); } });
  app.post('/api/tickets/:id/work-notes', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => { try { const row = ticketForUser(req.params.id, req); const body = sanitizeText(req.body?.body, 4000); if (!body) throw fail(400, 'Work note không được để trống.'); const note = addEvent(row, 'WORK_NOTE_ADDED', req, { body }); audit('TICKET_WORK_NOTE_ADDED', req, 'ticket', row.id); await save(); res.status(201).json(note); } catch (e) { next(e); } });
  app.post('/api/tickets/:id/transition', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => { try { const row = ticketForUser(req.params.id, req); const target = canonicalState(req.body?.status || req.body?.state); if (isResolutionState(target) && (!compact(req.body?.resolutionCode, 80) || !compact(req.body?.resolutionSummary, 2000))) throw fail(422, 'Resolution code và resolution summary là bắt buộc khi resolve/close.'); const previous = row.state; assertTransition(previous, target); row.state = target; row.status = ({ NEW: 'Open', ASSIGNED: 'Assigned', IN_PROGRESS: 'In Progress', PENDING: 'Pending', RESOLVED: 'Resolved', CLOSED: 'Closed', CANCELLED: 'Cancelled' })[target]; row.updatedAt = nowIso(); if (target !== 'NEW' && !row.acknowledgedAt) row.acknowledgedAt = nowIso(); if (isResolutionState(target)) { row.resolvedAt ||= nowIso(); row.resolutionCode = compact(req.body?.resolutionCode, 80); row.resolutionSummary = sanitizeText(req.body?.resolutionSummary, 2000); } if (target === 'CLOSED') row.closedAt ||= nowIso(); addEvent(row, 'STATUS_CHANGED', req, { from: previous, to: target }); audit('TICKET_TRANSITION', req, 'ticket', row.id, { target }); await save(); res.json(row); } catch (e) { next(e); } });


  const text = (body, field, required = false, max = 500) => { const value = compact(body?.[field], max); if (required && !value) throw fail(400, `Thiếu trường bắt buộc: ${field}.`); return value; };
  const slaBreach = (row) => { if (row.slaBreachedAt || ['RESOLVED', 'CLOSED', 'CANCELLED'].includes(row.state)) return false; const target = new Date(row.slaTargetAt); const now = clock(); if (Number.isNaN(target.getTime()) || now <= target) return false; row.slaBreachedAt = now.toISOString(); row.slaBreached = true; addEvent(row, 'SLA_BREACHED', { user: { username: 'sla-engine', role: 'SYSTEM' } }, { target: target.toISOString() }); safeNotify({ ...row, title: `SLA breached: ${row.title}` }).catch(() => {}); return true; };
  const createTicket = async (body, req, extra = {}) => { const impact = upper(body.impact || (body.priority === 'Critical' ? 'HIGH' : body.priority === 'High' ? 'MEDIUM' : body.priority === 'Low' ? 'LOW' : 'MEDIUM')); const urgency = upper(body.urgency || impact); if (!['LOW', 'MEDIUM', 'HIGH'].includes(impact) || !['LOW', 'MEDIUM', 'HIGH'].includes(urgency)) throw fail(422, 'Impact/urgency không hợp lệ.'); const row = normalizeTicketRecord({ id: store.nextId('tickets', 1001), title: text(body, 'title', true, 300), requester: text(body, 'requester', true, 200), dept: compact(body.dept || 'General', 120), category: upper(body.category || 'OTHER'), service: compact(body.service || 'IT Support', 160), type: upper(body.type || 'INCIDENT'), priority: body.priority, impact, urgency, source: upper(body.source || 'USER'), externalRef: compact(body.externalRef, 120), correlationId: compact(body.correlationId, 160), referenceType: compact(body.referenceType, 80), referenceNo: compact(body.referenceNo, 120), description: sanitizeText(body.description, 4000), relatedAssetId: body.relatedAssetId ?? null, state: 'NEW', status: 'Open', createdAt: new Date(clock()).toISOString().slice(0, 16).replace('T', ' '), openedAt: nowIso(), ...extra }); const owned = stampTenant(row, req.user); insertRow('tickets', owned); addEvent(row, 'TICKET_CREATED', req, { source: row.source }); audit('TICKET_CREATED', req, 'ticket', row.id, { source: row.source, priorityCode: row.priorityCode });
    // Await the notifier so callers can report the real outcome. A notifier
    // failure must never break ticket creation (legacy contract), so catch and
    // report `alerted: false` instead of throwing.
    // NOTE: notification is deliberately NOT performed here. The caller must
    // commit the ticket, its creation event and its audit row FIRST, and only
    // then alert. Awaiting an external side effect before the commit meant a
    // stuck notifier blocked persistence, and a later commit failure produced an
    // externally announced ticket that was never durable.
    return owned;
  };

  // ITSM problem/change records
  app.get('/api/problems', (req, res) => res.json(rowsVisibleTo(store.data.problems, req.user)));
  app.post('/api/problems', auth.requireAuth(PERMISSIONS.PROBLEM_WRITE), async (req, res, next) => {
    try { const body = req.body || {}; const row = { id: store.nextId('problems'), title: text(body, 'title', true, 300), service: compact(body.service, 160), status: upper(body.status || 'OPEN'), rootCause: sanitizeText(body.rootCause, 4000), workaround: sanitizeText(body.workaround, 4000), knownError: Boolean(body.knownError), linkedTicketIds: [], owner: compact(body.owner, 200) || req.user?.username || 'unassigned', createdAt: nowIso(), updatedAt: nowIso() }; // Stamped with the creator's session tenant, like every other tenant-owned
      // collection. Without this the row would be invisible to its own creator
      // once the lists became scoped.
      const owned = stampTenant(row, req.user);
      store.data.problems.unshift(owned); audit('PROBLEM_CREATED', req, 'problem', row.id); await save(); res.status(201).json(owned); } catch (e) { next(e); }
  });
  app.get('/api/problems/:id', (req, res, next) => { try { res.json(findForUser('problems', req.params.id, 'Problem', req)); } catch (e) { next(e); } });
  app.patch('/api/problems/:id', auth.requireAuth(PERMISSIONS.PROBLEM_WRITE), async (req, res, next) => { try { const row = findForUser('problems', req.params.id, 'Problem', req); const body = req.body || {}; for (const field of ['title', 'service', 'status', 'rootCause', 'workaround', 'owner']) if (body[field] !== undefined) row[field] = compact(body[field], 4000); if (body.knownError !== undefined) row.knownError = Boolean(body.knownError); row.updatedAt = nowIso(); audit('PROBLEM_UPDATED', req, 'problem', row.id); await save(); res.json(row); } catch (e) { next(e); } });
  app.post('/api/problems/:id/link-ticket', auth.requireAuth(PERMISSIONS.PROBLEM_WRITE), async (req, res, next) => { try { const row = findForUser('problems', req.params.id, 'Problem', req); const linked = ticketForUser(req.body?.ticketId, req); if (!row.linkedTicketIds.includes(linked.id)) row.linkedTicketIds.push(linked.id); row.updatedAt = nowIso(); audit('PROBLEM_TICKET_LINKED', req, 'problem', row.id, { ticketId: linked.id }); await save(); res.json(row); } catch (e) { next(e); } });
  app.get('/api/changes', (req, res) => res.json(rowsVisibleTo(store.data.changes, req.user)));
  app.post('/api/changes', auth.requireAuth(PERMISSIONS.CHANGE_WRITE), async (req, res, next) => {
    try { const body = req.body || {}; const risk = upper(body.risk || 'MEDIUM'); const rollbackPlan = sanitizeText(body.rollbackPlan, 4000); if (['HIGH', 'CRITICAL'].includes(risk) && !rollbackPlan) throw fail(422, 'High-risk change yêu cầu rollbackPlan.'); const row = { id: store.nextId('changes'), title: text(body, 'title', true, 300), reason: sanitizeText(body.reason, 4000), risk, impact: sanitizeText(body.impact, 4000), implementationPlan: sanitizeText(body.implementationPlan, 4000), rollbackPlan, maintenanceWindow: compact(body.maintenanceWindow, 300), approvalState: 'PENDING', implementationState: 'PLANNED', owner: compact(body.owner, 200) || req.user?.username || 'unassigned', createdAt: nowIso(), updatedAt: nowIso() }; const ownedChange = stampTenant(row, req.user); store.data.changes.unshift(ownedChange); audit('CHANGE_CREATED', req, 'change', row.id, { risk }); await save(); res.status(201).json(ownedChange); } catch (e) { next(e); }
  });
  app.get('/api/changes/:id', (req, res, next) => { try { res.json(findForUser('changes', req.params.id, 'Change', req)); } catch (e) { next(e); } });
  app.patch('/api/changes/:id', auth.requireAuth(PERMISSIONS.CHANGE_WRITE), async (req, res, next) => { try { const row = findForUser('changes', req.params.id, 'Change', req); const body = req.body || {}; for (const field of ['title', 'reason', 'risk', 'impact', 'implementationPlan', 'rollbackPlan', 'maintenanceWindow', 'owner']) if (body[field] !== undefined) row[field] = compact(body[field], 4000); if (['HIGH', 'CRITICAL'].includes(upper(row.risk)) && !row.rollbackPlan) throw fail(422, 'High-risk change yêu cầu rollbackPlan.'); row.updatedAt = nowIso(); audit('CHANGE_UPDATED', req, 'change', row.id); await save(); res.json(row); } catch (e) { next(e); } });
  app.post('/api/changes/:id/approve', auth.requireAuth(PERMISSIONS.CHANGE_APPROVE), async (req, res, next) => { try { const row = findForUser('changes', req.params.id, 'Change', req); row.approvalState = 'APPROVED'; row.approvedBy = req.user?.username; row.approvedAt = nowIso(); audit('CHANGE_APPROVED', req, 'change', row.id); await save(); res.json(row); } catch (e) { next(e); } });
  app.post('/api/changes/:id/implement', auth.requireAuth(PERMISSIONS.CHANGE_WRITE), async (req, res, next) => { try { const row = findForUser('changes', req.params.id, 'Change', req); if (row.approvalState !== 'APPROVED') throw fail(422, 'Change chưa được approve.'); row.implementationState = 'IMPLEMENTING'; audit('CHANGE_IMPLEMENTATION_STARTED', req, 'change', row.id); await save(); res.json(row); } catch (e) { next(e); } });
  app.post('/api/changes/:id/close', auth.requireAuth(PERMISSIONS.CHANGE_WRITE), async (req, res, next) => { try { const row = findForUser('changes', req.params.id, 'Change', req); row.implementationState = 'CLOSED'; row.closedAt = nowIso(); audit('CHANGE_CLOSED', req, 'change', row.id); await save(); res.json(row); } catch (e) { next(e); } });



  // Access requests: JSON handoff only; no arbitrary PowerShell is accepted.
  const accessBody = (body) => {
    const requestType = upper(body.requestType || 'ONBOARDING');
    if (!['ONBOARDING', 'OFFBOARDING'].includes(requestType)) throw fail(422, 'requestType không hợp lệ.');
    return { requestType, employeeId: text(body, 'employeeId', true, 100), name: text(body, 'name', true, 200), upn: compact(body.upn, 256), manager: compact(body.manager, 200), department: compact(body.department, 120), jobRole: compact(body.jobRole, 160), requiredDate: compact(body.requiredDate, 40), requestedGroups: Array.isArray(body.requestedGroups) ? body.requestedGroups.map((g) => compact(g, 120)).filter(Boolean) : [], requestedErpRole: compact(body.requestedErpRole, 120) || null };
  };
  app.get('/api/access-requests', (req, res) => res.json(store.data.accessRequests));
  app.get('/api/access-requests/:id', (req, res, next) => { try { res.json(find('accessRequests', req.params.id, 'Access request')); } catch (e) { next(e); } });
  app.post('/api/access-requests', auth.requireAuth(PERMISSIONS.TICKET_WRITE), async (req, res, next) => { try { const row = { id: store.nextId('accessRequests'), ...accessBody(req.body || {}), approvalState: 'PENDING', executionState: 'NOT_STARTED', createdAt: nowIso(), evidence: [] }; store.data.accessRequests.unshift(row); audit('ACCESS_REQUEST_CREATED', req, 'accessRequest', row.id, { requestType: row.requestType, employeeId: row.employeeId }); await save(); res.status(201).json(row); } catch (e) { next(e); } });
  app.post('/api/access-requests/:id/approve', auth.requireAuth(PERMISSIONS.ACCESS_APPROVE), async (req, res, next) => { try { const row = find('accessRequests', req.params.id, 'Access request'); if (row.approvalState === 'APPROVED') return res.json({ ...row, idempotent: true }); row.approvalState = 'APPROVED'; row.approvedAt = nowIso(); row.approvedBy = req.user?.username; row.executionState = 'READY'; audit('ACCESS_REQUEST_APPROVED', req, 'accessRequest', row.id); await save(); res.json(row); } catch (e) { next(e); } });
  app.get('/api/access-requests/:id/handoff', auth.requireAuth(PERMISSIONS.ACCESS_APPROVE), (req, res, next) => { try { const row = find('accessRequests', req.params.id, 'Access request'); res.json({ requestId: row.id, operation: row.requestType === 'ONBOARDING' ? 'NEW_COMPANY_USER' : 'DISABLE_COMPANY_USER', employeeId: row.employeeId, name: row.name, upn: row.upn, department: row.department, requestedGroups: row.requestedGroups, requestedErpRole: row.requestedErpRole, note: 'Validated JSON handoff only; arbitrary commands are not accepted.' }); } catch (e) { next(e); } });
  app.post('/api/access-requests/:id/complete', auth.requireAuth(PERMISSIONS.ACCESS_APPROVE), async (req, res, next) => { try { const row = find('accessRequests', req.params.id, 'Access request'); if (row.executionState === 'COMPLETED') return res.json({ ...row, idempotent: true }); row.executionState = 'COMPLETED'; row.completedAt = nowIso(); row.executor = req.user?.username; row.evidence.push({ at: nowIso(), by: row.executor, evidence: text(req.body, 'evidence', false, 4000) }); audit('ACCESS_REQUEST_COMPLETED', req, 'accessRequest', row.id); await save(); res.json(row); } catch (e) { next(e); } });
  app.post('/api/access-requests/:id/offboard', auth.requireAuth(PERMISSIONS.ACCESS_APPROVE), async (req, res, next) => { try { const row = find('accessRequests', req.params.id, 'Access request'); if (row.requestType !== 'OFFBOARDING') throw fail(422, 'requestType phải là OFFBOARDING.'); if (row.executionState === 'COMPLETED') return res.json({ ...row, idempotent: true }); row.executionState = 'COMPLETED'; row.completedAt = nowIso(); row.executor = req.user?.username; row.revokedGroups = row.requestedGroups; row.erpAccessRevoked = Boolean(row.requestedErpRole); row.assetRecoveryState = 'PENDING_VERIFICATION'; row.evidence.push({ at: nowIso(), by: row.executor, evidence: text(req.body, 'evidence', false, 4000) || 'Checklist recorded' }); audit('ACCESS_REQUEST_OFFBOARDED', req, 'accessRequest', row.id, { employeeId: row.employeeId }); await save(); res.json(row); } catch (e) { next(e); } });
  // Monitoring: checks are explicit API runs; no fast background poller is required.
  const monitorView = (row) => ({ ...row, consecutiveFailures: Number(row.consecutiveFailures || 0), failureThreshold: Number(row.failureThreshold || 3), status: row.status || 'UNKNOWN' });
  const monitorHistory = (id) => store.data.monitoringHistory.filter((row) => !id || Number(row.checkId) === Number(id));
  async function probe(check, hint) { if (typeof monitoring.runCheck === 'function') return monitoring.runCheck(check, hint); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000); try { if (check.type === 'HTTP') { const response = await fetch(check.target, { signal: controller.signal }); return { status: response.ok ? 'UP' : 'DOWN', message: `HTTP ${response.status}` }; } if (check.type === 'TCP') return await new Promise((resolve) => { const socket = net.createConnection({ host: check.target, port: Number(check.port) }); const done = (status, message) => { socket.destroy(); resolve({ status, message }); }; socket.setTimeout(5000, () => done('DOWN', 'TCP timeout')); socket.once('connect', () => done('UP', 'TCP connected')); socket.once('error', (error) => done('DOWN', error.message)); }); if (check.type === 'DNS') { await dns.resolveAny(check.target); return { status: 'UP', message: 'DNS resolved' }; } return { status: 'DOWN', message: 'Unsupported probe' }; } catch (e) { return { status: hint || 'DOWN', message: e.message }; } finally { clearTimeout(timer); } }
  const activeIncident = (id) => store.data.tickets.find((row) => row.monitorCheckId === Number(id) && row.source === 'MONITORING' && !['RESOLVED', 'CLOSED', 'CANCELLED'].includes(row.state));
  app.get('/api/monitoring/checks', (req, res) => res.json(store.data.monitoringChecks.map(monitorView)));
  app.get('/api/monitoring/checks/:id', (req, res, next) => { try { res.json(monitorView(find('monitoringChecks', req.params.id, 'Monitoring check'))); } catch (e) { next(e); } });
  app.post('/api/monitoring/checks', auth.requireAuth(PERMISSIONS.MONITOR_WRITE), async (req, res, next) => { try { const body = req.body || {}; const type = upper(body.type || 'HTTP'); if (!['HTTP', 'TCP', 'DNS'].includes(type)) throw fail(422, 'Monitoring type không hợp lệ.'); const row = { id: store.nextId('monitoringChecks'), name: compact(body.name || body.target, 200), type, target: text(body, 'target', true, 500), port: body.port ? Number(body.port) : null, failureThreshold: Math.max(1, Number(body.failureThreshold || 3)), businessService: compact(body.businessService || body.name, 160), criticality: upper(body.criticality || 'MEDIUM'), enabled: body.enabled === undefined ? true : Boolean(body.enabled), consecutiveFailures: 0, status: 'UNKNOWN', createdAt: nowIso() }; store.data.monitoringChecks.unshift(row); audit('MONITOR_CHECK_CREATED', req, 'monitoringCheck', row.id); await save(); res.status(201).json(monitorView(row)); } catch (e) { next(e); } });
  app.patch('/api/monitoring/checks/:id', auth.requireAuth(PERMISSIONS.MONITOR_WRITE), async (req, res, next) => { try { const row = find('monitoringChecks', req.params.id, 'Monitoring check'); for (const field of ['name', 'target', 'businessService', 'criticality']) if (req.body?.[field] !== undefined) row[field] = compact(req.body[field], 500); if (req.body?.enabled !== undefined) row.enabled = Boolean(req.body.enabled); if (req.body?.failureThreshold !== undefined) row.failureThreshold = Math.max(1, Number(req.body.failureThreshold)); audit('MONITOR_CHECK_UPDATED', req, 'monitoringCheck', row.id); await save(); res.json(monitorView(row)); } catch (e) { next(e); } });
  app.post('/api/monitoring/checks/:id/run', auth.requireAuth(PERMISSIONS.MONITOR_WRITE), async (req, res, next) => { try { const pendingAlerts = []; let check; let history; await transact(async () => { check = editRow('monitoringChecks', find('monitoringChecks', req.params.id, 'Monitoring check')); const result = await probe(check, monitoring.runCheck ? upper(req.body?.status) : undefined); const status = ['UP', 'DOWN', 'DEGRADED'].includes(upper(result.status)) ? upper(result.status) : 'DOWN'; const oldStatus = check.status; check.status = status; check.lastCheckedAt = nowIso(); check.lastMessage = compact(result.message, 500); if (status === 'UP') { check.consecutiveFailures = 0; const active = editRow('tickets', activeIncident(check.id)); if (active) { active.state = 'RESOLVED'; active.status = 'Resolved'; active.resolvedAt = nowIso(); active.resolutionCode = 'RECOVERED'; active.resolutionSummary = `Monitoring recovered: ${check.name}`; addEvent(active, 'MONITOR_RECOVERED', req, { checkId: check.id }); check.activeIncidentId = null; } } else { check.consecutiveFailures += 1; if (check.consecutiveFailures >= check.failureThreshold && !activeIncident(check.id)) { const incident = await createTicket({ title: `Monitoring DOWN: ${check.name}`, requester: 'monitoring-engine', dept: 'IT Operations', category: 'OTHER', service: check.businessService, impact: check.criticality === 'CRITICAL' ? 'HIGH' : 'MEDIUM', urgency: check.criticality === 'CRITICAL' ? 'HIGH' : 'MEDIUM', source: 'MONITORING', description: check.lastMessage }, req, { monitorCheckId: check.id }); check.activeIncidentId = incident.id; pendingAlerts.push(incident); } } history = { id: store.nextId('monitoringHistory'), checkId: check.id, at: nowIso(), status, message: check.lastMessage, consecutiveFailures: check.consecutiveFailures, correlationId: check.activeIncidentId || null }; insertRow('monitoringHistory', history); if (store.data.monitoringHistory.length > 5000) store.data.monitoringHistory.length = 5000; });
      // Durable first: check status, history row and the incident's idempotency
      // state are committed before any external alert is sent.
      for (const incidentRow of pendingAlerts) await safeNotify(incidentRow);
      res.json({ check: monitorView(check), history });
    } catch (e) { next(e); } });
  app.get('/api/monitoring/status', (req, res) => { const checks = store.data.monitoringChecks.map(monitorView); res.json({ checks, up: checks.filter((x) => x.status === 'UP').length, down: checks.filter((x) => x.status === 'DOWN').length, degraded: checks.filter((x) => x.status === 'DEGRADED').length }); });
  app.get('/api/monitoring/history', (req, res) => { const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100))); res.json({ items: monitorHistory(req.query.checkId).slice(0, limit), count: monitorHistory(req.query.checkId).length }); });
  // GET /api/monitoring/ops-report — FPT evidence: automated operational report
  // (tổng hợp monitoring + SLA + backlog + AI activity thành report định kỳ).
  // Aggregate-only (không title/requester/log body) → mọi vai trò đăng nhập đọc
  // được; global /api auth middleware vẫn bắt anonymous (401).
  // ?windowHours=1..168 (mặc định 24) & ?format=markdown để paste thẳng vào
  // ticket/standup; mặc định JSON.
  app.get('/api/monitoring/ops-report', (req, res, next) => {
    try {
      // Clamp tường minh [1,168]: `Number('0') || 24` sẽ nuốt 0 thành mặc định,
      // nên parse rồi so sánh riêng (rỗng/không phải số → 24).
      const raw = String(req.query.windowHours ?? '').trim();
      const parsed = Number(raw);
      const hours = raw !== '' && Number.isFinite(parsed)
        ? Math.min(168, Math.max(1, Math.trunc(parsed)))
        : 24;
      const end = clock();
      const start = new Date(end.getTime() - hours * 3600 * 1000);
      const report = buildOpsReport({
        windowStart: start,
        windowEnd: end,
        checks: store.data.monitoringChecks.map(monitorView),
        history: store.data.monitoringHistory || [],
        tickets: store.data.tickets || [],
        auditEvents: store.data.auditEvents || [],
      });
      if (String(req.query.format || '').toLowerCase() === 'markdown') {
        res.type('text/markdown; charset=utf-8').send(renderMarkdown(report));
        return;
      }
      res.json(report);
    } catch (e) { next(e); }
  });




  // Authenticated MiniERP receiver with source + externalRef idempotency.
  app.post('/api/integrations/minierp/incidents', async (req, res, next) => {
    const token = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    if (!integrationKey || !sameSecret(integrationKey, token)) { audit('MINIERP_KEY_REJECTED', req, 'integration', 'MiniERP'); return res.status(401).json({ error: 'Invalid MiniERP integration key.', status: 401 }); }
    try {
      const body = req.body || {}; const title = text(body, 'title', true, 300);
      // The accepted cap must equal the cap createTicket stores (120). A wider
      // accept window stored a truncated row while the replay lookup below
      // compared the untruncated reference, so a reference of 121..160 chars
      // never matched its own row and every replay created a second incident.
      const externalRef = text(body, 'externalRef', true, 120);
      const source = upper(body.source || 'MINIERP');
      if (source !== 'MINIERP') throw fail(422, 'source phải là MINIERP.');
      const fingerprint = stableHash({ source, externalRef, title, service: compact(body.service, 160), description: sanitizeText(body.description, 4000), referenceType: compact(body.referenceType, 80), referenceNo: compact(body.referenceNo, 120), correlationId: compact(body.correlationId, 160) });
      const existing = store.data.tickets.find((row) => row.source === source && row.externalRef === externalRef);
      if (existing) { if (existing.integrationFingerprint !== fingerprint) throw fail(409, 'externalRef đã tồn tại với payload khác.'); return res.json({ ...existing, idempotent: true }); }
      const severity = upper(body.severity || 'MEDIUM'); const impact = ['CRITICAL', 'HIGH'].includes(severity) ? 'HIGH' : severity === 'LOW' ? 'LOW' : 'MEDIUM';
      const row = await transact(() => createTicket({ source, externalRef, category: 'ERP', service: body.service, title, description: body.description, impact, urgency: impact, requester: 'MiniERP', dept: 'ERP Operations', correlationId: body.correlationId, referenceType: body.referenceType, referenceNo: body.referenceNo }, req, { integrationFingerprint: fingerprint, integrationSource: source }));
      const alert = await safeNotify(row);
      return res.status(201).json({ ...row, alerted: Boolean(alert && alert.alerted) });
    } catch (e) { return next(e); }
  });

  app.get('/api/audit', auth.requireAuth(PERMISSIONS.AUDIT_READ), (req, res) => { const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100))); res.json({ items: store.data.auditEvents.slice(0, limit), count: store.data.auditEvents.length }); });

  return { auth };
}

module.exports = { registerEnterpriseRoutes };

