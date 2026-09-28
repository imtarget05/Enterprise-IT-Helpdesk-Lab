'use strict';

// FPT evidence: GET /api/monitoring/ops-report — automated operational report.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

let c;
test.before(async () => {
  c = await createTestClient();
  await c.start();
});
test.after(() => c.cleanup());

test('GET /api/monitoring/ops-report trả JSON aggregate 200', async () => {
  const { status, data } = await c.json('GET', '/api/monitoring/ops-report');
  assert.equal(status, 200);
  assert.ok(data.window && data.window.hours >= 1, 'phải có window.hours');
  assert.ok(['HEALTHY', 'DEGRADED', 'ATTENTION'].includes(data.overallStatus));
  assert.ok(data.monitoring.statusRollup && typeof data.monitoring.statusRollup.UP === 'number');
  assert.ok(data.tickets && typeof data.tickets.opened === 'number');
  assert.ok(typeof data.tickets.slaBreached === 'number');
  assert.ok(Array.isArray(data.summary) && data.summary.length >= 3);
});

test('ops-report là aggregate-only: không lộ title/requester/description', async () => {
  const { data } = await c.json('GET', '/api/monitoring/ops-report?windowHours=720');
  const blob = JSON.stringify(data);
  assert.ok(!blob.includes('requester'), 'không được chứa field requester');
  assert.ok(!blob.includes('description'), 'không được chứa field description');
  // Seed ticket 1001 có title chứa "DNS" (xem api-tickets) — title không được lọt vào report.
  assert.ok(!blob.includes('QA ticket'), 'không được chứa ticket title');
});

test('?format=markdown trả text/markdown có heading', async () => {
  const res = await c.api('GET', '/api/monitoring/ops-report?format=markdown');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/markdown/);
  const body = await res.text();
  assert.match(body, /^# Operational Report/m);
  assert.match(body, /## Monitoring/);
  assert.match(body, /## Tickets & SLA/);
  assert.match(body, /## AI activity/);
});

test('?windowHours bị clamp về [1,168]', async () => {
  const lo = await c.json('GET', '/api/monitoring/ops-report?windowHours=0');
  assert.equal(lo.status, 200);
  assert.equal(lo.data.window.hours, 1);
  const hi = await c.json('GET', '/api/monitoring/ops-report?windowHours=9999');
  assert.equal(hi.status, 200);
  assert.equal(hi.data.window.hours, 168);
});

test('log-analysis chạy xong được đếm vào report (AI activity)', async () => {
  const analysis = await c.json('POST', '/api/ai/log-analysis', {
    service: 'ops-report-qa',
    logs: ['2026-09-28T10:00:01 ERROR payment timeout 504 after 30s'],
  });
  assert.equal(analysis.status, 200);
  const { data } = await c.json('GET', '/api/monitoring/ops-report');
  assert.ok(data.ai.logAnalyses >= 1, `ai.logAnalyses phải >= 1, nhận ${data.ai.logAnalyses}`);
});
