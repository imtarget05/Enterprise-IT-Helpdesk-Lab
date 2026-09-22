'use strict';

/**
 * UI contract test (tĩnh, không cần browser):
 *   1. Mọi `$('id')` / `getElementById('id')` trong app.js phải tồn tại trong index.html
 *      → chống lỗi typo DOM làm UI "chết im lặng" khi demo.
 *   2. Mọi id được tham chiếu trong onclick="fn(...)" phải có hàm tương ứng.
 *   3. CSS phải chứa class cho các thành phần mới (toast, skeleton, btn-export...).
 *   4. Không được còn fetch() thô (phải đi qua api()/apiJson() để có error handling).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('app.js chỉ tham chiếu id có thật trong index.html', () => {
  const referenced = new Set();
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) referenced.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) referenced.add(m[1]);

  assert.ok(referenced.size >= 20, `phải quét được nhiều id DOM, nhận ${referenced.size}`);
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `id không tồn tại trong HTML: ${missing.join(', ')}`);
});

test('index.html khai báo đủ phần tử then chốt của 4 phân hệ', () => {
  for (const id of ['tab-dashboard', 'tab-assets', 'tab-tickets', 'tab-licenses', 'assets-tbody', 'tickets-tbody', 'licenses-tbody', 'btn-export-assets', 'btn-export-tickets', 'toast-container']) {
    assert.ok(htmlIds.has(id), `thiếu #${id} trong index.html`);
  }
});

test('các hàm gọi từ onclick trong app.js đều được định nghĩa', () => {
  const handlers = new Set([...js.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]));
  assert.ok(handlers.size >= 3, 'phải tìm thấy các handler inline (updateAssetStatus, deleteAsset...)');
  for (const fn of handlers) {
    const declared = new RegExp(`(function ${fn}\\b|const ${fn} =|window\\.${fn} =)`).test(js);
    assert.ok(declared, `handler ${fn}() được render ra HTML nhưng không tồn tại trong app.js`);
  }
});

test('CSS chứa style cho các thành phần UI mới', () => {
  for (const cls of ['toast-container', '.toast', '.skeleton', '.btn-export', '.filter-select', '.sortable', '.bar-row', '.offline-banner', '.spinner', '.list-meta', '.row-actions']) {
    assert.ok(css.includes(cls), `styles.css thiếu "${cls}"`);
  }
});

test('CSS có responsive breakpoint + prefers-reduced-motion', () => {
  assert.ok(css.includes('@media (max-width: 768px)'), 'thiếu breakpoint mobile');
  assert.ok(css.includes('prefers-reduced-motion'), 'phải tôn trọng cài đặt giảm chuyển động của hệ điều hành');
});

test('app.js không còn fetch() thô ngoài tầng API (error handling tập trung)', () => {
  const occurrences = [...js.matchAll(/\bfetch\(/g)].length;
  assert.equal(occurrences, 1, 'chỉ hàm api() được phép gọi fetch()');
  const apiFn = js.slice(js.indexOf('async function api('));
  assert.ok(apiFn.slice(0, 700).includes('fetch('), 'fetch() phải nằm trong hàm api()');
});

test('mọi render ra HTML đều escapeHtml (chống XSS từ dữ liệu)', () => {
  const templateUses = [...js.matchAll(/\$\{escapeHtml\(/g)].length;
  assert.ok(templateUses >= 25, `mong đợi nhiều lần escapeHtml, nhận ${templateUses}`);
  // Không được nội suy thô biến dễ chứa HTML của người dùng
  for (const raw of ['${t.title}', '${a.tag}', '${a.assignedTo}', '${a.model}', '${l.software}']) {
    assert.ok(!js.includes(raw), `phải bọc escapeHtml cho ${raw}`);
  }
});
