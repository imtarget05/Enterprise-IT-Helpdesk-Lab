'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTestClient } = require('./helpers');
const { createStore } = require('../src/store');
const { derivePriorityCode, slaFor } = require('../src/itsm');
const { backupPortalData, restorePortalData, validatePortalData } = require('../src/backup');

async function open(options = {}) { const c = await createTestClient(options); await c.start(); return c; }
async function login(c, username, password) { const r = await c.json('POST', '/api/auth/login', { username, password }); assert.equal(r.status, 200); return { Authorization: `Bearer ${r.data.token}` }; }
const labAuth = { authMode: 'lab', authUsers: { admin: { password: 'admin-pass', role: 'IT_ADMIN' }, l1: { password: 'l1-pass', role: 'HELPDESK_L1' }, auditor: { password: 'audit-pass', role: 'AUDITOR' } }, requestLogger: false };

test('priority/SLA helpers and legacy migration are deterministic', async () => {
  assert.equal(derivePriorityCode('HIGH', 'HIGH'), 'P1');
  assert.equal(derivePriorityCode('HIGH', 'MEDIUM'), 'P2');
  assert.equal(slaFor('P1').ackMinutes, 15);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-migration-'));
  await fs.writeFile(path.join(dir, 'db.json'), JSON.stringify({ version: 1, assets: [{ id: 1, tag: 'OLD-1', type: 'Laptop', brand: 'Dell', model: 'M', serial: 'S', status: 'Active' }], tickets: [{ id: 1001, title: 'Old', requester: 'U', priority: 'High', status: 'Open' }], licenses: [] }));
  const store = createStore({ dataDir: dir }); await store.load();
  assert.equal(store.schemaVersion, 2); assert.equal(store.data.assets[0].assetTag, 'OLD-1'); assert.equal(store.data.tickets[0].priorityCode, 'P2');
  assert.ok((await fs.readdir(dir)).some((x) => x.includes('migration')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('backup validates and restores to a separate target', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-backup-'));
  await fs.writeFile(path.join(dir, 'db.json'), JSON.stringify({ version: 1, schemaVersion: 2, assets: [], tickets: [], licenses: [], auditEvents: [] }));
  const backup = await backupPortalData({ dataDir: dir, retention: 3 });
  assert.equal((await validatePortalData(backup.file)).valid, true);
  assert.equal((await restorePortalData({ backupFile: backup.file, targetFile: path.join(dir, 'restored.json') })).valid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('lab RBAC denies anonymous/L1 admin mutations and allows auditor reads', async () => {
  const c = await open(labAuth);
  try {
    assert.equal((await c.json('POST', '/api/assets', { assetTag: 'A1', assetType: 'LAPTOP', manufacturer: 'D', model: 'M', serialNumber: 'S' })).status, 401);
    assert.equal((await c.json('GET', '/api/tickets')).status, 401);
    const l1 = await login(c, 'l1', 'l1-pass');
    assert.equal((await c.json('POST', '/api/changes', { title: 'FW', reason: 'x', risk: 'HIGH', rollbackPlan: 'snapshot' }, l1)).status, 403);
    const auditor = await login(c, 'auditor', 'audit-pass');
    assert.equal((await c.json('GET', '/api/tickets', undefined, auditor)).status, 200);
    assert.equal((await c.json('POST', '/api/assets', { assetTag: 'A2', assetType: 'LAPTOP', manufacturer: 'D', model: 'M', serialNumber: 'S2' }, auditor)).status, 403);
    assert.equal((await c.json('POST', '/api/auth/logout', undefined, auditor)).status, 200);
    assert.equal((await c.json('GET', '/api/auth/me', undefined, auditor)).status, 401);
  } finally { await c.cleanup(); }
});

test('ticket timeline/SLA, monitoring dedupe, and MiniERP idempotency work', async () => {
  const c = await open({ requestLogger: false, monitoring: { runCheck: async (check, hint) => ({ status: hint || 'DOWN', message: 'sim' }) }, miniErpIntegrationKey: 'erp-key' });
  try {
    const t = await c.json('POST', '/api/tickets', { title: 'ERP down', requester: 'Line', impact: 'HIGH', urgency: 'HIGH' });
    assert.equal(t.data.priorityCode, 'P1'); assert.ok(t.data.slaTargetAt);
    assert.equal((await c.json('POST', `/api/tickets/${t.data.id}/assign`, { assignee: 'l2' })).status, 200);
    assert.equal((await c.json('POST', `/api/tickets/${t.data.id}/work-notes`, { body: 'checked' })).status, 201);
    assert.ok((await c.json('GET', `/api/tickets/${t.data.id}/timeline`)).data.length >= 3);
    assert.equal((await c.json('POST', `/api/tickets/${t.data.id}/transition`, { status: 'IN_PROGRESS' })).status, 200);
    assert.equal((await c.json('POST', `/api/tickets/${t.data.id}/transition`, { status: 'RESOLVED', resolutionCode: 'FIX', resolutionSummary: 'done' })).status, 200);
    const check = await c.json('POST', '/api/monitoring/checks', { name: 'ERP monitor', type: 'HTTP', target: 'http://127.0.0.1:9', failureThreshold: 3 });
    for (let i = 0; i < 4; i++) await c.json('POST', `/api/monitoring/checks/${check.data.id}/run`);
    assert.equal((await c.json('GET', '/api/tickets?source=MONITORING')).data.length, 1);
    assert.ok((await c.json('GET', `/api/monitoring/history?checkId=${check.data.id}`)).data.items.length >= 4);
    await c.json('POST', `/api/monitoring/checks/${check.data.id}/run`, { status: 'UP' });
    const p = { source: 'MiniERP', externalRef: 'E-1', title: 'ERP failed', severity: 'HIGH', description: '<b>x</b>' }; const h = { Authorization: 'Bearer erp-key' };
    const first = await c.json('POST', '/api/integrations/minierp/incidents', p, h); const retry = await c.json('POST', '/api/integrations/minierp/incidents', p, h);
    const differentSource = await c.json('POST', '/api/integrations/minierp/incidents', { ...p, source: 'OTHER' }, h);
    const conflict = await c.json('POST', '/api/integrations/minierp/incidents', { ...p, title: 'ERP failed v2' }, h);
    assert.equal(first.status, 201); assert.equal(first.data.integrationSource, 'MINIERP'); assert.equal(retry.status, 200); assert.equal(retry.data.id, first.data.id); assert.equal(differentSource.status, 422); assert.equal(conflict.status, 409); assert.ok(!String(first.data.description).includes('<b>')); assert.equal((await c.json('POST', '/api/integrations/minierp/incidents', p)).status, 401);
  } finally { await c.cleanup(); }
});

test('problem/change and access handoff/offboarding workflows are idempotent', async () => {
  const c = await open();
  try {
    const problem = await c.json('POST', '/api/problems', { title: 'ERP intermittent', service: 'MiniERP' });
    const dashboard = await c.json('GET', '/api/dashboard/stats');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.data.openProblems, 1);
    const t1 = await c.json('POST', '/api/tickets', { title: 'A', requester: 'A' }); const t2 = await c.json('POST', '/api/tickets', { title: 'B', requester: 'B' });
    await c.json('POST', `/api/problems/${problem.data.id}/link-ticket`, { ticketId: t1.data.id }); await c.json('POST', `/api/problems/${problem.data.id}/link-ticket`, { ticketId: t2.data.id });
    assert.equal((await c.json('GET', `/api/problems/${problem.data.id}`)).data.linkedTicketIds.length, 2);
    assert.equal((await c.json('POST', '/api/changes', { title: 'FW', reason: 'x', risk: 'HIGH' })).status, 422); assert.equal((await c.json('POST', '/api/changes', { title: 'FW', reason: 'x', risk: 'HIGH', rollbackPlan: 'snapshot' })).status, 201);
    const access = await c.json('POST', '/api/access-requests', { requestType: 'ONBOARDING', employeeId: 'E', name: 'N' }); assert.equal((await c.json('POST', `/api/access-requests/${access.data.id}/approve`)).status, 200); assert.equal((await c.json('GET', `/api/access-requests/${access.data.id}/handoff`)).data.operation, 'NEW_COMPANY_USER');
    const off = await c.json('POST', '/api/access-requests', { requestType: 'OFFBOARDING', employeeId: 'E', name: 'N' }); assert.equal((await c.json('POST', `/api/access-requests/${off.data.id}/offboard`)).status, 200); assert.equal((await c.json('POST', `/api/access-requests/${off.data.id}/offboard`)).data.idempotent, true);
  } finally { await c.cleanup(); }
});
