'use strict';

// Review round 5 Important 1 - a whole-collection snapshot restored across an
// `await` is a stale write: while the monitoring probe is pending, any other
// request can commit rows into the SAME collections, and the restore replaces
// those arrays with the pre-await clone. The concurrent commit is then erased
// from memory and a later commit can overwrite db.json without it.
//
// These tests pin owned-change rollback: a transaction may only remove rows it
// created and rewind only the fields it wrote, and it must never replace the
// array (the object identity of surviving rows is asserted directly).

const test = require('node:test');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTestClient } = require('./helpers');

const COLLECTIONS = ['monitoringChecks', 'monitoringHistory', 'tickets', 'ticketEvents', 'auditEvents'];

function countingNotifier() {
  const calls = [];
  return {
    calls,
    notifier: {
      webhookUrl: null,
      lastDelivery: null,
      history: () => ({ count: 0, items: [] }),
      alert(ticket) {
        calls.push({ ticketId: ticket.id, source: ticket.source, priority: ticket.priority });
        return { alerted: true, delivered: true };
      },
    },
  };
}

function stateOf(store) {
  return structuredClone(Object.fromEntries(COLLECTIONS.map((name) => [name, store.data[name]])));
}

function failCommit(store) {
  store.commit = async () => { throw new Error('disk full (simulated)'); };
}

function hintedProbe() {
  return {
    monitoring: {
      async runCheck(check, hint) {
        return { status: hint || 'UP', message: `probe ${hint || 'UP'}` };
      },
    },
  };
}

test('monitoring DOWN commit fail: check, incident, history va alert count ve nguyen state', async () => {
  const { notifier, calls } = countingNotifier();
  const c = await createTestClient({ notifier, requestLogger: false, ...hintedProbe() });
  await c.start();
  try {
    const created = await c.json('POST', '/api/monitoring/checks', {
      name: 'rollback-down', type: 'DNS', target: 'example.invalid', failureThreshold: 1,
    });
    assert.equal(created.status, 201);

    const beforeRun = await c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, { status: 'UP' });
    assert.equal(beforeRun.status, 200);
    const before = stateOf(c.context.store);
    const beforeCounts = Object.fromEntries(COLLECTIONS.map((name) => [name, c.context.store.data[name].length]));
    calls.length = 0;

    failCommit(c.context.store);
    const failed = await c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, { status: 'DOWN' });
    assert.ok(failed.status >= 500, `run DOWN voi commit that phai tra loi server, nhan ${failed.status}`);
    assert.equal(calls.length, 0, 'monitoring commit that khong duoc gui alert');

    assert.deepEqual(stateOf(c.context.store), before, 'commit that khong duoc de lai mutation in-memory');
    for (const name of COLLECTIONS) {
      assert.equal(c.context.store.data[name].length, beforeCounts[name], `so dong ${name} phai nguyen`);
    }

    const check = await c.json('GET', `/api/monitoring/checks/${created.data.id}`);
    assert.equal(check.data.status, 'UP');
    assert.equal(check.data.consecutiveFailures, 0);
    assert.equal(check.data.activeIncidentId, undefined);
    const history = await c.json('GET', `/api/monitoring/history?checkId=${created.data.id}`);
    assert.equal(history.data.count, 1, 'history DOWN khong duoc ghi khi commit that');
  } finally {
    await c.cleanup();
  }
});

