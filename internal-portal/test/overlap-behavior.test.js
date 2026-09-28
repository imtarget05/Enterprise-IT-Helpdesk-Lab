'use strict';

/**
 * Important 1 — Executable behaviour matrix for the 7 overlapping signatures
 * whose shadowed legacy registrations were removed in W1.
 *
 * The W1 matrix was a one-off probe that identified the WINNING HANDLER from a
 * single enterprise-only field. That is not the same as proving no legacy
 * behaviour was lost. This file asserts the actual legacy contract for every
 * one of the seven signatures through real HTTP, so a future change that drops a
 * legacy semantic fails here instead of silently winning on a field check.
 *
 * Each test names the break it catches and asserts consumer-visible behaviour
 * (status code + response body + persisted side effect), never handler identity.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

async function open(extra = {}) { const c = await createTestClient({ requestLogger: false, ...extra }); await c.start(); return c; }

const VALID_ASSET = { assetTag: 'BM-MATRIX-1', type: 'LAPTOP', manufacturer: 'Dell', model: 'X1', serial: 'SN-MATRIX-1' };
const VALID_ASSET_LEGACY_SHAPE = { tag: 'BM-MATRIX-2', type: 'LAPTOP', brand: 'HP', model: 'X2', serial: 'SN-MATRIX-2' };

// ---------------------------------------------------------------- signature 1
// GET /api/tickets — legacy filter contract: ?status / ?priority / ?q
test('GET /api/tickets giu legacy filter status/priority/q', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'Matrix filter probe', requester: 'Probe', priority: 'High' });
    assert.equal(created.status, 201);

    const all = await c.json('GET', '/api/tickets');
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.data) && all.data.length > 1, 'collection phai tra nhieu hon 1 ticket');

    const byStatus = await c.json('GET', '/api/tickets?status=Open');
    assert.equal(byStatus.status, 200);
    assert.ok(byStatus.data.length > 0, '?status=Open phai tra it nhat ticket vua tao');
    assert.ok(byStatus.data.every((t) => t.status === 'Open'), '?status=Open phai chi tra ticket Open');

    const byPriority = await c.json('GET', '/api/tickets?priority=High');
    assert.equal(byPriority.status, 200);
    assert.ok(byPriority.data.every((t) => t.priority === 'High' || t.priorityCode === 'P2'), '?priority=High phai loc dung');

    const byQ = await c.json('GET', '/api/tickets?q=Matrix filter probe');
    assert.equal(byQ.status, 200);
    assert.ok(byQ.data.some((t) => t.title === 'Matrix filter probe'), '?q phai tim thay ticket theo tieu de');
  } finally { await c.cleanup(); }
});

// ---------------------------------------------------------------- signature 2
// POST /api/tickets — legacy 400 on missing title/requester, 422 on bad priority,
// default priority=Medium / category=General, alerted flag, createdAt format.
test('POST /api/tickets giu validation 400/422 va default Medium/General', async () => {
  const c = await open();
  try {
    const noTitle = await c.json('POST', '/api/tickets', { requester: 'P' });
    assert.equal(noTitle.status, 400, 'thieu title phai 400');
    const noRequester = await c.json('POST', '/api/tickets', { title: 'T' });
    assert.equal(noRequester.status, 400, 'thieu requester phai 400');
    const badPriority = await c.json('POST', '/api/tickets', { title: 'T', requester: 'R', priority: 'Urgent' });
    assert.equal(badPriority.status, 422, 'priority sai phai 422');

    const created = await c.json('POST', '/api/tickets', { title: 'Default probe', requester: 'Probe' });
    assert.equal(created.status, 201);
    assert.equal(created.data.priority, 'Medium', 'default priority phai la Medium');
    assert.equal(created.data.category, 'General', 'default category phai la General');
    assert.equal(created.data.status, 'Open', 'ticket moi phai Open');
    assert.match(created.data.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'createdAt phai la "YYYY-MM-DD HH:mm"');
  } finally { await c.cleanup(); }
});

// ---------------------------------------------------------------- signature 3
// GET /api/tickets/:id — 200 for existing, 404 for missing
test('GET /api/tickets/:id tra 200 co ticket va 404 khi thieu', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'Get by id probe', requester: 'Probe' });
    const one = await c.json('GET', `/api/tickets/${created.data.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.data.id, created.data.id);
    assert.equal((await c.json('GET', '/api/tickets/999999')).status, 404, 'id khong ton tai phai 404');
  } finally { await c.cleanup(); }
});

// ---------------------------------------------------------------- signature 4
// PATCH /api/tickets/:id/status — THE legacy compatibility contract.
// Review Important 1: Open -> In Progress and Closed -> In Progress must work.
test('PATCH status: Open -> In Progress qua HTTP, state/status/resolvedAt coherent', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'Open to InProgress', requester: 'Probe' });
    assert.equal(created.data.status, 'Open', 'tien doan: ticket moi bat dau Open');
    const id = created.data.id;

    const r = await c.json('PATCH', `/api/tickets/${id}/status`, { status: 'In Progress' });
    assert.equal(r.status, 200, 'Open -> In Progress phai 200 (UI nut "Dong Ticket"/workflow yeu cau)');
    assert.equal(r.data.status, 'In Progress', 'compatibility status phai la "In Progress"');
    assert.equal(r.data.state, 'IN_PROGRESS', 'canonical state phai la IN_PROGRESS');
    assert.ok(!r.data.resolvedAt, 'chua resolve thi khong duoc co resolvedAt');

    const refetched = await c.json('GET', `/api/tickets/${id}`);
    assert.equal(refetched.data.state, 'IN_PROGRESS', 'state phai duoc persist');
    assert.equal(refetched.data.status, 'In Progress');
  } finally { await c.cleanup(); }
});

test('PATCH status: Closed -> In Progress (Mo lai ticket Closed) qua HTTP', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'Reopen closed', requester: 'Probe' });
    const id = created.data.id;

    // Reach CLOSED through the documented lifecycle: NEW -> IN_PROGRESS -> RESOLVED -> CLOSED.
    // (The ITSM state machine rejects NEW -> RESOLVED, so the intermediate step is required.)
    const inProgress = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'IN_PROGRESS' });
    assert.equal(inProgress.status, 200, 'tien doan: NEW -> IN_PROGRESS qua /transition duoc');
    const resolved = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'RESOLVED', resolutionCode: 'FIX', resolutionSummary: 'done' });
    assert.equal(resolved.status, 200, 'tien doan: IN_PROGRESS -> RESOLVED duoc');
    const closed2 = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'CLOSED', resolutionCode: 'FIX', resolutionSummary: 'closed out' });
    assert.equal(closed2.status, 200, 'tien doan: RESOLVED -> CLOSED duoc');
    assert.equal(closed2.data.state, 'CLOSED', 'tien doan: ticket dang o CLOSED truoc khi mo lai');

    // UI "Mo lai" sends `In Progress` for a Closed ticket.
    const reopen = await c.json('PATCH', `/api/tickets/${id}/status`, { status: 'In Progress' });
    assert.equal(reopen.status, 200, 'Closed -> In Progress phai 200 (UI "Mo lai" gui In Progress cho ca Closed)');
    assert.equal(reopen.data.state, 'IN_PROGRESS');
    assert.equal(reopen.data.status, 'In Progress');
    assert.ok(!reopen.data.resolvedAt, 'mo lai ticket da resolve thi phai xoa resolvedAt');
  } finally { await c.cleanup(); }
});

test('PATCH status: Resolved -> In Progress giu timeline va audit coherent', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'Timeline probe', requester: 'Probe' });
    const id = created.data.id;
    const resolved = await c.json('PATCH', `/api/tickets/${id}/status`, { status: 'Resolved' });
    assert.equal(resolved.status, 200);
    assert.ok(resolved.data.resolvedAt, 'Resolved phai gan resolvedAt');

    const reopened = await c.json('PATCH', `/api/tickets/${id}/status`, { status: 'In Progress' });
    assert.equal(reopened.status, 200);
    assert.ok(!reopened.data.resolvedAt, 'mo lai phai xoa resolvedAt');

    const timeline = await c.json('GET', `/api/tickets/${id}/timeline`);
    assert.equal(timeline.status, 200);
    const compatEvents = timeline.data.filter((e) => e.details && e.details.compatibility === true);
    assert.ok(compatEvents.length >= 1, 'phai co it nhat 1 timeline event cho compatibility status change');
  } finally { await c.cleanup(); }
});

test('PATCH status: 404 ticket thieu, 422 trang thai khong hop le', async () => {
  const c = await open();
  try {
    assert.equal((await c.json('PATCH', '/api/tickets/424242/status', { status: 'Resolved' })).status, 404);
    const created = await c.json('POST', '/api/tickets', { title: 'Bad status probe', requester: 'Probe' });
    const bad = await c.json('PATCH', `/api/tickets/${created.data.id}/status`, { status: 'Done' });
    assert.equal(bad.status, 422, 'trang thai la "Done" khong ton tai phai 422');
  } finally { await c.cleanup(); }
});

// ---------------------------------------------------------------- signature 5
// GET /api/assets — legacy filter + enterprise lifecycle aliases
test('GET /api/assets giu legacy filter va tra array', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/assets', VALID_ASSET);
    assert.equal(created.status, 201);

    const all = await c.json('GET', '/api/assets');
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.data), 'GET /api/assets phai tra array');

    const byTag = await c.json('GET', '/api/assets?q=BM-MATRIX-1');
    assert.equal(byTag.status, 200);
    assert.ok(byTag.data.some((a) => a.assetTag === 'BM-MATRIX-1'), '?q phai tim thay asset vua tao');
  } finally { await c.cleanup(); }
});

// ---------------------------------------------------------------- signature 6
// POST /api/assets — legacy 400 missing fields; 409 duplicate tag/serial
test('POST /api/assets giu 400 thieu truong va 409 trung tag/serial', async () => {
  const c = await open();
  try {
    const missing = await c.json('POST', '/api/assets', { type: 'LAPTOP' });
    assert.equal(missing.status, 400, 'thieu assetTag/serialNumber phai 400');

    const first = await c.json('POST', '/api/assets', VALID_ASSET);
    assert.equal(first.status, 201);

    const dupTag = await c.json('POST', '/api/assets', VALID_ASSET);
    assert.equal(dupTag.status, 409, 'trung assetTag phai 409');

    // Different tag, SAME serial as VALID_ASSET -> must still be 409.
    const dupSerial = await c.json('POST', '/api/assets', { assetTag: 'BM-OTHER', type: 'LAPTOP', manufacturer: 'HP', model: 'X2', serial: 'SN-MATRIX-1' });
    assert.equal(dupSerial.status, 409, 'trung serialNumber (khac assetTag) phai 409');

    const badType = await c.json('POST', '/api/assets', { ...VALID_ASSET, assetTag: 'BM-BADTYPE', serialNumber: 'SN-BAD', assetType: 'TOASTER' });
    assert.equal(badType.status, 422, 'assetType sai phai 422');
  } finally { await c.cleanup(); }
});

// ---------------------------------------------------------------- signature 7
// PATCH /api/assets/:id — Review Important 2: empty PATCH must be 400 with no
// audit event and no mutation.
test('PATCH /api/assets/:id giu 404, 409, 422 va 400 khi payload rong', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/assets', VALID_ASSET);
    const id = created.data.id;

    assert.equal((await c.json('PATCH', '/api/assets/424242', { status: 'Maintenance' })).status, 404);

    const ok = await c.json('PATCH', `/api/assets/${id}`, { status: 'Maintenance' });
    assert.equal(ok.status, 200, 'patch hop le phai 200');
    assert.equal(ok.data.status, 'Maintenance');

    const other = await c.json('POST', '/api/assets', { assetTag: 'BM-MATRIX-OTHER', type: 'LAPTOP', manufacturer: 'HP', model: 'X9', serial: 'SN-MATRIX-9' });
    assert.equal(other.status, 201, 'tien doan: tao asset thu hai de lam moc trung tag');
    const dup = await c.json('PATCH', `/api/assets/${id}`, { assetTag: 'BM-MATRIX-OTHER' });
    assert.equal(dup.status, 409, 'patch trung assetTag voi asset khac phai 409');

    const badStatus = await c.json('PATCH', `/api/assets/${id}`, { status: 'NOT_A_STATUS' });
    assert.equal(badStatus.status, 422, 'status sai phai 422');

  } finally { await c.cleanup(); }
});

// Review Important 2, isolated: an empty PATCH is a distinct defect from the
// 404/409/422 cases above, so it gets its own test and its own production change.
test('PATCH /api/assets/:id payload rong tra 400, khong audit va khong mutate', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/assets', VALID_ASSET);
    const id = created.data.id;

    const before = await c.json('GET', `/api/assets/${id}`);
    const auditBefore = await c.json('GET', '/api/audit?limit=500');

    const empty = await c.json('PATCH', `/api/assets/${id}`, {});
    assert.equal(empty.status, 400, 'patch rong phai 400 (OpenAPI PATCH contract khai bao 400)');

    const after = await c.json('GET', `/api/assets/${id}`);
    const auditAfter = await c.json('GET', '/api/audit?limit=500');
    assert.equal(after.data.updatedAt, before.data.updatedAt, 'patch rong khong duoc doi updatedAt');
    assert.equal(after.data.status, before.data.status, 'patch rong khong duoc doi status');
    assert.equal(auditAfter.data.count, auditBefore.data.count, 'patch rong khong duoc ghi audit event');
  } finally { await c.cleanup(); }
});

// ---------------------------------------------------------------- review r2 #1
// Reopening to `Open` is documented in openapi.yaml:397-400 ("Khi mở lại về
// `Open`/`In Progress`, `resolvedAt` bị xoá") and TicketStatus includes `Open`,
// so the removed legacy handler accepted it. Round 1 added the In Progress
// reopen but not the Open target, leaving the documented request a 422.
async function closeTicket(c, title) {
  const created = await c.json('POST', '/api/tickets', { title, requester: 'Probe' });
  const id = created.data.id;
  const ip = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'IN_PROGRESS' });
  assert.equal(ip.status, 200, 'tien doan: NEW -> IN_PROGRESS');
  const res = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'RESOLVED', resolutionCode: 'FIX', resolutionSummary: 'done' });
  assert.equal(res.status, 200, 'tien doan: IN_PROGRESS -> RESOLVED');
  return id;
}

test('PATCH status: Resolved -> Open xoa resolvedAt, giu state NEW/status Open', async () => {
  const c = await open();
  try {
    const id = await closeTicket(c, 'Resolved to Open');
    const before = await c.json('GET', `/api/tickets/${id}`);
    assert.equal(before.data.state, 'RESOLVED');
    assert.ok(before.data.resolvedAt, 'tien doan: ticket da RESOLVED thi co resolvedAt');

    const reopened = await c.json('PATCH', `/api/tickets/${id}/status`, { status: 'Open' });
    assert.equal(reopened.status, 200, 'Resolved -> Open phai 200 (openapi mo ta "mo lai ve Open ... resolvedAt bi xoa")');
    assert.equal(reopened.data.state, 'NEW', 'canonical state phai la NEW');
    assert.equal(reopened.data.status, 'Open', 'compatibility status phai la "Open"');
    assert.ok(!reopened.data.resolvedAt, 'resolvedAt phai bi xoa');
    assert.ok(!reopened.data.resolvedAtIso, 'resolvedAtIso phai bi xoa');
    assert.ok(!reopened.data.closedAt, 'closedAt phai bi xoa');

    // Persisted, not just echoed.
    const refetched = await c.json('GET', `/api/tickets/${id}`);
    assert.equal(refetched.data.state, 'NEW', 'state NEW phai duoc persist');
    assert.equal(refetched.data.status, 'Open');
    assert.ok(!refetched.data.resolvedAt, 'resolvedAt phai xoa trong db');
  } finally { await c.cleanup(); }
});

test('PATCH status: Closed -> Open xoa resolution + closedAt', async () => {
  const c = await open();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'Closed to Open', requester: 'Probe' });
    const id = created.data.id;
    const ip = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'IN_PROGRESS' });
    assert.equal(ip.status, 200);
    const res = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'RESOLVED', resolutionCode: 'FIX', resolutionSummary: 'done' });
    assert.equal(res.status, 200);
    const closed = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'CLOSED', resolutionCode: 'FIX', resolutionSummary: 'closed' });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.state, 'CLOSED');
    assert.ok(closed.data.closedAt, 'tien doan: ticket CLOSED co closedAt');

    const reopened = await c.json('PATCH', `/api/tickets/${id}/status`, { status: 'Open' });
    assert.equal(reopened.status, 200, 'Closed -> Open phai 200');
    assert.equal(reopened.data.state, 'NEW');
    assert.equal(reopened.data.status, 'Open');
    assert.ok(!reopened.data.resolvedAt, 'resolvedAt phai xoa');
    assert.ok(!reopened.data.closedAt, 'closedAt phai xoa');
    assert.equal(reopened.data.resolutionCode, null, 'resolutionCode phai null');
    assert.equal(reopened.data.resolutionSummary, null, 'resolutionSummary phai null');
  } finally { await c.cleanup(); }
});

test('PATCH status: reopen to Open ghi timeline from/to/note va audit actor', async () => {
  const c = await open({ authMode: 'lab', authUsers: { admin: { password: 'pw-admin', role: 'IT_ADMIN' } } });
  try {
    // Auth first: in lab mode every /api call needs a Bearer token.
    const login = await c.json('POST', '/api/auth/login', { username: 'admin', password: 'pw-admin' });
    assert.equal(login.status, 200);
    const headers = { Authorization: `Bearer ${login.data.token}` };

    const created = await c.json('POST', '/api/tickets', { title: 'Timeline Open probe', requester: 'Probe' }, headers);
    assert.equal(created.status, 201);
    const id = created.data.id;
    const ip = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'IN_PROGRESS' }, headers);
    assert.equal(ip.status, 200, 'tien doan: NEW -> IN_PROGRESS');
    const res = await c.json('POST', `/api/tickets/${id}/transition`, { status: 'RESOLVED', resolutionCode: 'FIX', resolutionSummary: 'done' }, headers);
    assert.equal(res.status, 200, 'tien doan: IN_PROGRESS -> RESOLVED');

    const reopened = await c.json('PATCH', `/api/tickets/${id}/status`, { status: 'Open', note: 'Khách hàng yêu cầu mở lại' }, headers);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.lastStatusNote, 'Khách hàng yêu cầu mở lại', 'note phai duoc persist tren ticket');

    const timeline = await c.json('GET', `/api/tickets/${id}/timeline`, undefined, headers);
    assert.equal(timeline.status, 200);
    const ev = [...timeline.data].reverse().find((e) => e.type === 'STATUS_CHANGED' && e.details && e.details.to === 'NEW');
    assert.ok(ev, 'phai co timeline event STATUS_CHANGED -> NEW');
    assert.equal(ev.details.from, 'RESOLVED', 'timeline phai ghi from state truoc do');
    assert.equal(ev.details.to, 'NEW');
    assert.equal(ev.details.compatibility, true, 'event phai danh dau compatibility');
    assert.equal(ev.details.note, 'Khách hàng yêu cầu mở lại', 'note phai vao timeline details');
    assert.equal(ev.actor, 'admin', 'timeline phai ghi actor');

    const audit = await c.json('GET', '/api/audit?limit=500', undefined, headers);
    assert.equal(audit.status, 200);
    const row = audit.data.items.find((a) => a.action === 'TICKET_STATUS_COMPATIBILITY' && Number(a.entityId) === Number(id) && a.details && a.details.target === 'NEW');
    assert.ok(row, 'phai co audit TICKET_STATUS_COMPATIBILITY target NEW');
    assert.equal(row.actor, 'admin', 'audit phai ghi actor');
    assert.equal(row.details.from, 'RESOLVED', 'audit phai ghi from');
    assert.equal(row.details.note, 'Khách hàng yêu cầu mở lại', 'note phai vao audit details');
  } finally { await c.cleanup(); }
});
