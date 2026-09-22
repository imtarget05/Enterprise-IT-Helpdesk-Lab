'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createStore } = require('../src/store');
const { seedData } = require('../src/seed');

async function tmpDir(prefix = 'portal-store-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('store: seed khi data/db.json chưa tồn tại', async () => {
  const dir = await tmpDir();
  const store = createStore({ dataDir: dir });
  await store.load();

  assert.equal(store.seeded, true);
  assert.ok(store.data.assets.length >= 6, 'phải có dataset tài sản mẫu');
  assert.ok(store.data.tickets.length >= 6, 'phải có dataset ticket mẫu');
  assert.ok(store.data.licenses.length >= 4, 'phải có dataset license mẫu');
  assert.equal(await fs.readFile(store.file, 'utf8').then(Boolean), true, 'file db.json phải được ghi ra đĩa');
});

test('store: dữ liệu sống sót qua restart (commit -> load lại)', async () => {
  const dir = await tmpDir();
  const store = createStore({ dataDir: dir });
  await store.load();

  const created = {
    id: store.nextId('assets'),
    tag: 'LP-QA-900',
    type: 'Laptop',
    brand: 'Lenovo',
    model: 'ThinkPad X1',
    serial: 'QA-SERIAL-1',
    assignedTo: 'QA Bot',
    dept: 'IT Support',
    status: 'Active',
    ip: '192.168.10.200',
  };
  store.data.assets.unshift(created);
  await store.commit();

  // Giả lập khởi động lại process
  const reopened = createStore({ dataDir: dir });
  await reopened.load();

  assert.equal(reopened.seeded, false, 'đã có db.json thì không được seed đè');
  const hit = reopened.find('assets', created.id);
  assert.ok(hit, 'Asset mới tạo phải còn sau khi restart');
  assert.equal(hit.tag, 'LP-QA-900');
});

test('store: db.json hỏng -> backup .corrupt-* rồi seed, không ném exception', async () => {
  const dir = await tmpDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  await fs.writeFile(file, '{"assets": [ { broken json', 'utf8');

  const store = createStore({ dataDir: dir });
  await store.load();

  assert.equal(store.seeded, true);
  assert.ok(store.data.assets.length >= 6);

  const entries = await fs.readdir(dir);
  const backup = entries.filter((f) => f.startsWith('db.json.corrupt-'));
  assert.equal(backup.length, 1, 'phải lưu 1 bản backup của file hỏng');
  assert.equal(await fs.readFile(path.join(dir, backup[0]), 'utf8'), '{"assets": [ { broken json');
});

test('store: nextId tăng dần theo collection, find trả bản ghi theo id số', async () => {
  const dir = await tmpDir();
  const store = createStore({ dataDir: dir });
  await store.load();

  const maxAssetId = Math.max(...store.data.assets.map((a) => a.id));
  assert.equal(store.nextId('assets'), maxAssetId + 1);

  const maxTicketId = Math.max(...store.data.tickets.map((t) => t.id));
  assert.equal(store.nextId('tickets'), maxTicketId + 1);

  assert.equal(store.nextId('tickets', 5000), 5000, 'collection rỗng phải dùng start value');

  assert.equal(store.find('assets', String(maxAssetId)).id, maxAssetId);
  assert.equal(store.find('assets', 999999), undefined);
});

test('store: commit ghi tuần tự, lần load sau thấy bản ghi cuối cùng', async () => {
  const dir = await tmpDir();
  const store = createStore({ dataDir: dir });
  await store.load();

  await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      store.data.licenses.push({ id: 100 + i, software: `Sim Soft ${i}`, total: 5, assigned: 1, available: 4, renewalDate: '2027-01-01' });
      return store.commit();
    })
  );

  const reopened = createStore({ dataDir: dir });
  await reopened.load();
  assert.equal(reopened.data.licenses.length, store.data.licenses.length);
  assert.ok(reopened.data.licenses.some((l) => l.software === 'Sim Soft 11'));
});

test('store: snapshot có version + updatedAt ISO', async () => {
  const dir = await tmpDir();
  const store = createStore({ dataDir: dir });
  await store.load();
  await store.commit();

  const raw = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.ok(Date.parse(raw.updatedAt), 'updatedAt phải là ISO date hợp lệ');
  assert.ok(Array.isArray(raw.assets) && Array.isArray(raw.tickets) && Array.isArray(raw.licenses));
});

test('seed: cấu trúc dữ liệu mẫu hợp lệ (schema + ITIL realism)', () => {
  const data = seedData();
  for (const a of data.assets) {
    assert.ok(a.id > 0 && a.tag && a.type && a.brand && a.model && a.serial, 'asset đủ trường');
    assert.ok(['Active', 'In Storage', 'Maintenance', 'Retired'].includes(a.status), `status lạ: ${a.status}`);
  }
  for (const t of data.tickets) {
    assert.ok(t.id >= 1001 && t.title && t.requester && t.dept, 'ticket đủ trường');
    assert.ok(['Open', 'In Progress', 'Resolved', 'Closed'].includes(t.status), `status ticket lạ: ${t.status}`);
    assert.ok(['Low', 'Medium', 'High', 'Critical'].includes(t.priority), `priority ticket lạ: ${t.priority}`);
  }
  for (const l of data.licenses) {
    assert.equal(Number.isInteger(l.total), true);
    assert.equal(l.available, l.total - l.assigned, 'available phải tính được từ total - assigned');
  }
});
