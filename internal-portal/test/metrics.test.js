'use strict';

/**
 * GET /metrics — public Prometheus observability endpoint.
 *
 * Deliberately unauthenticated (Prometheus scrape convention: scrapers carry no
 * session cookie) and aggregate-only (no PII/ticket bodies). Registered BEFORE
 * the /api catch-all in src/app.js, so it answers 200 text/plain instead of
 * the fail-closed 404 JSON that unknown routes receive.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

let c;
before(async () => {
  c = await createTestClient({ requestLogger: false });
  await c.start();
});
after(() => c.cleanup());

test('GET /metrics → 200 text/plain, khong yeu cau auth', async () => {
  const res = await c.api('GET', '/metrics');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const body = await res.text();
  for (const series of [
    'helpdesk_tickets_total',
    'helpdesk_tickets_open',
    'helpdesk_assets_total',
    'helpdesk_uptime_seconds',
    'http_requests_total',
  ]) {
    assert.ok(body.includes(series), `thieu series ${series}`);
  }
});

test('GET /metrics khong chua PII hay ticket bodies', async () => {
  const res = await c.api('GET', '/metrics');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!/@/.test(body), 'metrics khong duoc chua email/PII');
});

test('GET /metrics dem request theo route×status (http_requests_total)', async () => {
  await c.json('GET', '/api/health');
  const res = await c.api('GET', '/metrics');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(
    body,
    /http_requests_total\{method="GET",route="\/api\/health",status="200"\} \d+/,
    'phai co counter cho GET /api/health 200'
  );
});

test('route la trong /api van 404 JSON (fail-closed giu nguyen)', async () => {
  const notFound = await c.json('GET', '/api/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.ok(notFound.data.error);
});
