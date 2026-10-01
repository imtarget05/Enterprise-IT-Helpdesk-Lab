'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ServiceBusAutomationWorker } = require('../src/servicebus-worker');

describe('Service Bus Automation Worker', () => {
  test('processes valid automation job and marks complete', async () => {
    const worker = new ServiceBusAutomationWorker();
    const res = await worker.processJob({ id: 'job-101', type: 'escalate_ticket', ticketId: 1001 });
    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(res.jobId, 'job-101');
    assert.ok(res.executedAt);
  });

  test('idempotently skips already processed job ID (deduplication)', async () => {
    const worker = new ServiceBusAutomationWorker();
    await worker.processJob({ id: 'job-repeat-1', type: 'provision_access' });
    const res = await worker.processJob({ id: 'job-repeat-1', type: 'provision_access' });
    assert.strictEqual(res.status, 'duplicate_skipped');
    assert.strictEqual(res.jobId, 'job-repeat-1');
  });

  test('rejects job without id', async () => {
    const worker = new ServiceBusAutomationWorker();
    await assert.rejects(async () => {
      await worker.processJob({ type: 'dispatch_alert' });
    }, /missing job.id/);
  });
});
