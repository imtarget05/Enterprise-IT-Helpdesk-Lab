'use strict';

/**
 * H-01 regression: the /api auth boundary must protect EVERY protected route in
 * AUTH_MODE=lab, regardless of which module registered the handler.
 *
 * Assertions are decided by real HTTP behavior against a real Express app
 * (createTestClient boots createApp on an ephemeral port). A source-text scan is
 * read only to annotate failure messages with the registration order; it never
 * decides pass/fail.
 *
 * The break this test names: moving registerEnterpriseRoutes(...) above
 * app.use('/api', auth.middleware) (or dropping the global /api guard) would let
 * enterprise handlers answer anonymous requests with 200 instead of 401.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestClient } = require('./helpers');

const APP_SOURCE = path.join(__dirname, '..', 'src', 'app.js');

// Mandatory protected GET probes: anonymous must receive 401 for every one.
const PROTECTED_GET_PROBES = [
  '/api/assets',
  '/api/tickets',
  '/api/licenses',
  '/api/dashboard/stats',
  '/api/problems',
  '/api/changes',
  '/api/access-requests',
  '/api/monitoring/checks',
  '/api/monitoring/status',
  '/api/monitoring/history',
  '/api/notifications',
  '/api/audit',
  '/api/ai/status',
];

// A VIEWER holds only "read"; /api/audit additionally requires audit:read, so it
// is excluded from the "viewer may read -> 200" set and asserted as 403 below.
const VIEWER_READABLE = PROTECTED_GET_PROBES.filter((p) => p !== '/api/audit');

const labAuth = {
  authMode: 'lab',
  authUsers: {
    viewer: { password: 'qa-viewer-password', role: 'VIEWER' },
    admin: { password: 'qa-admin-password', role: 'IT_ADMIN' },
  },
  miniErpIntegrationKey: 'qa-integration-key',
  requestLogger: false,
};

async function open() { const c = await createTestClient(labAuth); await c.start(); return c; }
async function login(c, username, password) {
  const r = await c.json('POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, 'login ' + username + ' failed: ' + r.status);
  return { Authorization: 'Bearer ' + r.data.token };
}

// Diagnostic only (never decides pass/fail): annotate failures with where the
// auth middleware and the enterprise registration sit in the source.
function orderContext() {
  const src = fs.readFileSync(APP_SOURCE, 'utf8');
  const lineOf = (needle) => {
    const i = src.indexOf(needle);
    return i === -1 ? null : src.slice(0, i).split('\n').length;
  };
  return 'auth.middleware@L' + lineOf("app.use('/api', auth.middleware)") +
    ' registerEnterpriseRoutes@L' + lineOf('registerEnterpriseRoutes({');
}

test('anonymous request toi protected GET tra 401 (khong handler nao chay truoc auth)', async () => {
  const c = await open();
  try {
    const observed = [];
    for (const p of PROTECTED_GET_PROBES) {
      const res = await c.json('GET', p);
      observed.push({ method: 'GET', path: p, status: res.status });
    }
    const unexpected = observed.filter((o) => o.status !== 401);
    const detail = observed.map((o) => o.method + ' ' + o.path + ' ' + o.status).join('\n');
    assert.equal(unexpected.length, 0, 'route tra khac 401 khi anonymous:\n' + detail + '\n(' + orderContext() + ')');
  } finally { await c.cleanup(); }
});

test('public probes: health 200, bad login 401, MiniERP incident thieu key 401', async () => {
  const c = await open();
  try {
    assert.equal((await c.json('GET', '/api/health')).status, 200, 'GET /api/health phai cong khai 200');
    const badLogin = await c.json('POST', '/api/auth/login', { username: 'viewer', password: 'wrong-password' });
    assert.equal(badLogin.status, 401, 'login sai credential phai 401');
    const incident = await c.json('POST', '/api/integrations/minierp/incidents', {
      source: 'MiniERP', externalRef: 'H-01-NOKEY', title: 'no key', description: 'x', severity: 'HIGH',
    });
    assert.equal(incident.status, 401, 'MiniERP incident khong co key phai 401');
  } finally { await c.cleanup(); }
});

test('VIEWER doc read endpoint duoc phep (200) nhung bi chan /api/audit (403)', async () => {
  const c = await open();
  try {
    const viewer = await login(c, 'viewer', 'qa-viewer-password');
    for (const p of VIEWER_READABLE) {
      const res = await c.json('GET', p, undefined, viewer);
      assert.equal(res.status, 200, 'VIEWER GET ' + p + ' phai 200, nhan ' + res.status + ' (' + orderContext() + ')');
    }
    const audit = await c.json('GET', '/api/audit', undefined, viewer);
    assert.equal(audit.status, 403, 'VIEWER GET /api/audit can audit:read, phai 403, nhan ' + audit.status);
  } finally { await c.cleanup(); }
});

test('VIEWER mutation bi 403; admin mutation khong con 401/403', async () => {
  const c = await open();
  try {
    const viewer = await login(c, 'viewer', 'qa-viewer-password');
    const viewerMutations = [
      ['POST', '/api/assets', { assetTag: 'H01-V', type: 'LAPTOP', serial: 'S-V', employee: 'E-V', status: 'Active' }],
      ['POST', '/api/tickets', { title: 'viewer create', description: 'x', priority: 'Medium', category: 'General' }],
    ];
    for (const pair of viewerMutations) {
      const res = await c.json(pair[0], pair[1], pair[2], viewer);
      assert.equal(res.status, 403, 'VIEWER ' + pair[0] + ' ' + pair[1] + ' phai 403, nhan ' + res.status + ' (' + orderContext() + ')');
    }
    const statusPatch = await c.json('PATCH', '/api/tickets/1001/status', { status: 'In Progress', note: 'viewer' }, viewer);
    assert.equal(statusPatch.status, 403, 'VIEWER PATCH /api/tickets/:id/status phai 403, nhan ' + statusPatch.status);

    const admin = await login(c, 'admin', 'qa-admin-password');
    const adminMutations = [
      ['POST', '/api/assets', { assetTag: 'H01-A', type: 'LAPTOP', serial: 'S-A', employee: 'E-A', status: 'Active' }],
      ['POST', '/api/tickets', { title: 'admin create', description: 'x', priority: 'Medium', category: 'General' }],
    ];
    for (const pair of adminMutations) {
      const res = await c.json(pair[0], pair[1], pair[2], admin);
      assert.ok(![401, 403].includes(res.status), 'admin ' + pair[0] + ' ' + pair[1] + ' khong duoc 401/403, nhan ' + res.status + ' (' + orderContext() + ')');
    }
    const adminStatus = await c.json('PATCH', '/api/tickets/1001/status', { status: 'In Progress', note: 'admin' }, admin);
    assert.ok(![401, 403].includes(adminStatus.status), 'admin PATCH /api/tickets/:id/status khong duoc 401/403, nhan ' + adminStatus.status);
  } finally { await c.cleanup(); }
});
