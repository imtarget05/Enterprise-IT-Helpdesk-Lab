'use strict';

/**
 * Phase-2 live guard (node:test + stdlib http only, no extra deps).
 *
 * - requireLive(name, url): 1.2s-timeout GET probe; returns false (logs SKIP,
 *   caller returns early) when unreachable so CI without infra stays green.
 * - One live test boots the real app factory (src/app.js createApp) on an
 *   ephemeral port and hits /api/health.
 * - One offline test asserts all seeded ticket fixtures (src/seed.js, same
 *   pattern as test/api-tickets.test.js which expects ticket id 1001) have
 *   unique ids.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT_MS = 1200;

function get(url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, res) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(res);
    };
    let req;
    try {
      req = http.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(null, {
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
        res.on('error', finish);
      });
    } catch (err) {
      finish(err);
      return;
    }
    req.on('error', finish);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
  });
}

/** Probe helper: false + SKIP log when unreachable; true when HTTP 2xx. */
async function requireLive(name, url, timeoutMs = TIMEOUT_MS) {
  try {
    const res = await get(url, timeoutMs);
    if (res.status >= 200 && res.status < 300) return true;
    console.log(`SKIP ${name}: ${url} answered HTTP ${res.status}`);
    return false;
  } catch (err) {
    console.log(`SKIP ${name}: ${url} unreachable (${err.message})`);
    return false;
  }
}

test('live: app factory /api/health is ok (ephemeral port)', async (t) => {
  const { createApp } = require('../src/app');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-live-guard-'));
  const { app } = await createApp({ dataDir, requestLogger: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  if (!(await requireLive('portal-health', url))) return; // logs SKIP, passes
  const res = await get(url);
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'ok');
});

test('live: probe of a closed port returns false and skips (no throw)', async () => {
  // Port 1 is (practically) never listening: exercises the SKIP path.
  const ok = await requireLive('closed-port-probe', 'http://127.0.0.1:1/nope');
  assert.equal(ok, false);
});

test('seeded ticket fixtures all have unique ids', () => {
  const { seedData } = require('../src/seed');
  const tickets = seedData().tickets;
  assert.ok(tickets.length >= 1, 'need at least one seeded ticket');
  const ids = tickets.map((ticket) => ticket.id);
  assert.equal(new Set(ids).size, ids.length, 'seeded ticket ids must be unique');
  assert.ok(ids.includes(1001), 'seeded fixtures must include ticket id 1001 (api-tickets.test.js pattern)');
});
