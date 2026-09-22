'use strict';

/** REST API — Health, Dashboard, Assets CRUD, CSV export, error handling. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

let c;
test.before(async () => {
  c = await createTestClient();
  await c.start();
});
test.after(() => c.cleanup());

test('GET /api/health → 200, storage type + counts', async () => {
  const { status, data } = await c.json('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(data.status, 'ok');
  assert.equal(data.storage, 'json-file');
  assert.ok(data.counts.assets >= 6);
  assert.equal(typeof data.uptime, 'number');
});

test('GET /api/dashboard/stats → KPI khớp dữ liệu thực tế', async () => {
  const { status, data } = await c.json('GET', '/api/dashboard/stats');
  assert.equal(status, 200);
  const { data: assets } = await c.json('GET', '/api/assets');
  const { data: tickets } = await c.json('GET', '/api/tickets');
  assert.equal(data.totalAssets, assets.length);
  assert.equal(data.activeAssets, assets.filter((a) => a.status === 'Active').length);
  assert.equal(data.openTickets, tickets.filter((t) => t.status === 'Open' || t.status === 'In Progress').length);
  assert.equal(data.resolvedTickets, tickets.filter((t) => t.status === 'Resolved').length);
  assert.ok(Number.isFinite(data.slaPercent), 'phải có slaPercent cho dashboard');
  assert.ok(data.assetsByType && typeof data.assetsByType === 'object');
});

test('GET /api/assets → mảng tài sản mẫu', async () => {
  const { status, data } = await c.json('GET', '/api/assets');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data));
  assert.ok(data.some((a) => a.tag === 'LP-IT-001'));
});

test('GET /api/assets?q / ?status / ?type → filter server-side', async () => {
  const byStatus = await c.json('GET', '/api/assets?status=In%20Storage');
  assert.ok(byStatus.data.length >= 1);
  assert.ok(byStatus.data.every((a) => a.status === 'In Storage'));

  const byQuery = await c.json('GET', '/api/assets?q=ThinkPad');
  assert.ok(byQuery.data.length >= 1);
  assert.ok(byQuery.data.every((a) => JSON.stringify(a).toLowerCase().includes('thinkpad')));

  const byType = await c.json('GET', '/api/assets?type=Printer');
  assert.ok(byType.data.every((a) => a.type === 'Printer'));
});

test('POST /api/assets → 201, id tự sinh, status mặc định Active', async () => {
  const payload = {
    tag: 'LP-QA-777',
    brand: 'Lenovo',
    model: 'ThinkPad P14s',
    serial: 'QA-SER-777',
    type: 'Laptop',
    assignedTo: 'QA Bot',
    dept: 'IT Support',
    ip: '192.168.10.222',
  };
  const created = await c.json('POST', '/api/assets', payload);
  assert.equal(created.status, 201);
  assert.ok(created.data.id > 0);
  assert.equal(created.data.tag, 'LP-QA-777');
  assert.equal(created.data.status, 'Active');

  const conflict = await c.json('POST', '/api/assets', payload);
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /tag|serial/i);
});

test('POST /api/assets thiếu trường → 400; status sai → 422', async () => {
  const bad = await c.json('POST', '/api/assets', { tag: 'X' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error);
  assert.ok(Array.isArray(bad.data.details), '400 phải liệt kê trường thiếu');

  const badStatus = await c.json('POST', '/api/assets', { tag: 'X1', brand: 'Dell', model: 'M', serial: 'S1', status: 'Broken' });
  assert.equal(badStatus.status, 422);
});

test('GET /api/assets/:id → 200 / 404', async () => {
  const ok = await c.json('GET', '/api/assets/1');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.id, 1);
  assert.equal((await c.json('GET', '/api/assets/424242')).status, 404);
});

test('PATCH /api/assets/:id → 200; 404; 409 trùng tag; 422 status sai', async () => {
  const updated = await c.json('PATCH', '/api/assets/6', { status: 'Active', assignedTo: 'QA Bot', ip: '192.168.10.50' });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.status, 'Active');
  assert.equal(updated.data.assignedTo, 'QA Bot');

  assert.equal((await c.json('PATCH', '/api/assets/424242', { status: 'Retired' })).status, 404);
  assert.equal((await c.json('PATCH', '/api/assets/6', { tag: 'LP-QA-777' })).status, 409);
  assert.equal((await c.json('PATCH', '/api/assets/6', { status: 'Nope' })).status, 422);
});

test('DELETE /api/assets/:id → 200, xoá lại → 404', async () => {
  const { data: created } = await c.json('POST', '/api/assets', { tag: 'LP-QA-DEL', brand: 'Dell', model: 'OptiPlex', serial: 'DEL-SER-1' });
  const del = await c.json('DELETE', `/api/assets/${created.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.success, true);
  assert.equal((await c.json('DELETE', `/api/assets/${created.id}`)).status, 404);
});
