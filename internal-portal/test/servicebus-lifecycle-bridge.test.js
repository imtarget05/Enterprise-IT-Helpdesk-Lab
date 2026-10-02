'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ServiceBusAutomationWorker } = require('../src/servicebus-worker');

describe('Service Bus worker with a governed lifecycle bridge', () => {
  test('governed jobs execute through the lifecycle, never in the worker', async () => {
    const { createLifecycleBridge } = require('../src/servicebus-bridge');
    const { createMemoryLifecycleStore } = require('../src/lifecycle-store-memory');
    const { createActionLifecycle } = require('../src/action-lifecycle');

    const store = createMemoryLifecycleStore();
    const executed = [];
    const lifecycle = createActionLifecycle({
      store,
      // `postCheck` must carry `verified` for the lifecycle to treat it as proof.
// The old shape here was `{ ok: true }`, which the previous check
// (`postCheck !== false`) accepted as success by accident — an object with no
// verdict at all. A post-check that cannot say "verified" is not evidence.
      executor: { async run(req) { executed.push(req.action); return { ok: true, postCheck: { verified: true } }; } },
    });

    const proposed = await lifecycle.propose({
      actor: { username: 'tan.admin', role: 'IT_ADMIN', authenticated: true },
      tenantId: 'tenant-a',
      proposal: { action: 'export_it_asset_audit', parameters: {} },
    });
    assert.equal(proposed.status, 'ALLOWED');
    const { message } = await lifecycle.enqueue({ proposalId: proposed.proposalId });

    const worker = new ServiceBusAutomationWorker({
      lifecycleBridge: createLifecycleBridge({ lifecycle }),
    });

    // The queue job carries identifiers ONLY — no command, no script path.
    const res = await worker.processJob({ id: 'gov-1', ...message });
    assert.equal(res.status, 'completed');
    assert.equal(res.governed, true);
    assert.deepEqual(executed, ['export_it_asset_audit']);

    // The SAME message id, replayed through the worker, must not re-execute.
    const replay = await worker.processJob({ id: 'gov-1', ...message });
    assert.equal(replay.status, 'duplicate_skipped');
    assert.deepEqual(executed, ['export_it_asset_audit']);
  });

  test('non-governed jobs keep the exact legacy contract', async () => {
    const worker = new ServiceBusAutomationWorker();
    const res = await worker.processJob({ id: 'legacy-1', type: 'escalate_ticket' });
    assert.equal(res.status, 'completed');
    assert.equal(res.jobId, 'legacy-1');
    const again = await worker.processJob({ id: 'legacy-1', type: 'escalate_ticket' });
    assert.equal(again.status, 'duplicate_skipped');
  });

  test('jobs without an id are rejected, governed or not', async () => {
    const worker = new ServiceBusAutomationWorker();
    await assert.rejects(() => worker.processJob({ type: 'dispatch_alert' }), /missing job.id/);
  });
});