test('monitoring UP commit fail: incident dang mo phai giu nguyen state va khong alert', async () => {
  const { notifier, calls } = countingNotifier();
  const c = await createTestClient({ notifier, requestLogger: false, ...hintedProbe() });
  await c.start();
  try {
    const created = await c.json('POST', '/api/monitoring/checks', {
      name: 'rollback-up', type: 'DNS', target: 'example.invalid', failureThreshold: 1,
    });
    assert.equal(created.status, 201);
    const down = await c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, { status: 'DOWN' });
    assert.equal(down.status, 200);
    const incidentId = down.data.check.activeIncidentId;
    assert.ok(incidentId, 'run DOWN phai tao incident de resolve');

    const before = stateOf(c.context.store);
    const beforeCounts = Object.fromEntries(COLLECTIONS.map((name) => [name, c.context.store.data[name].length]));
    calls.length = 0;

    failCommit(c.context.store);
    const failed = await c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, { status: 'UP' });
    assert.ok(failed.status >= 500, `run UP voi commit that phai tra loi server, nhan ${failed.status}`);
    assert.equal(calls.length, 0, 'monitoring commit that khong duoc gui alert');

    assert.deepEqual(stateOf(c.context.store), before, 'resolve incident that phai hoan tac day du');
    for (const name of COLLECTIONS) {
      assert.equal(c.context.store.data[name].length, beforeCounts[name], `so dong ${name} phai nguyen`);
    }

    const check = await c.json('GET', `/api/monitoring/checks/${created.data.id}`);
    assert.equal(check.data.status, 'DOWN');
    assert.equal(check.data.consecutiveFailures, 1);
    assert.equal(check.data.activeIncidentId, incidentId);
    const incident = await c.json('GET', `/api/tickets/${incidentId}`);
    assert.equal(incident.data.state, 'NEW');
    assert.equal(incident.data.resolutionCode, null);
  } finally {
    await c.cleanup();
  }
});

test('monitoring pre-commit exception: mutation truoc save cung phai rollback', async () => {
  const { notifier, calls } = countingNotifier();
  const c = await createTestClient({
    notifier,
    requestLogger: false,
    monitoring: {
      async runCheck(check) {
        check.status = 'DEGRADED';
        check.consecutiveFailures = 7;
        check.activeIncidentId = 999;
        throw new Error('probe exploded before commit');
      },
    },
  });
  await c.start();
  try {
    const created = await c.json('POST', '/api/monitoring/checks', {
      name: 'rollback-precommit', type: 'DNS', target: 'example.invalid', failureThreshold: 1,
    });
    assert.equal(created.status, 201);
    const before = stateOf(c.context.store);
    const beforeCounts = Object.fromEntries(COLLECTIONS.map((name) => [name, c.context.store.data[name].length]));
    calls.length = 0;

    const failed = await c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, {});
    assert.ok(failed.status >= 500, `probe throw truoc commit phai tra loi server, nhan ${failed.status}`);
    assert.equal(calls.length, 0, 'pre-commit exception khong duoc gui alert');

    assert.deepEqual(stateOf(c.context.store), before, 'exception truoc commit phai hoan tac mutation');
    for (const name of COLLECTIONS) {
      assert.equal(c.context.store.data[name].length, beforeCounts[name], `so dong ${name} phai nguyen`);
    }
  } finally {
    await c.cleanup();
  }
});

test('rollback giu nguyen identity cua row dang ton tai (khong thay theo ca collection)', async () => {
  const { notifier } = countingNotifier();
  const c = await createTestClient({ notifier, requestLogger: false, ...hintedProbe() });
  await c.start();
  try {
    const created = await c.json('POST', '/api/monitoring/checks', {
      name: 'identity', type: 'DNS', target: 'example.invalid', failureThreshold: 1,
    });
    assert.equal(created.status, 201);
    const up = await c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, { status: 'UP' });
    assert.equal(up.status, 200);

    // Reference identity, not just deep equality: a rollback that rebuilds the
    // array from clones is observably different from one that rewinds in place.
    const before = Object.fromEntries(COLLECTIONS.map((name) => [name, [...c.context.store.data[name]]]));
    failCommit(c.context.store);
    const failed = await c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, { status: 'DOWN' });
    assert.ok(failed.status >= 500, `commit that phai tra loi server, nhan ${failed.status}`);

    for (const name of COLLECTIONS) {
      const rows = c.context.store.data[name];
      assert.equal(rows.length, before[name].length, `so dong ${name} phai nguyen`);
      for (let i = 0; i < before[name].length; i += 1) {
        assert.equal(rows[i], before[name][i],
          `${name}[${i}] phai giu nguyen object reference sau rollback`);
      }
    }
  } finally {
    await c.cleanup();
  }
});

