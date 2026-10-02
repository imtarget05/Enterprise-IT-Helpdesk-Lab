'use strict';

/**
 * Crash-window mutation harness.
 *
 * The tests in `worker-crash-windows.test.js` claim
 * `duplicate_privileged_execution = 0`. That claim is worth nothing unless it
 * FAILS when the durable idempotency claim is removed — so this harness removes
 * it and checks that a duplicate execution is actually observed.
 *
 * If a mutation SURVIVES here, the crash-window suite is decoration.
 *
 * Run: node scripts/crash-window-mutation-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LIFECYCLE = path.resolve(ROOT, 'src', 'action-lifecycle.js');
const QUEUE = path.resolve(ROOT, 'src', 'automation-queue.js');
const GATE = path.resolve(ROOT, 'test', 'worker-crash-windows.test.js');

const MUTATIONS = [
  {
    id: 'M-C1',
    name: 'durable idempotency claim removed (the duplicate window opens)',
    file: LIFECYCLE,
    // Two guards exist: the pre-flight `getExecutionByKey` lookup and the
    // durable `claimExecution`. Removing only the first leaves the second, so
    // the suite correctly still passed — that is defence in depth, not a weak
    // test. This mutation removes the one that actually authorises the effect.
    find: '    let claim = await store.claimExecution({\n      proposalId, idempotencyKey, tenantId: proposal.tenantId, workerId,\n      attempt, approvalId, approvalState,\n    });',
    replace: '    let claim = { claimed: true, duplicate: false, executionId: `synthetic-${idempotencyKey}` };\n    void store.claimExecution;',
  },
  {
    id: 'M-C2',
    name: 'queue receive() deletes on delivery instead of peeking',
    // Turning peek into delete removes the at-least-once property entirely,
    // which would let the "redelivered after crash" tests pass vacuously.
    file: QUEUE,
    find: '      const pending = read(files.pending, []);\n      return pending.length ? pending[0] : null;',
    replace: '      const pending = read(files.pending, []);\n      if (!pending.length) return null;\n      pending.shift();\n      void writeAtomic(files.pending, pending);\n      return pending.length ? pending[0] : null;',
  },
  {
    id: 'M-C3',
    name: 'a duplicate delivery is reported as success instead of blocked',
    file: LIFECYCLE,
    // The other half of the boundary: even if the claim detects the duplicate,
    // returning `ok: true` here would let the worker COMPLETE the message and
    // clear it from the queue, so the blocked delivery would look like a
    // success to every operator reading the outcome.
    find: "          ok: false, status: duplicateStatus, executed: false, duplicate: true,",
    replace: "          ok: true, status: 'COMPLETED', executed: false, duplicate: true,",
  },
  {
    id: 'M-C4',
    name: 'the pre-flight idempotency lookup removed (first of two guards)',
    file: LIFECYCLE,
    find: 'const preExisting = await store.getExecutionByKey(idempotencyKey);',
    replace: 'const preExisting = null;',
  },
];

const originals = new Map();
for (const f of [LIFECYCLE, QUEUE]) originals.set(f, fs.readFileSync(f, 'utf8'));
const results = [];

function runGate() {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=60000', '--test-force-exit', GATE], {
    encoding: 'utf8',
    timeout: 180000,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0) return { failed: false };
  return { failed: true, status: r.status, assertionFailure: /AssertionError|ERR_ASSERTION/.test(output) };
}

try {
  for (const m of MUTATIONS) {
    const original = originals.get(m.file);
    if (!original.includes(m.find)) {
      results.push({ id: m.id, name: m.name, outcome: 'ERROR: anchor not found — mutation did not apply' });
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.find, m.replace));
    const { failed, status, assertionFailure } = runGate();
    // Restore immediately: the next mutation must not inherit this one.
    fs.writeFileSync(m.file, original);
    results.push({
      id: m.id,
      name: m.name,
      outcome: failed && assertionFailure
        ? 'CAUGHT (a duplicate execution was observed)'
        : failed
          ? `UNCATCHED — gate exited ${status} with no assertion failure`
          : 'SURVIVED — the gate passed with the duplicate guard removed',
      weak: failed && !assertionFailure,
    });
  }
} finally {
  for (const [f, original] of originals) fs.writeFileSync(f, original);
}

const restored = runGate();
const survived = results.filter((r) => r.outcome.startsWith('SURVIVED') || r.outcome.startsWith('ERROR'));
const weak = results.filter((r) => r.weak);
const caught = results.filter((r) => r.outcome.startsWith('CAUGHT'));

for (const r of results) console.log(`${r.id.padEnd(6)} ${r.outcome}\n       ${r.name}`);
console.log(`\nbaseline restored: ${restored.failed ? 'FAILING' : 'green'}`);
console.log(`${caught.length}/${results.length} mutations caught`);
process.exit(survived.length === 0 && weak.length === 0 && !restored.failed ? 0 : 1);