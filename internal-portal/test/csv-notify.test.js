'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { toCsv, auditFilename } = require('../src/csv');
const { createNotifier } = require('../src/notify');

test('csv: xuống dòng đúng chuẩn RFC-4180 (CRLF + BOM cho Excel UTF-8)', () => {
  const csv = toCsv([{ a: 1, b: 'x' }], [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
  ]);
  assert.equal(csv.charCodeAt(0), 0xfeff, 'phải có BOM để Excel mở đúng tiếng Việt');
  assert.equal(csv.slice(1), '"A","B"\r\n"1","x"\r\n');
});

test('csv: escape dấu phẩy, nháy kép và xuống dòng trong ô', () => {
  const csv = toCsv(
    [
      { name: 'Nguyen, Van A', note: 'He said "ok"', multi: 'line1\nline2' },
    ],
    [
      { key: 'name', label: 'Name' },
      { key: 'note', label: 'Note' },
      { key: 'multi', label: 'Multi' },
    ]
  );
  const body = csv.replace(/^\uFEFF/, '');
  assert.ok(body.includes('"Nguyen, Van A"'), 'giá trị có dấu phẩy phải bọc nháy kép');
  assert.ok(body.includes('"He said ""ok"""'), 'nháy kép bên trong phải được nhân đôi');
  assert.ok(body.includes('"line1\nline2"'), 'giá trị có xuống dòng phải bọc nháy kép');
});

test('csv: giá trị null/undefined -> chuỗi rỗng, number/boolean thành text', () => {
  const csv = toCsv([{ a: null, b: undefined, c: 42, d: true }], [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C' },
    { key: 'd', label: 'D' },
  ]);
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0], '"A","B","C","D"');
  assert.equal(lines[1], '"","","42","true"');
});

test('csv: dataset rỗng vẫn trả header (file kiểm kê không bị trống hoàn toàn)', () => {
  const csv = toCsv([], [{ key: 'tag', label: 'Asset Tag' }]);
  assert.equal(csv.replace(/^\uFEFF/, ''), '"Asset Tag"\r\n');
});

test('csv: cột là function -> suy ra giá trị (computed column)', () => {
  const csv = toCsv([{ brand: 'Dell', model: 'Latitude' }], [
    { key: 'full', label: 'Machine', value: (row) => `${row.brand} ${row.model}` },
  ]);
  assert.ok(csv.includes('"Dell Latitude"'));
});

test('csv: auditFilename định dạng IT-Asset-Audit_YYYYMMDD_HHmm.csv', () => {
  const name = auditFilename('IT-Asset-Audit', new Date('2026-09-23T01:45:07'));
  assert.equal(name, 'IT-Asset-Audit_20260923_0145.csv');
});

// ---------------- Notifier ----------------

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'portal-notify-'));
}

test('notify: chỉ alert ticket High/Critical', async () => {
  const dir = await tmpDir();
  const n = createNotifier({ dataDir: dir });

  assert.equal(n.shouldAlert({ priority: 'High' }), true);
  assert.equal(n.shouldAlert({ priority: 'Critical' }), true);
  assert.equal(n.shouldAlert({ priority: 'Medium' }), false);
  assert.equal(n.shouldAlert({ priority: 'Low' }), false);
  assert.equal(n.shouldAlert(undefined), false);
});

test('notify: alert ghi log file + history có payload mô phỏng Telegram/Email', async () => {
  const dir = await tmpDir();
  const n = createNotifier({ dataDir: dir });

  const result = await n.alert({ id: 1006, title: 'Printer on fire', priority: 'High', requester: 'A', dept: 'Admin' });

  assert.equal(result.alerted, true);
  assert.equal(n.history().count, 1);
  const item = n.history().items[0];
  assert.equal(item.ticketId, 1006);
  assert.equal(item.channels.length, 2);
  assert.ok(item.message.includes('#1006'));
  assert.ok(/\bHIGH\b/.test(item.message), 'mức độ phải in hoa để nổi bật trên kênh alert');
  assert.equal(item.priority, 'High');

  const logFile = path.join(dir, 'notifications.log');
  const log = await fs.readFile(logFile, 'utf8');
  assert.ok(log.includes('Printer on fire'), 'phải lưu vết thông báo vào notifications.log');
});

test('notify: webhook URL lỗi không được làm sập request (deliver=false + lý do)', async () => {
  const dir = await tmpDir();
  const n = createNotifier({ dataDir: dir, webhookUrl: 'http://127.0.0.1:1/nope' });
  const result = await n.alert({ id: 1, title: 'x', priority: 'Critical' });

  assert.equal(result.alerted, true);
  assert.equal(result.delivered, false);
  assert.ok(result.deliveryError, 'phải ghi nhận lý do thất bại khi POST webhook');
  assert.equal(n.lastDelivery.ok, false);
});

test('notify: history trả mới nhất trước và tôn trọng limit', async () => {
  const dir = await tmpDir();
  const n = createNotifier({ dataDir: dir });
  await n.alert({ id: 11, title: 'first', priority: 'High' });
  await n.alert({ id: 22, title: 'second', priority: 'Critical' });
  await n.alert({ id: 33, title: 'third', priority: 'High' });

  const page = n.history(2);
  assert.equal(page.count, 3);
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items.map((i) => i.ticketId), [33, 22]);
});
