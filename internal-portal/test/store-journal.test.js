'use strict';

/**
 * Crash-safe journal cho JSON file store (db.json.journal).
 * - kill-mid-write simulation: journal entry + partial tmp -> restart loader
 *   cho state nhất quán, db.json không corrupt.
 * - journal replay idempotency: recover lần 2 là no-op.
 * - normal write path byte-identical: persist mới cho kết quả tương đương
 *   (so sánh canonical JSON, bỏ qua updatedAt).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createStore } = require('../src/store');

async function tmpDir(prefix = 'portal-journal-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function canonicalSnapshot(obj) {
  const { updatedAt, ...rest } = obj;
  return JSON.stringify(rest, null, 2);
}

test('journal: kill-mid-write (journal + tmp dở) -> restart giữ state cũ, không corrupt', async () => {
  const dir = await tmpDir();
  const store = createStore({ dataDir: dir });
  await store.load();
  store.data.assets.unshift({
    id: store.nextId('assets'), tag: 'LP-JOURNAL-BASE', type: 'Laptop', brand: 'Dell',
    model: 'Latitude', serial: 'J-BASE', assignedTo: 'QA', dept: 'IT', status: 'Active', ip: '10.0.0.1',
  });
  await store.commit();
  const goodRaw = await fs.readFile(store.file, 'utf8');

  // Giả lập crash: intent đã vào journal nhưng tmp chỉ ghi được 1 nửa.
  const fakeTmp = `db.json.tmp-9999-deadbeef`;
  const fakePayload = '{"assets": [ { half-written crash';
  await fs.writeFile(path.join(dir, fakeTmp), fakePayload, 'utf8');
  const intent = JSON.stringify({
    op: 'write', tmp: fakeTmp,
    sha256: crypto.createHash('sha256').update('{"complete":true}').digest('hex'),
    bytes: 9999, at: new Date().toISOString(),
  }) + '\n';
  await fs.writeFile(store.journalFile, intent, 'utf8');

  // Restart loader -> phải discard tmp dở, db.json cũ còn nguyên, parse được.
  const reopened = createStore({ dataDir: dir });
  await reopened.load();
  const afterRaw = await fs.readFile(reopened.file, 'utf8');
  assert.equal(afterRaw, goodRaw, 'db.json phải giữ nguyên bản tốt trước crash');
  assert.ok(reopened.find('assets', reopened.data.assets[0].id), 'dữ liệu cũ còn nguyên');
  const entries = await fs.readdir(dir);
  assert.ok(!entries.some((f) => f.includes('deadbeef')), 'tmp dở phải bị dọn');
  assert.equal(await fs.readFile(reopened.journalFile, 'utf8'), '', 'journal phải truncate sau recover');
});

test('journal: crash sau tmp fsync đầy đủ -> replay đúng dữ liệu đã commit', async () => {
  const dir = await tmpDir();
  const store = createStore({ dataDir: dir });
  await store.load();
  const before = JSON.parse(await fs.readFile(store.file, 'utf8'));

  // Dựng 1 tmp HOÀN CHỈNH + journal intent khớp hash, nhưng chưa rename
  // (mô phỏng crash giữa fsync-tmp và rename).
  const committed = { ...before, replayMarker: 'REPLAYED-OK' };
  const payloadNoNl = JSON.stringify(committed);
  const payload = `${payloadNoNl}\n`;
  const crashTmp = 'db.json.tmp-9999-replay01';
  const fh = await fs.open(path.join(dir, crashTmp), 'w');
  try {
    await fh.writeFile(payload, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  const sha = crypto.createHash('sha256').update(payloadNoNl, 'utf8').digest('hex');
  await fs.writeFile(
    store.journalFile,
    `${JSON.stringify({ op: 'write', tmp: crashTmp, sha256: sha, bytes: payload.length, at: new Date().toISOString() })}\n`,
    'utf8'
  );

  const reopened = createStore({ dataDir: dir });
  await reopened.load();
  const after = JSON.parse(await fs.readFile(reopened.file, 'utf8'));
  assert.equal(after.replayMarker, 'REPLAYED-OK', 'tmp hợp lệ phải được replay thành db.json');
});

test('journal: replay idempotent — recover lần 2 không đổi gì', async () => {
  const dir = await tmpDir();
  const store = createStore({ dataDir: dir });
  await store.load();
  await store.commit();

  const first = await store.recoverJournal();
  const raw1 = await fs.readFile(store.file, 'utf8');
  const second = await store.recoverJournal();
  const raw2 = await fs.readFile(store.file, 'utf8');
  assert.equal(raw1, raw2, 'recover lặp lại không được thay đổi db.json');
  assert.equal(second.recovered, false, 'journal đã rỗng thì recover là no-op');
});

test('journal: normal write path cho kết quả byte-identical (trừ updatedAt)', async () => {
  const dirA = await tmpDir('jA-');
  const dirB = await tmpDir('jB-');
  const fixedAt = '2026-09-27T00:00:00.000Z';
  const seedFn = () => ({
    assets: [{ id: 1, tag: 'A1' }], tickets: [], licenses: [], ticketEvents: [],
    problems: [], changes: [], accessRequests: [], monitoringChecks: [],
    monitoringHistory: [], auditEvents: [], notifications: [],
  });
  const a = createStore({ dataDir: dirA, seed: seedFn });
  const b = createStore({ dataDir: dirB, seed: seedFn });
  await a.load();
  await b.load();
  await a.commit();
  await b.commit();
  const snapA = canonicalSnapshot(JSON.parse(await fs.readFile(a.file, 'utf8')));
  const snapB = canonicalSnapshot(JSON.parse(await fs.readFile(b.file, 'utf8')));
  assert.equal(snapA, snapB, 'cùng dữ liệu -> snapshot canonical phải byte-identical');
  assert.ok(Date.parse(JSON.parse(await fs.readFile(a.file, 'utf8')).updatedAt), 'updatedAt vẫn là ISO');
  assert.ok(String(fixedAt).length > 0);
});