test('rollback khong xoa ticket da commit cua request chay song song (memory + db.json)', async () => {
  const { notifier } = countingNotifier();
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  let probeEntered;
  const probeStarted = new Promise((resolve) => { probeEntered = resolve; });
  const c = await createTestClient({
    notifier,
    requestLogger: false,
    monitoring: {
      async runCheck() {
        probeEntered();
        await probeGate;
        return { status: 'DOWN', message: 'concurrent probe down' };
      },
    },
  });
  await c.start();
  const realCommit = c.context.store.commit.bind(c.context.store);
  let commitShouldFail = false;
  c.context.store.commit = () => (commitShouldFail
    ? Promise.reject(new Error('disk full (simulated)'))
    : realCommit());
  try {
    const created = await c.json('POST', '/api/monitoring/checks', {
      name: 'concurrent', type: 'DNS', target: 'example.invalid', failureThreshold: 1,
    });
    assert.equal(created.status, 201);

    // Suspend the monitoring request inside the probe, then commit a ticket from
    // a second request while it is parked. The monitoring commit is then forced
    // to fail so its rollback runs with the concurrent row already durable.
    const runPromise = c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, {});
    await probeStarted;

    const ticket = await c.json('POST', '/api/tickets', { title: 'concurrent survivor', requester: 'P' });
    assert.equal(ticket.status, 201, 'request chay song song phai commit duoc');

    commitShouldFail = true;
    releaseProbe();
    const failed = await runPromise;
    commitShouldFail = false;
    assert.ok(failed.status >= 500, `run voi commit that phai tra loi server, nhan ${failed.status}`);

    const inMemory = c.context.store.data.tickets.find((row) => row.id === ticket.data.id);
    assert.ok(inMemory, 'ticket da commit cua request song song phai con trong memory');
    assert.equal(inMemory.title, 'concurrent survivor');

    const durable = JSON.parse(fs.readFileSync(c.dbFile, 'utf8'));
    assert.ok((durable.tickets || []).some((row) => row.id === ticket.data.id),
      'ticket da commit cua request song song phai con tren dia');

    // The failed monitoring transaction still rolls ITS OWN work back.
    const check = await c.json('GET', `/api/monitoring/checks/${created.data.id}`);
    assert.equal(check.data.status, 'UNKNOWN', 'check phai ve trang thai truoc run');
    assert.equal(check.data.consecutiveFailures, 0);
    assert.equal(check.data.activeIncidentId, undefined);
    const incidents = c.context.store.data.tickets.filter((row) => row.source === 'MONITORING');
    assert.equal(incidents.length, 0, 'incident cua transaction that phai bi goi lai');
    const history = await c.json('GET', `/api/monitoring/history?checkId=${created.data.id}`);
    assert.equal(history.data.count, 0, 'history cua transaction that phai bi goi lai');
  } finally {
    await c.cleanup();
  }
});

test('pre-commit exception rollback: chi field da ghi bi rewind, field khac giu nguyen', async () => {
  const { notifier } = countingNotifier();
  const c = await createTestClient({
    notifier,
    requestLogger: false,
    monitoring: {
      async runCheck(check) {
        check.lastMessage = 'written-before-the-throw';
        check.criticality = 'CRITICAL';
        throw new Error('probe exploded before commit');
      },
    },
  });
  await c.start();
  try {
    const created = await c.json('POST', '/api/monitoring/checks', {
      name: 'precommit-fields', type: 'DNS', target: 'example.invalid', failureThreshold: 1, criticality: 'LOW',
    });
    assert.equal(created.status, 201);
    const checkRow = c.context.store.data.monitoringChecks.find((row) => Number(row.id) === Number(created.data.id));
    const nameBefore = checkRow.name;
    const before = stateOf(c.context.store);

    const failed = await c.json('POST', `/api/monitoring/checks/${created.data.id}/run`, {});
    assert.ok(failed.status >= 500, `probe throw truoc commit phai tra loi server, nhan ${failed.status}`);

    assert.equal(c.context.store.data.monitoringChecks.find((row) => Number(row.id) === Number(created.data.id)), checkRow,
      'row da bi edit phai giu nguyen reference');
    assert.equal(checkRow.name, nameBefore, 'field khong sua khong duoc doi');
    assert.equal(checkRow.lastMessage, undefined, 'field da ghi phai duoc rewind');
    assert.equal(checkRow.criticality, 'LOW', 'field da ghi phai duoc rewind ve gia tri cu');
    assert.deepEqual(stateOf(c.context.store), before, 'pre-commit exception phai hoan tac dung phan da sua');
  } finally {
    await c.cleanup();
  }
});
