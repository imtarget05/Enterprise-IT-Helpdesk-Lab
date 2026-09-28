'use strict';

/**
 * Review round 2 #2 — the notifier must be fail-soft for EVERY failure shape.
 *
 * `createTicket` called `notifier.alert(row).catch(...)`, which only protects
 * against a rejected Promise. A notifier that throws synchronously, or returns a
 * non-Promise value, slips past `.catch` entirely. Because the ticket, its
 * creation event, and its audit row are inserted before the alert call while
 * `save()` happens after, a synchronous throw produced a 500 response with an
 * uncommitted in-memory ghost visible to later requests in the same process.
 *
 * `slaBreach` was a second direct call site with the same hole, able to turn a
 * plain ticket read into a 500.
 *
 * Every fake here is a plain object injected through createApp options, so no
 * webhook or external host is ever contacted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

// A notifier whose alert() throws BEFORE returning anything. `async` would only
// produce a rejected Promise, so these fakes are deliberately non-async.
const throwingSync = () => ({ alerted: true, alert() { throw new Error('sync boom'); } });
const returningSync = () => ({ alerted: true, alert() { return { alerted: true, delivered: true }; } });
const returningBare = () => ({ alerted: true, alert() { return 'not-a-promise'; } });
const rejectingAsync = () => ({ alerted: true, async alert() { throw new Error('async boom'); } });
const returningNull = () => ({ alerted: true, alert() { return null; } });

function notifierFrom(make) {
  const n = make();
  n.webhookUrl = null;
  n.lastDelivery = null;
  n.history = () => ({ count: 0, items: [] });
  return n;
}

const FAKES = [
  ['alert() throw synchronous', throwingSync],
  ['alert() tra ve object dong bo', returningSync],
  ['alert() tra ve chuoi (khong phai Promise)', returningBare],
  ['alert() tra ve null', returningNull],
  ['alert() reject bat dong bo', rejectingAsync],
];

for (const [label, make] of FAKES) {
  test(`POST /api/tickets van 201 va commit du khong notifier ${label}`, async () => {
    const notifier = notifierFrom(make);
    const c = await createTestClient({ notifier, requestLogger: false });
    await c.start();
    try {
      const created = await c.json('POST', '/api/tickets', { title: `probe ${label}`, requester: 'P', priority: 'High' });
      assert.equal(created.status, 201, `notifier ${label} khong duoc lam ticket creation fail`);
      // A synchronous return is still a successful alert; only a genuine
      // failure shape must normalise to alerted:false.
      const expectAlerted = label.includes('tra ve object dong bo');
      assert.equal(created.data.alerted, expectAlerted, `alerted phai la ${expectAlerted} cho "${label}"`);

      // Committed and readable: no uncommitted ghost.
      const fetched = await c.json('GET', `/api/tickets/${created.data.id}`);
      assert.equal(fetched.status, 200, 'ticket phai doc lai duoc');
      assert.equal(fetched.data.title, `probe ${label}`);

      // The ticket must appear in the collection (i.e. it really was stored).
      const list = await c.json('GET', '/api/tickets?q=' + encodeURIComponent(`probe ${label}`));
      assert.equal(list.status, 200);
      assert.ok(list.data.some((t) => t.id === created.data.id), 'ticket phai xuat hien trong collection');
    } finally { await c.cleanup(); }
  });
}

test('notifier that bai khong lam monitoring incident gay partial state', async () => {
  const notifier = notifierFrom(throwingSync);
  const c = await createTestClient({ notifier, requestLogger: false });
  await c.start();
  try {
    const check = await c.json('POST', '/api/monitoring/checks', { name: 'sync boom check', type: 'DNS', target: 'example.invalid', failureThreshold: 1 });
    assert.equal(check.status, 201);
    const run = await c.json('POST', `/api/monitoring/checks/${check.data.id}/run`, {});
    assert.equal(run.status, 200, 'monitoring run phai tra duoc ket qua du notifier hong');

    // No partial state: a DOWN run that hit the threshold must not have left a
    // half-written ticket behind, and the check must still be consistent.
    const refetched = await c.json('GET', `/api/monitoring/checks/${check.data.id}`);
    assert.equal(refetched.status, 200);
    assert.ok(['DOWN', 'DEGRADED', 'UP'].includes(refetched.data.status), 'check status phai nhan gia tri hop le');
    const list = await c.json('GET', '/api/tickets?source=MONITORING');
    assert.equal(list.status, 200);
    for (const t of list.data) {
      assert.ok(t.id !== undefined && t.title !== undefined, 'moi monitoring ticket deu phai co id/title day du');
    }
  } finally { await c.cleanup(); }
});

test('notifier that bai khong lam MiniERP intake partial state', async () => {
  const notifier = notifierFrom(throwingSync);
  const c = await createTestClient({ notifier, requestLogger: false, miniErpIntegrationKey: 'qa-key' });
  await c.start();
  try {
    const headers = { Authorization: 'Bearer qa-key' };
    const body = { source: 'MINIERP', externalRef: 'ERP-SYNC-1', title: 'sync boom', description: 'x', severity: 'HIGH' };
    const res = await c.json('POST', '/api/integrations/minierp/incidents', body, headers);
    assert.equal(res.status, 201, 'MiniERP intake phai nhan incident du notifier hong');

    // Idempotency must still hold, which proves the record was really stored.
    const again = await c.json('POST', '/api/integrations/minierp/incidents', body, headers);
    assert.equal(again.status, 200);
    assert.equal(again.data.idempotent, true, 'payload trung phai idempotent -> ticket da commit that');
    assert.equal(again.data.id, res.data.id, 'idempotent phai tra ve cung ticket id');
  } finally { await c.cleanup(); }
});

test('SLA read khong 500 khi notifier alert throw dong bo', async () => {
  const notifier = notifierFrom(throwingSync);
  // A clock far past the SLA target forces slaBreach to fire on read.
  const c = await createTestClient({ notifier, requestLogger: false, clock: () => new Date('2999-01-01T00:00:00Z') });
  await c.start();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'sla read probe', requester: 'P' });
    assert.equal(created.status, 201);
    const read = await c.json('GET', `/api/tickets/${created.data.id}`);
    assert.equal(read.status, 200, 'doc ticket khong duoc 500 du slaBreach goi notifier');
    assert.ok(read.data.id === created.data.id, 'van tra ve dung ticket');
    const list = await c.json('GET', '/api/tickets');
    assert.equal(list.status, 200, 'doc collection ticket cung khong duoc 500');
  } finally { await c.cleanup(); }
});
