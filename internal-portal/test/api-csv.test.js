'use strict';

/** REST API — CSV export (báo cáo kiểm kê tài sản + ticket). */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient } = require('./helpers');

let c;
before(async () => {
  c = await createTestClient();
  await c.start();
});
after(() => c.cleanup());

test('GET /api/assets/export.csv → 200 text/csv + BOM + đúng số dòng', async () => {
  const res = await c.api('GET', '/api/assets/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="IT-Asset-Audit_\d{8}_\d{4}\.csv"/);
  assert.ok(Number(res.headers.get('x-total-records')) >= 6, 'phải trả số bản ghi qua header');

  // Lưu ý: Response.text() của fetch TỰ strip BOM → phải soi byte gốc để kiểm BOM.
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], 'CSV phải có UTF-8 BOM để Excel mở đúng tiếng Việt');

  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text.slice(1).trim().split('\r\n');
  const { data: assets } = await c.json('GET', '/api/assets');
  assert.equal(lines.length, assets.length + 1, 'số dòng CSV = total assets + header');
  assert.ok(lines[0].includes('Asset Tag'));
  assert.ok(lines.some((l) => l.includes('LP-IT-001')));
});

test('GET /api/assets/export.csv?status=In Storage → chỉ chứa dòng khớp filter', async () => {
  const res = await c.api('GET', '/api/assets/export.csv?status=In%20Storage');
  const text = await res.text();
  const lines = text.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 2, 'dataset mẫu có đúng 1 thiết bị In Storage');
  assert.ok(lines[1].includes('In Storage'));
});

test('CSV escape trường chứa dấu phẩy / nháy kép (serial, model có dấu phẩy)', async () => {
  await c.json('POST', '/api/assets', {
    tag: 'LP-QA-COMMA',
    brand: 'Dell, Inc.',
    model: 'Latitude "5420"',
    serial: 'COMMA-SER-1',
  });
  const res = await c.api('GET', '/api/assets/export.csv?q=LP-QA-COMMA');
  const text = await res.text();
  assert.ok(text.includes('"Dell, Inc."'), 'dấu phẩy phải được bọc nháy kép');
  assert.ok(text.includes('"Latitude ""5420"""'), 'nháy kép phải được nhân đôi');
});

test('GET /api/tickets/export.csv → báo cáo ticket đủ cột nghiệp vụ', async () => {
  const res = await c.api('GET', '/api/tickets/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /IT-Ticket-Report_\d{8}_\d{4}\.csv/);
  const text = await res.text();
  const header = text.slice(1).split('\r\n')[0];
  assert.match(header, /Ticket ID/);
  assert.match(header, /Priority/);
  assert.match(header, /Status/);
  assert.ok(text.includes('1001'));
});

test('CSV export không làm thay đổi dữ liệu (read-only)', async () => {
  const beforeList = await c.json('GET', '/api/assets');
  await c.api('GET', '/api/assets/export.csv');
  const afterList = await c.json('GET', '/api/assets');
  assert.equal(afterList.data.length, beforeList.data.length);
});
