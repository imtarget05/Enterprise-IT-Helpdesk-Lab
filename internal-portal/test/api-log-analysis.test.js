'use strict';
// FPT evidence: POST /api/ai/log-analysis — parse thật, mask PII, audit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

const UNREACHABLE = { ollamaUrl: 'http://127.0.0.1:1', timeoutMs: 500 };

test('POST /api/ai/log-analysis phân tích thật + mask PII + audit', async () => {
  const c = await createTestClient({ ai: UNREACHABLE });
  await c.start();
  try {
    const { status, data } = await c.json('POST', '/api/ai/log-analysis', {
      service: 'order-api',
      logs: [
        '2026-09-28T10:00:01 ERROR payment timeout 504 after 30s',
        '2026-09-28T10:00:02 ERROR DB connection refused',
        '2026-09-28T10:00:03 WARN retry 1 slow query',
        'user phone 0912345678 in log line',
      ],
      metrics: { p95_ms: 1800 },
    });
    assert.equal(status, 200);
    assert.equal(data.errorCount, 2);
    assert.equal(data.totalLines, 4);
    assert.ok(['high', 'medium', 'critical'].includes(data.severity));
    assert.ok(Array.isArray(data.topPatterns) && data.topPatterns.length > 0);
    assert.ok(Array.isArray(data.evidenceLines));
    assert.ok(!JSON.stringify(data).includes('0912345678'), 'PII phải bị mask');
    assert.ok(data.suggestedRunbook);
    const bad = await c.json('POST', '/api/ai/log-analysis', {});
    assert.equal(bad.status, 400);
  } finally {
    await c.cleanup();
  }
});
