'use strict';

/**
 * Review round 3 #1 — persistence must be committed BEFORE the external alert,
 * and the notifier must be bounded.
 *
 * Round 2 made `safeNotify` fail-soft for every *finite* failure shape, but the
 * ordering was still wrong: `createTicket` awaited the notifier and every caller
 * committed only afterwards. Two consequences:
 *
 *  1. A notifier that never settles blocks the request forever, so the ticket is
 *     never persisted — and same-process reads can still see the in-memory row.
 *  2. If `store.commit()` fails after a successful alert, the client gets a 500
 *     and no durable ticket, yet an external alert has already announced it.
 *
 * The removed legacy route committed before notifying. These tests pin the
 * ordering, a bounded timeout, and the "no alert on commit failure" rule.
 *
 * A commit-failure probe is used rather than a real broken disk, so the ordering
 * assertion is deterministic and offline. A never-resolving notifier is paired
 * with a bounded, deterministic timer rather than a long sleep.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTestClient } = require('./helpers');
const { createNotifier } = require('../src/notify.js');

function orderingNotifier(events, dbFile) {
  return {
    webhookUrl: null,
    lastDelivery: null,
    history: () => ({ count: 0, items: [] }),
    async alert(ticket) {
      const persisted = JSON.parse(await fs.promises.readFile(dbFile(), 'utf8'));
      events.push({
        kind: 'alert',
        ticketId: ticket.id,
        source: ticket.source,
        externalRef: ticket.externalRef,
        durableTicketIds: (persisted.tickets || []).map((row) => row.id),
        durableHistoryCount: (persisted.monitoringHistory || []).length,
      });
      return { alerted: true, delivered: true };
    },
  };
}

function hangingNotifier(events) {
  return {
    webhookUrl: null,
    lastDelivery: null,
    history: () => ({ count: 0, items: [] }),
    alert(ticket, contract) {
      events.push({
        kind: 'alert-hang',
        ticketId: ticket.id,
        hasSignal: Boolean(contract && contract.signal),
        deadline: contract && contract.deadline,
      });
      return new Promise(() => {});
    },
  };
}

async function withNotifyTimeout(ms, run) {
  const previous = process.env.IT_NOTIFY_TIMEOUT_MS;
  process.env.IT_NOTIFY_TIMEOUT_MS = String(ms);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.IT_NOTIFY_TIMEOUT_MS;
    else process.env.IT_NOTIFY_TIMEOUT_MS = previous;
  }
}

test('notifier chi thay ticket da durable tren dia khi alert (ticket, monitoring, MiniERP)', async () => {
  const events = [];
  let c;
  const notifier = orderingNotifier(events, () => c.dbFile);
  c = await createTestClient({
    notifier,
    requestLogger: false,
    miniErpIntegrationKey: 'qa-key',
    monitoring: { async runCheck() { return { status: 'DOWN', message: 'order probe down' }; } },
  });
  await c.start();
  try {
    const created = await c.json('POST', '/api/tickets', { title: 'order probe', requester: 'P', priority: 'High' });
    assert.equal(created.status, 201);
    const monitor = await c.json('POST', '/api/monitoring/checks', { name: 'order check', type: 'DNS', target: 'example.invalid', failureThreshold: 1 });
    assert.equal(monitor.status, 201);
    const run = await c.json('POST', `/api/monitoring/checks/${monitor.data.id}/run`, { status: 'DOWN' });
    assert.equal(run.status, 200);
    const erp = await c.json('POST', '/api/integrations/minierp/incidents',
      { source: 'MINIERP', externalRef: 'ERP-ORDER-1', title: 'order', description: 'x', severity: 'HIGH' },
      { Authorization: 'Bearer qa-key' });
    assert.equal(erp.status, 201);

    assert.equal(events.length, 3, `can 3 alert, nhan ${events.length}`);
    for (const event of events) {
      assert.equal(event.kind, 'alert');
      assert.ok(event.durableTicketIds.includes(event.ticketId),
        `alert ${event.ticketId} chay khi ${event.ticketId} chua co tren dia: ${JSON.stringify(event.durableTicketIds)}`);
    }
    assert.ok(events.some((event) => event.source === 'MONITORING' && event.durableHistoryCount >= 1),
      'monitoring alert phai thay incident va history da durable');
    assert.ok(events.some((event) => event.externalRef === 'ERP-ORDER-1'),
      'MiniERP alert phai quan sat ticket durable tu receiver');
  } finally { await c.cleanup(); }
});

test('notifier treo: signal+deadline duoc cap, request bounded va alerted=false', async () => {
  const events = [];
  await withNotifyTimeout(50, async () => {
    const c = await createTestClient({ notifier: hangingNotifier(events), requestLogger: false });
    await c.start();
    try {
      const started = process.hrtime.bigint();
      const created = await c.json('POST', '/api/tickets', { title: 'hang probe', requester: 'P', priority: 'Critical' });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      assert.equal(created.status, 201, 'notifier treo khong duoc lam request that bai');
      assert.equal(created.data.alerted, false, 'notifier treo => alerted=false');
      assert.ok(elapsedMs < 1500, `request phai bounded, nhan ${elapsedMs.toFixed(1)}ms`);
      assert.equal(events.length, 1);
      assert.equal(events[0].hasSignal, true, 'notifier phai nhan AbortSignal');
      assert.ok(Number(events[0].deadline) > Date.now() - 1000, 'notifier phai nhan deadline');

      const fetched = await c.json('GET', `/api/tickets/${created.data.id}`);
      assert.equal(fetched.status, 200, 'ticket da commit phai doc lai duoc');
      assert.equal(fetched.data.title, 'hang probe');
      const list = await c.json('GET', '/api/tickets?q=hang probe');
      assert.ok(list.data.some((t) => t.id === created.data.id), 'ticket da commit phai xuat hien trong collection');
    } finally { await c.cleanup(); }
  });
});

test('notifier treo: monitoring va MiniERP van tra ket qua nhanh va durable', async () => {
  const events = [];
  await withNotifyTimeout(50, async () => {
    const c = await createTestClient({ notifier: hangingNotifier(events), requestLogger: false, miniErpIntegrationKey: 'qa-key' });
    await c.start();
    try {
      const check = await c.json('POST', '/api/monitoring/checks', { name: 'hang check', type: 'DNS', target: 'example.invalid', failureThreshold: 1 });
      assert.equal(check.status, 201);
      const run = await c.json('POST', `/api/monitoring/checks/${check.data.id}/run`, {});
      assert.equal(run.status, 200, 'monitoring run khong duoc treo boi notifier');

      const headers = { Authorization: 'Bearer qa-key' };
      const body = { source: 'MINIERP', externalRef: 'ERP-HANG-1', title: 'hang', description: 'x', severity: 'HIGH' };
      const first = await c.json('POST', '/api/integrations/minierp/incidents', body, headers);
      assert.equal(first.status, 201);
      const again = await c.json('POST', '/api/integrations/minierp/incidents', body, headers);
      assert.equal(again.status, 200);
      assert.equal(again.data.idempotent, true, 'idempotency state phai da commit truoc alert');
    } finally { await c.cleanup(); }
  });
});

const { createApp } = require('../src/app.js');

test('commit that: notifier KHONG duoc goi (call count = 0) va client khong nhan success', async () => {
  const events = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-r3-commit-fail-'));
  const { app, store } = await createApp({ dataDir, requestLogger: false, notifier: orderingNotifier(events, () => path.join(dataDir, 'db.json')) });

  // Make every durable commit fail.
  store.commit = async () => { throw new Error('disk full (simulated)'); };

  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'commit fail probe', requester: 'P', priority: 'High' }),
    });
    assert.ok(res.status >= 500, `client phai nhan loi server, nhan ${res.status}`);

    assert.equal(events.length, 0,
      `notifier KHONG duoc goi khi commit that; nhan ${events.length} calls: ${JSON.stringify(events)}`);

    // No in-memory ghost: the ticket must not be observable.
    const list = await fetch(`${base}/api/tickets?q=commit fail probe`);
    const rows = await list.json();
    assert.ok(!rows.some((t) => t.title === 'commit fail probe'),
      'khong duoc de lai ticket ghost trong bo nho khi commit that');
  } finally {
    const closed = new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await closed;
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});

test('safeNotify abort notifier chay refed handle va xoa handle khi timeout', async () => {
  const events = [];
  const notifier = {
    webhookUrl: null,
    lastDelivery: null,
    history: () => ({ count: 0, items: [] }),
    alert(ticket, contract) {
      const signal = contract && contract.signal;
      const handle = setInterval(() => {}, 25);
      events.push({ kind: 'handle-alert', ticketId: ticket.id, handle, hasSignal: Boolean(signal), deadline: contract && contract.deadline });
      return new Promise((resolve) => {
        if (!signal) {
          setTimeout(() => {
            clearInterval(handle);
            events.push({ kind: 'self-cleanup', handle });
            resolve({ alerted: false, reason: 'fake-timeout' });
          }, 1000);
          return;
        }
        if (signal.aborted) {
          clearInterval(handle);
          events.push({ kind: 'aborted', handle });
          return resolve({ alerted: false, reason: 'notifier-aborted' });
        }
        signal.addEventListener('abort', () => {
          clearInterval(handle);
          events.push({ kind: 'aborted', handle });
          resolve({ alerted: false, reason: 'notifier-aborted' });
        }, { once: true });
      });
    },
  };

  await withNotifyTimeout(50, async () => {
    const c = await createTestClient({ notifier, requestLogger: false });
    await c.start();
    try {
      const started = process.hrtime.bigint();
      const created = await c.json('POST', '/api/tickets', { title: 'handle probe', requester: 'P', priority: 'Critical' });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(created.status, 201);
      assert.equal(created.data.alerted, false);
      assert.ok(elapsedMs < 1500, `request phai bounded, nhan ${elapsedMs.toFixed(1)}ms`);

      const startedEvent = events.find((event) => event.kind === 'handle-alert');
      assert.ok(startedEvent, 'notifier phai duoc goi');
      assert.equal(startedEvent.hasSignal, true, 'safeNotify phai truyền AbortSignal');
      assert.ok(Number(startedEvent.deadline) > Date.now() - 1000, 'safeNotify phai truyền deadline');
      const abortEvent = events.find((event) => event.kind === 'aborted');
      assert.ok(abortEvent, 'timeout phai abort notifier');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(process._getActiveHandles().includes(abortEvent.handle), false, 'handle khong con active sau abort');
    } finally { await c.cleanup(); }
  });
});

test('notifier bo qua signal: response van alerted=false va khong kha dinh alert da gui', async () => {
  const events = [];
  const notifier = {
    webhookUrl: null,
    lastDelivery: null,
    history: () => ({ count: 0, items: [] }),
    alert(ticket, contract) {
      events.push({ kind: 'ignoring-alert', ticketId: ticket.id, hasSignal: Boolean(contract && contract.signal), deadline: contract && contract.deadline });
      setTimeout(() => events.push({ kind: 'late-delivery', ticketId: ticket.id }), 120);
      return new Promise((resolve) => setTimeout(() => resolve({ alerted: true, delivered: true }), 120));
    },
  };

  await withNotifyTimeout(40, async () => {
    const c = await createTestClient({ notifier, requestLogger: false });
    await c.start();
    try {
      const created = await c.json('POST', '/api/tickets', { title: 'ignoring signal', requester: 'P', priority: 'Critical' });
      assert.equal(created.status, 201);
      assert.equal(created.data.alerted, false, 'notifier chua theo signal khong duoc bao gui chac chan');
      assert.notEqual(created.data.deliveryStatus, 'sent', 'response khong duoc kha dinh alert da gui');
      const startedEvent = events.find((event) => event.kind === 'ignoring-alert');
      assert.equal(startedEvent.hasSignal, true, 'notifier van phai nhan signal de co the huy');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(events.filter((event) => event.kind === 'late-delivery').length, 1,
        'test phai chung minh alert co the den late khi notifier bo qua signal');
    } finally { await c.cleanup(); }
  });
});

test('default notifier truyền signal xuống fetch, abort socket và tra alerted=false', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-r4-notifier-'));
  let requestStartedResolve;
  const requestStarted = new Promise((resolve) => { requestStartedResolve = resolve; });
  const server = http.createServer((req) => {
    requestStartedResolve();
    req.on('aborted', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const notifier = createNotifier({ dataDir, webhookUrl: `http://127.0.0.1:${server.address().port}/hook` });
  const controller = new AbortController();
  const alertPromise = notifier.alert({ id: 9001, priority: 'High', title: 'abort webhook', requester: 'P' }, {
    signal: controller.signal,
    deadline: Date.now() + 5000,
  });
  // Wait until the request is actually on the socket BEFORE arming the abort:
  // on a slow filesystem or a loaded CI scheduler the caller could otherwise
  // abort before `fetch` ever dials, and the test would fail on the
  // `requestStarted` timeout even though cancellation is correct.
  let abortTimer;
  try {
    await Promise.race([
      requestStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('webhook request khong bat dau')), 1000)),
    ]);
    abortTimer = setTimeout(() => controller.abort(new Error('request deadline')), 50);
    const started = process.hrtime.bigint();
    const result = await alertPromise;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `default notifier phai ngat theo signal, nhan ${elapsedMs.toFixed(1)}ms`);
    assert.equal(result.alerted, false, 'notifier bi abort khong duoc bao gui chac chan');
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    const closed = new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await closed;
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});


/**
 * Review round 5 Minor — a caller that aborts while the notification log is
 * being written must not have a webhook POST started afterwards.
 *
 * The default adapter checked `callerSignal.aborted` only at entry and then
 * awaited `fs.mkdir`/`fs.appendFile` before it registered the abort listener, so
 * an abort that landed during that I/O was missed entirely and the request still
 * went out. This test uses a minimal AbortSignal stand-in whose `aborted` flips
 * to true the moment the notifier registers its listener, which is exactly the
 * window the review describes. It deliberately does not deliver the abort event,
 * so the assertion pins the *recheck* rather than listener-driven cancellation
 * (already covered by the local-socket test below).
 */
test('notifier bi abort trong luc ghi notifications.log: webhook khong duoc goi', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-r5-notifier-'));
  let webhookHits = 0;
  const server = http.createServer((req, res) => { webhookHits += 1; res.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const notifier = createNotifier({ dataDir, webhookUrl: `http://127.0.0.1:${server.address().port}/hook` });
  const signal = {
    aborted: false,
    reason: new Error('caller gave up during notification log I/O'),
    addEventListener(type) { if (type === 'abort') this.aborted = true; },
    removeEventListener() {},
  };
  try {
    const result = await notifier.alert(
      { id: 9100, priority: 'High', title: 'abort during log io', requester: 'P' },
      { signal, deadline: Date.now() + 5000 },
    );
    assert.equal(webhookHits, 0, `webhook khong duoc goi khi caller da abort, nhan ${webhookHits} request(s)`);
    assert.equal(result.alerted, false, 'notifier bi abort khong duoc bao gui chac chan');
    assert.equal(result.reason, 'notifier-aborted');
  } finally {
    const closed = new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await closed;
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});
