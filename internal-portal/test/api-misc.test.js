'use strict';

/** REST API — Licenses, error handling, static assets. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

let c;
before(async () => {
  c = await createTestClient();
  await c.start();
});
after(() => c.cleanup());

test('GET /api/licenses → 200, available = total - assigned', async () => {
  const { status, data } = await c.json('GET', '/api/licenses');
  assert.equal(status, 200);
  assert.ok(data.length >= 4);
  assert.ok(data.every((l) => l.available === l.total - l.assigned));
  assert.ok(data.some((l) => l.software === 'AutoCAD 2026 Commercial' && l.available === 0));
});

test('GET /api/licenses/:id → 200 + utilizationPercent / 404', async () => {
  const ok = await c.json('GET', '/api/licenses/1');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.id, 1);
  assert.equal(ok.data.utilizationPercent, 84, '84/100 → 84%');
  assert.equal((await c.json('GET', '/api/licenses/999')).status, 404);
});

test('Method không hỗ trợ → 405 + Allow header', async () => {
  const res = await c.json('DELETE', '/api/licenses/1');
  assert.equal(res.status, 405);
  assert.match(res.headers.get('allow'), /GET/);

  const postOnItem = await c.json('POST', '/api/assets/1', { tag: 'NOPE' });
  assert.equal(postOnItem.status, 405);
});

test('Factory routes trả 405 đúng Allow khi sai method', async () => {
  const checks = await c.json('PUT', '/api/monitoring/checks');
  assert.equal(checks.status, 405);
  assert.match(checks.headers.get('allow'), /GET/);
  assert.match(checks.headers.get('allow'), /POST/);

  const run = await c.json('GET', '/api/monitoring/checks/1/run');
  assert.equal(run.status, 405);
  assert.match(run.headers.get('allow'), /POST/);

  const handoff = await c.json('POST', '/api/access-requests/1/handoff');
  assert.equal(handoff.status, 405);
  assert.match(handoff.headers.get('allow'), /GET/);

  const change = await c.json('PUT', '/api/changes');
  assert.equal(change.status, 405);
  assert.match(change.headers.get('allow'), /GET/);
  assert.match(change.headers.get('allow'), /POST/);
});

test('Route lạ trong /api → 404 JSON kèm path', async () => {
  const notFound = await c.json('GET', '/api/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.ok(notFound.data.error);
  assert.equal(notFound.data.path, '/api/does-not-exist');
});

test('Body JSON hỏng → 400, server không crash', async () => {
  const bad = await c.send('POST', '/api/assets', '{oops', 'application/json');
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error);
  assert.equal((await c.json('GET', '/api/health')).status, 200, 'server vẫn sống sau request body hỏng');
});

test('Static: GET / → HTML dashboard, GET /app.js → JS có nút export CSV', async () => {
  const page = await c.api('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /BMC IT PORTAL/);

  const script = await c.api('GET', '/app.js');
  assert.equal(script.status, 200);
  assert.match(await script.text(), /btn-export-assets|exportAssetsCsv/);
});

test('Runbook và scenario docs được serve read-only từ portal', async () => {
  const runbook = await c.api('GET', '/docs/07-vlan-firewall-design.md');
  assert.equal(runbook.status, 200);
  assert.match(runbook.headers.get('content-type'), /text\/markdown|text\/plain/);
  assert.match(await runbook.text(), /VLAN/);

  const scenario = await c.api('GET', '/scenarios/factory/scenario-01-dhcp-apipa.md');
  assert.equal(scenario.status, 200);
  assert.match(await scenario.text(), /## Evidence/);
});
