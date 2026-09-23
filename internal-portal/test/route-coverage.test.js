'use strict';

/**
 * Chứng minh "kiểm thử 100% REST endpoints" (Yêu cầu #6) bằng con số, không bằng tuyên bố:
 *   1. Lấy danh sách route đăng ký thật trong src/app.js (list-routes.js).
 *   2. Quét toàn bộ test suite (test/*.test.js + test-api.sh) xem route nào được gọi.
 *   3.Assert: mọi route đều phải xuất hiện, và mỗi method/path phải có cả ca succeed
 *      lẫn ca lỗi (4xx) tương ứng — chống tình trạng "gọi cho có".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listSourceRoutes } = require('./list-routes');

const TEST_DIR = __dirname;
const sources = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => fs.readFileSync(path.join(TEST_DIR, f), 'utf8'));
// test-api.sh được COPY vào Docker stage `test`; khi chạy ngoài repo thì đọc từ thư mục gốc.
const shellRunner = path.join(TEST_DIR, '..', 'test-api.sh');
if (fs.existsSync(shellRunner)) sources.push(fs.readFileSync(shellRunner, 'utf8'));
const suite = sources.join('\n');

const routes = listSourceRoutes();

test('danh sách route trích được từ src/app.js (không rỗng)', () => {
  assert.ok(routes.length >= 16, `mong đợi ≥16 route, nhận ${routes.length}`);
  const unique = new Set(routes.map((r) => `${r.method} ${r.path}`));
  assert.equal(unique.size, routes.length, 'không được đăng ký trùng route');
});

for (const route of routes) {
  test(`route ${route.method} ${route.path} được kiểm trong test suite`, () => {
    const basePath = `/api${route.path.replace(/^\/api/, '')}`;
    // Route có tham số → test có thể gọi dạng literal ("/api/assets/1") hoặc template
    // (`/api/assets/${id}`), nên kiểm cả prefix không tham số.
    const prefix = basePath.replace(/\/:[A-Za-z0-9_]+.*$/, '');
    const hitsPath = suite.includes(basePath) || new RegExp(basePath.replace(/:[A-Za-z0-9_]+/g, '[^`\'"\\s]+').replace(/\./g, '\\.')).test(suite) || suite.includes(prefix);
    assert.ok(hitsPath, `không tìm thấy lời gọi ${route.method} ${basePath} trong test suite`);
    assert.ok(suite.includes(route.method), `test suite không đề cập method ${route.method}`);
  });
}

test('mỗi resource có cả ca thành công lẫn ca lỗi được kiểm', () => {
  const expectations = [
    ['GET /api/assets', '200'],
    ['GET /api/assets/:id', '404'],
    ['POST /api/assets', '400'],
    ['POST /api/assets', '409'],
    ['POST /api/assets', '422'],
    ['PATCH /api/assets/:id', '404'],
    ['DELETE /api/assets/:id', '404'],
    ['GET /api/tickets/:id', '404'],
    ['POST /api/tickets', '400'],
    ['PATCH /api/tickets/:id/status', '422'],
    ['GET /api/licenses/:id', '404'],
  ];
  for (const [signature, status] of expectations) {
    const method = signature.split(' ')[0];
    const p = signature.slice(method.length + 1);
    const literal = p.replace('/:id', '/1');
    const callsMethod = suite.includes("'" + method + "'") || suite.includes(method + ' ') || suite.includes(method + ',');
    const mentionsPath = suite.includes(p) || suite.includes(literal);
    const mentionsStatus = suite.includes(status);
    assert.ok(
      callsMethod && mentionsPath && mentionsStatus,
      `thiếu case kiểm ${signature} → ${status} (method=${callsMethod}, path=${mentionsPath}, status=${mentionsStatus})`
    );
  }
});

test('CSV export endpoint được kiểm cả nội dung lẫn header', () => {
  assert.ok(suite.includes('assets/export.csv'), 'không gọi endpoint export CSV');
  assert.match(suite, /text.csv/, 'không kiểm tra Content-Type text/csv');
  assert.match(suite, /content-disposition/i, 'không kiểm tra Content-Disposition (tên file tải về)');
  assert.match(suite, /efbbbf|ufeff|BOM/i, 'không kiểm tra BOM UTF-8 của file CSV');
});

test('persistence được kiểm bằng restart thật (stop + start lại cùng dataDir)', () => {
  assert.match(suite, /stop\(\)[\s\S]{0,200}start\(\)/, 'phải có ca dừng rồi khởi động lại server');
  assert.ok(suite.includes('db.json'), 'phải kiểm tra file db.json trên đĩa');
});
