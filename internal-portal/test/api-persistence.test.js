'use strict';

/** Persistence qua restart: boot lại app trên cùng dataDir, dữ liệu phải còn. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createTestClient } = require('./helpers');

let c;
before(async () => {
  c = await createTestClient();
  await c.start();
});
after(() => c.cleanup());

test('Restart server trên cùng dataDir → Assets & Tickets mới vẫn còn', async () => {
  const stamp = `LP-QA-PERSIST-${Date.now()}`;
  const created = await c.json('POST', '/api/assets', { tag: stamp, brand: 'Dell', model: 'Latitude', serial: `P-${Date.now()}` });
  assert.equal(created.status, 201);
  const ticket = await c.json('POST', '/api/tickets', { title: 'Ticket cần sống sau restart', requester: 'QA', dept: 'IT', priority: 'Medium' });
  assert.equal(ticket.status, 201);

  const raw = await fs.readFile(c.dbFile, 'utf8');
  assert.ok(raw.includes(stamp), 'db.json phải chứa bản ghi vừa tạo');

  await c.stop();
  await c.start(); // boot lại từ cùng dataDir — giả lập restart tiến trình/container

  const assets = await c.json('GET', '/api/assets');
  assert.ok(assets.data.some((a) => a.tag === stamp), 'Asset phải còn sau restart');
  const tickets = await c.json('GET', '/api/tickets');
  assert.ok(tickets.data.some((t) => t.id === ticket.data.id), 'Ticket phải còn sau restart');
  const stats = await c.json('GET', '/api/dashboard/stats');
  assert.ok(stats.data.totalAssets >= 7);
});

test('id không bị cấp lại sau restart (đọc max id từ db.json)', async () => {
  const before = await c.json('GET', '/api/assets');
  const maxId = Math.max(...before.data.map((a) => a.id));

  await c.stop();
  await c.start();

  const created = await c.json('POST', '/api/assets', { tag: `LP-QA-REUSE-${maxId}`, brand: 'HP', model: 'ProDesk', serial: `R-${Date.now()}` });
  assert.equal(created.status, 201);
  assert.ok(created.data.id > maxId, `id mới (${created.data.id}) phải lớn hơn ${maxId}`);
});

test('Trạng thái ticket đã đổi vẫn nguyên sau restart', async () => {
  const patched = await c.json('PATCH', '/api/tickets/1006/status', { status: 'Resolved' });
  assert.equal(patched.status, 200);

  await c.stop();
  await c.start();

  const fetched = await c.json('GET', '/api/tickets/1006');
  assert.equal(fetched.data.status, 'Resolved');
});

test('Ghi file là atomic: không còn file .tmp sót lại sau commit', async () => {
  await c.json('POST', '/api/assets', { tag: 'LP-QA-ATOMIC', brand: 'Lenovo', model: 'T14', serial: `AT-${Date.now()}` });
  await c.context.store.flush();
  const entries = await fs.readdir(c.dataDir);
  assert.deepEqual(entries.filter((f) => f.includes('.tmp-')), [], 'không được để lại file tạm');
  assert.ok(entries.includes('db.json'));
});
