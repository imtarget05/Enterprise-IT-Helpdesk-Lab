'use strict';

/**
 * Review Important 2 — `alerted` on POST /api/tickets must reflect the notifier
 * result, not a hard-coded true.
 *
 * The notifier deliberately returns { alerted: false } for Low/Medium
 * (src/notify.js shouldAlert -> ALERT_PRIORITIES High/Critical), and the UI
 * renders an alert toast from this flag (public/app.js). A hard-coded true
 * makes every routine Low ticket look like it paged the on-call engineer.
 *
 * All cases run offline against a real server. The notifier is injected through
 * createApp options, so no webhook or external host is ever contacted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

// Records every alert() call and returns a scripted result. `result` may be a
// function so each call can behave differently.
function fakeNotifier(result) {
  const calls = [];
  return {
    calls,
    notifier: {
      logFile: null,
      lastDelivery: null,
      shouldAlert: () => true,
      history: (limit = 50) => ({ count: calls.length, items: calls.slice(0, limit) }),
      async alert(ticket) {
        calls.push(ticket);
        const r = typeof result === 'function' ? result(ticket, calls.length) : result;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

test('POST /api/tickets alerted=false khi notifier cho nguong duoi (Low)', async () => {
  const { notifier, calls } = fakeNotifier({ alerted: false, reason: 'priority-below-threshold' });
  const c = await createTestClient({ notifier, requestLogger: false });
  await c.start();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'Low routine', requester: 'P', priority: 'Low' });
    assert.equal(created.status, 201);
    assert.equal(created.data.priority, 'Low', 'tien doan: ticket Low');
    assert.equal(created.data.alerted, false, 'ticket Low khong duoc alerted=true (UI se hien toast cam bao sai)');
    assert.equal(calls.length, 1, 'notifier phai duoc goi mot lan');
  } finally { await c.cleanup(); }
});

test('POST /api/tickets alerted=true khi notifier bao da gui (High)', async () => {
  const { notifier, calls } = fakeNotifier({ alerted: true, delivered: null, deliveryError: null });
  const c = await createTestClient({ notifier, requestLogger: false });
  await c.start();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'High urgent', requester: 'P', priority: 'High' });
    assert.equal(created.status, 201);
    assert.equal(created.data.priority, 'High', 'tien doan: ticket High');
    assert.equal(created.data.alerted, true, 'ticket High da gui alert phai alerted=true');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, 'High urgent', 'notifier phai nhan duoc ticket vua tao');
  } finally { await c.cleanup(); }
});

test('POST /api/tickets khong duoc 500 khi notifier nem loi (van 201, alerted=false)', async () => {
  const { notifier, calls } = fakeNotifier(new Error('webhook exploded'));
  const c = await createTestClient({ notifier, requestLogger: false });
  await c.start();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'Notifier down', requester: 'P', priority: 'Critical' });
    assert.equal(created.status, 201, 'loi notifier khong duoc lam sap request tao ticket');
    assert.equal(created.data.alerted, false, 'notifier that bai => alerted=false');
    assert.equal(calls.length, 1);
    // The ticket itself must still be readable and complete.
    const fetched = await c.json('GET', `/api/tickets/${created.data.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.data.title, 'Notifier down', 'ticket van duoc luu day du khi notifier that bai');
  } finally { await c.cleanup(); }
});
