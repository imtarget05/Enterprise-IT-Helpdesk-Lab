'use strict';

/** REST API — Tickets + Webhook alert (integration test qua HTTP thật). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

let c;
test.before(async () => {
  c = await createTestClient();
  await c.start();
});
test.after(() => c.cleanup());

test('GET /api/tickets + filter q / status / priority', async () => {
  const all = await c.json('GET', '/api/tickets');
  assert.equal(all.status, 200);
  assert.ok(all.data.some((t) => t.id === 1001));

  const open = await c.json('GET', '/api/tickets?status=Open');
  assert.ok(open.data.length >= 1);
  assert.ok(open.data.every((t) => t.status === 'Open'));

  const high = await c.json('GET', '/api/tickets?priority=High');
  assert.ok(high.data.every((t) => t.priority === 'High'));

  const q = await c.json('GET', '/api/tickets?q=DNS');
  assert.ok(q.data.length >= 1);
  assert.ok(q.data.every((t) => JSON.stringify(t).toLowerCase().includes('dns')));
});

test('GET /api/tickets/:id → 200 / 404', async () => {
  const ok = await c.json('GET', '/api/tickets/1001');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.id, 1001);
  assert.equal((await c.json('GET', '/api/tickets/999999')).status, 404);
});

test('POST /api/tickets → 201, id >= 1001, status Open, createdAt "YYYY-MM-DD HH:mm"', async () => {
  const created = await c.json('POST', '/api/tickets', {
    title: 'QA ticket for API test',
    requester: 'QA Bot',
    dept: 'IT Support',
    priority: 'Low',
    category: 'Software',
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.id >= 1001);
  assert.equal(created.data.status, 'Open');
  assert.match(created.data.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('POST /api/tickets mặc định priority=Medium, category=General khi thiếu', async () => {
  const created = await c.json('POST', '/api/tickets', { title: 'Chỉ có tiêu đề', requester: 'QA' });
  assert.equal(created.status, 201);
  assert.equal(created.data.priority, 'Medium');
  assert.equal(created.data.category, 'General');
  assert.equal(created.data.dept, 'General');
});

test('POST /api/tickets thiếu title/requester → 400; priority sai → 422', async () => {
  const noTitle = await c.json('POST', '/api/tickets', { requester: 'A' });
  assert.equal(noTitle.status, 400);
  const badPriority = await c.json('POST', '/api/tickets', { title: 'x', requester: 'A', dept: 'IT', priority: 'Urgent!' });
  assert.equal(badPriority.status, 422);
});

test('PATCH /api/tickets/:id/status → 200 + resolvedAt; 404; 422', async () => {
  const ok = await c.json('PATCH', '/api/tickets/1006/status', { status: 'Resolved' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'Resolved');
  assert.match(ok.data.resolvedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'phải đóng dấu thời gian xử lý xong cho SLA');

  assert.equal((await c.json('PATCH', '/api/tickets/424242/status', { status: 'Resolved' })).status, 404);
  assert.equal((await c.json('PATCH', '/api/tickets/1006/status', { status: 'Done' })).status, 422);
});

test('PATCH /api/tickets/:id/status = In Progress → 200, xoá resolvedAt', async () => {
  const ok = await c.json('PATCH', '/api/tickets/1006/status', { status: 'In Progress' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'In Progress');
  assert.equal(ok.data.resolvedAt, undefined);
});

test('POST /api/tickets mức High → phát sinh webhook alert (mock Telegram/Email)', async () => {
  const before = await c.json('GET', '/api/notifications');
  assert.equal(before.status, 200);
  assert.equal(before.data.count, 0);

  const created = await c.json('POST', '/api/tickets', {
    title: 'Firewall treo - toàn công ty mất mạng',
    requester: 'QA Bot',
    dept: 'IT Support',
    priority: 'High',
    category: 'Network',
  });
  assert.equal(created.status, 201);

  const after = await c.json('GET', '/api/notifications');
  assert.equal(after.data.count, 1, 'ticket High phải tạo đúng 1 bản ghi thông báo');
  const latest = after.data.items[0];
  assert.equal(latest.ticketId, created.data.id);
  assert.ok(latest.channels.length >= 1, 'phải chỉ ra kênh gửi (telegram/email)');
  assert.match(latest.message, /HIGH/);
  assert.match(latest.message, /Firewall/);
});

test('POST /api/tickets mức Critical → alert; mức Low → không alert', async () => {
  await c.json('POST', '/api/tickets', { title: 'Mouse hỏng', requester: 'QA', dept: 'Sales', priority: 'Low' });
  let list = await c.json('GET', '/api/notifications');
  assert.equal(list.data.count, 1, 'ticket Low không được cộng thêm alert');

  await c.json('POST', '/api/tickets', { title: 'Ransomware lây lan', requester: 'QA', dept: 'Security', priority: 'Critical' });
  list = await c.json('GET', '/api/notifications');
  assert.equal(list.data.count, 2);
  assert.match(list.data.items[0].message, /CRITICAL/);
});

test('GET /api/notifications?limit=1 → tôn trọng limit, giữ tổng count', async () => {
  const page = await c.json('GET', '/api/notifications?limit=1');
  assert.equal(page.status, 200);
  assert.equal(page.data.items.length, 1);
  assert.ok(page.data.count >= 2);
});
