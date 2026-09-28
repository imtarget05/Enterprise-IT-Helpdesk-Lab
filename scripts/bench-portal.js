'use strict';
/* Micro-benchmark (node stdlib only for timing): portal health latency + store ops.
 * Uses internal-portal/src modules if require-clean (express present), else
 * runs a pure-JSON baseline labeled as such. Never fails: SKIP + exit 0.
 * Run: node scripts/bench-portal.js   (from Enterprise-IT-Helpdesk-Lab/)
 */
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  return { n: s.length, mean, p95 };
}
function row(op, { n, mean, p95 }) {
  console.log(`${op.padEnd(18)}${String(n).padStart(8)}${mean.toFixed(4).padStart(12)}${p95.toFixed(4).padStart(12)}`);
}

async function main() {
  console.log(`${'op'.padEnd(18)}${'n'.padStart(8)}${'mean_ms'.padStart(12)}${'p95_ms'.padStart(12)}`);
  let appMod;
  try {
    appMod = require('../internal-portal/src/app.js');
  } catch (err) {
    // Baseline: pure JSON store ops, no portal deps.
    const N = 2000;
    const samples = [];
    const arr = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      arr.push({ id: `T-${i}`, status: 'Open' });
      JSON.parse(JSON.stringify(arr[arr.length - 1]));
      samples.push(performance.now() - t0);
    }
    console.log(`mode: json baseline (portal modules unavailable: ${(err && err.message) || err})`);
    row('store_ops', stats(samples));
    return;
  }
  // Require-clean path: boot app on ephemeral dataDir, measure /health + store ops.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-portal-'));
  const { app, store } = await appMod.createApp({ dataDir: tmp });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const N = 200;
    const lat = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text());
      lat.push(performance.now() - t0);
    }
    console.log('mode: portal modules (createApp, ephemeral dataDir)');
    row('health_latency', stats(lat));

    const M = 500;
    const ops = [];
    for (let i = 0; i < M; i++) {
      const t0 = performance.now();
      store.append('tickets', { id: 100000 + i, title: `bench-${i}`, priority: 'Low', status: 'Open' });
      ops.push(performance.now() - t0);
    }
    row('store_ops', stats(ops));
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.log(`SKIP bench-portal: ${err && err.message}`);
  process.exit(0);
});
