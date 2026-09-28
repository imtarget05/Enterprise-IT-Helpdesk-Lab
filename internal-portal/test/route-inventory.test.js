'use strict';

/**
 * Review Important 4 — the route inventory must be exhaustive and fail closed.
 *
 * These are the mutation fixtures the previous extractor could not handle. Each
 * writes a temporary Express-like source file and asserts the inventory result,
 * so a regression in quote handling, array registration, route chains, dynamic
 * templates, or path-in-variable is caught here rather than silently opening a
 * hole in duplicate detection, route coverage, and the OpenAPI gate at once.
 *
 * `assertUnresolvedIsEmpty` is the fail-closed contract: if the scanner meets a
 * registration it cannot resolve, the test fails loudly instead of skipping it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventoryFor, normalisePath, keyOf } = require('./route-inventory');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-route-inv-'));

function writeFixture(name, source) {
  const file = path.join(TMP_DIR, name);
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

function keysOf(file) {
  return inventoryFor([file]).routes.map(keyOf).sort();
}

function unresolvedOf(file) {
  return inventoryFor([file]).unresolved;
}

test('scanner nhan dien duoc single, double va backtick path', () => {
  const file = writeFixture('quotes.js', [
    "app.get('/api/single', h);",
    'app.post("/api/double", h);',
    'app.put(`/api/backtick`, h);',
  ].join('\n'));
  const keys = keysOf(file);
  assert.deepEqual(keys, ['GET /api/single', 'POST /api/double', 'PUT /api/backtick']);
  assert.equal(unresolvedOf(file).length, 0, 'khong duoc unresolved cho path literal');
});

test('scanner nhan dien router.get va app.route(...).get chain', () => {
  const file = writeFixture('router.js', [
    "const router = express.Router();",
    "router.get('/api/router-only', h);",
    "router.patch('/api/router-patch', h);",
    "app.route('/api/chained').get(h).post(h2).delete(h3);",
  ].join('\n'));
  const keys = keysOf(file);
  assert.ok(keys.includes('GET /api/router-only'), 'phai bat router.get');
  assert.ok(keys.includes('PATCH /api/router-patch'), 'phai bat router.patch');
  assert.ok(keys.includes('GET /api/chained'), 'phai bat app.route().get');
  assert.ok(keys.includes('POST /api/chained'), 'phai bat app.route().post');
  assert.ok(keys.includes('DELETE /api/chained'), 'phai bat app.route().delete');
  assert.equal(unresolvedOf(file).length, 0, 'router/chain deu phai resolve duoc');
});

test('scanner nhan dien array registration va tach thanh nhieu path', () => {
  const file = writeFixture('array.js', "app.get(['/api/a', '/api/b', '/api/c'], h);");
  const keys = keysOf(file);
  assert.deepEqual(keys, ['GET /api/a', 'GET /api/b', 'GET /api/c']);
  assert.equal(unresolvedOf(file).length, 0);
});

test('FAIL-CLOSED: path trong bien hoac template dong -> unresolved, khong bo qua im lang', () => {
  const variable = writeFixture('variable.js', [
    "const API = '/api/computed';",
    'app.get(API, h);',
  ].join('\n'));
  const unresolved = unresolvedOf(variable);
  assert.ok(unresolved.length >= 1, 'path trong bien phai duoc bao la unresolved');
  assert.ok(unresolved.some((u) => u.reason.includes('path-in-variable')), 'phai bao ly do path-in-variable');
  assert.ok(unresolved.every((u) => typeof u.line === 'number' && u.line > 0), 'unresolved phai giu file:line');

  const dynamic = writeFixture('dynamic.js', 'app.get(`/api/items/${id}`, h);');
  const dynUnresolved = unresolvedOf(dynamic);
  assert.ok(dynUnresolved.length >= 1, 'template co ${} phai duoc bao unresolved');
  assert.ok(dynUnresolved.some((u) => u.reason === 'dynamic-template'), 'phai bao ly do dynamic-template');
});

test('FAIL-CLOSED: chuoi trong comment va string khong duoc dem nhu route', () => {
  const file = writeFixture('noise.js', [
    "// app.get('/api/commented-out', h);",
    "/* app.post('/api/block-comment', h); */",
    "const s = \"app.get('/api/inside-string', h)\";",
    "app.get('/api/real', h);",
  ].join('\n'));
  const keys = keysOf(file);
  assert.deepEqual(keys, ['GET /api/real'], 'chi route that moi duoc dem');
});

test('duplicate qua nhieu style van bi bat', () => {
  const file = writeFixture('dup-styles.js', [
    "app.get('/api/same', h1);",
    'app.get("/api/same", h2);',
    'app.get(`/api/same`, h3);',
  ].join('\n'));
  const { routes } = inventoryFor([file]);
  const same = routes.filter((r) => normalisePath(r.path) === '/api/same');
  assert.equal(same.length, 3, 'ca 3 style deu phai duoc inventory');
  const keys = same.map(keyOf);
  assert.equal(new Set(keys).size, 1, 'tat ca deu la cung signature');
  assert.ok(same.every((r) => r.line > 0 && r.file.endsWith('dup-styles.js')), 'moi occurrence phai giu file:line');
});

test('scanner giu file:line cho moi registration', () => {
  const file = writeFixture('lines.js', [
    '// line 1',
    "app.get('/api/one', h);",
    '',
    "app.post('/api/two', h);",
  ].join('\n'));
  const { routes } = inventoryFor([file]);
  const one = routes.find((r) => r.path === '/api/one');
  const two = routes.find((r) => r.path === '/api/two');
  assert.equal(one.line, 2, 'route dong 2 phai bao line 2');
  assert.equal(two.line, 4, 'route dong 4 phai bao line 4');
});

test('source that giu nguyen inventory 55 route, khong unresolved', () => {
  const { routes, unresolved } = inventoryFor();
  assert.equal(unresolved.length, 0, `source that khong duoc phai resolve het, con ${unresolved.length} unresolved`);
  assert.ok(routes.length >= 50, `phai inventory it nhat 50 route, nhan ${routes.length}`);
  const keys = routes.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, 'source that khong duoc co duplicate');
});

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

// ---------------------------------------------------------------- review r2 #4
// Round 1's scanner only recognised `receiver` + `.` + `verb`. Valid JavaScript
// such as `app['get'](...)`, `router['post'](...)`, `app.get?.(...)` or
// `app?.[verb](...)` was therefore neither inventoried NOR reported unresolved,
// which is fail-OPEN: an empty inventory silently weakens every gate that reads
// it. These tests demand the opposite — inventory it if statically knowable,
// otherwise fail closed.
test('FAIL-CLOSED: computed member app[\'get\'] duoc inventory hoac bao unresolved', () => {
  const file = writeFixture('computed.js', "app['get']('/api/computed', h);");
  const { routes, unresolved } = inventoryFor([file]);
  const keys = routes.map(keyOf);
  if (keys.length === 0) {
    assert.ok(unresolved.length >= 1,
      'computed member call phai duoc inventory HOAC bao unresolved, khong duoc bo qua im lang');
    assert.ok(unresolved.some((u) => /computed/.test(u.reason)), `phai bao ly do computed, nhan ${JSON.stringify(unresolved)}`);
  } else {
    assert.deepEqual(keys, ['GET /api/computed'], 'computed member voi verb tinh phai inventory dung');
  }
});

test('FAIL-CLOSED: router[\'post\'] duoc inventory hoac bao unresolved', () => {
  const file = writeFixture('computed-router.js', "router['post']('/api/router-computed', h);");
  const { routes, unresolved } = inventoryFor([file]);
  const keys = routes.map(keyOf);
  if (keys.length === 0) {
    assert.ok(unresolved.length >= 1, 'router computed call phai bao unresolved');
  } else {
    assert.deepEqual(keys, ['POST /api/router-computed']);
  }
});

test('FAIL-CLOSED: optional call app.get?.(...) duoc inventory hoac bao unresolved', () => {
  const file = writeFixture('optional.js', "app.get?.('/api/optional', h);");
  const { routes, unresolved } = inventoryFor([file]);
  const keys = routes.map(keyOf);
  if (keys.length === 0) {
    assert.ok(unresolved.length >= 1, 'optional call phai bao unresolved');
  } else {
    assert.deepEqual(keys, ['GET /api/optional'], 'optional call voi duong dan tinh phai inventory dung');
  }
});

test('FAIL-CLOSED: computed verb dong app[verb] khong duoc im lang bo qua', () => {
  const file = writeFixture('dynamic-verb.js', "const verb = 'get';\napp[verb]('/api/dynamic-verb', h);");
  const { routes, unresolved } = inventoryFor([file]);
  assert.ok(routes.length + unresolved.length >= 1,
    `computed verb phai inventory hoac unresolved, nhan routes=${routes.length} unresolved=${unresolved.length}`);
  if (routes.length === 0) {
    assert.ok(unresolved.some((u) => u.line > 0), 'unresolved phai giu line');
  }
});

test('FAIL-CLOSED: optional computed app?.[verb] khong duoc im lang bo qua', () => {
  const file = writeFixture('optional-computed.js', "app?.['get']?.('/api/optional-computed', h);");
  const { routes, unresolved } = inventoryFor([file]);
  assert.ok(routes.length + unresolved.length >= 1,
    `optional computed phai inventory hoac unresolved, nhan routes=${routes.length} unresolved=${unresolved.length}`);
});

test('FAIL-CLOSED: scanner khong bao gio tra inventory rong cho source co route', () => {
  // A source that visibly contains route registrations must never yield an
  // empty result on both axes: that combination means the scanner gave up
  // silently, which is the exact failure mode under review.
  const file = writeFixture('silent-hole.js', [
    "app['get']('/api/a', h);",
    "app.get?.('/api/b', h);",
    "router['post']('/api/c', h);",
  ].join('\n'));
  const { routes, unresolved } = inventoryFor([file]);
  assert.ok(routes.length > 0 || unresolved.length > 0,
    'scanner khong duoc tra ve { routes: [], unresolved: [] } khi source co route registrations');
});

// ---------------------------------------------------------------- review r3 #4
// The round-2 scanner skipped only whitespace between the member and the call
// paren. A comment in that gap — `app.get /* gap */ ('/api/x', h)` — is valid
// JavaScript and was silently omitted, which disproves the module's "never
// skipped" claim and can hide a duplicate. It must be inventoried, or at worst
// reported unresolved. It must never be silently dropped.
test('FAIL-CLOSED: comment gap giua method va ( duoc inventory hoac unresolved', () => {
  const file = writeFixture('comment-gap.js', "app.get /* gap */ ('/api/comment-gap', h);");
  const { routes, unresolved } = inventoryFor([file]);
  const keys = routes.map(keyOf);
  if (keys.length === 0) {
    assert.ok(unresolved.length >= 1, 'comment-gap phai duoc inventory hoac bao unresolved, khong duoc bo qua im lang');
  } else {
    assert.deepEqual(keys, ['GET /api/comment-gap'], 'comment-gap voi duong dan tinh phai inventory dung');
  }
});

test('FAIL-CLOSED: comment gap tren computed member cung khong duoc bo qua', () => {
  const file = writeFixture('comment-gap-computed.js', "router['post'] /* gap */ ('/api/comment-gap-computed', h);");
  const { routes, unresolved } = inventoryFor([file]);
  assert.ok(routes.length + unresolved.length >= 1,
    `computed + comment gap phai inventory hoac unresolved, nhan routes=${routes.length} unresolved=${unresolved.length}`);
});

test('FAIL-CLOSED: nhieu comment lien tie giua method va ( van duoc xu ly', () => {
  const file = writeFixture('comment-gap-multi.js', "app.post /*a*/ /*b*/ ('/api/comment-gap-multi', h);");
  const { routes, unresolved } = inventoryFor([file]);
  assert.ok(routes.length + unresolved.length >= 1,
    `nhieu comment lien tie phai duoc xu ly, nhan routes=${routes.length} unresolved=${unresolved.length}`);
});

test('FAIL-CLOSED: newline truoc ( cung khong duoc bo qua', () => {
  const file = writeFixture('newline-gap.js', "app.delete\n  ('/api/newline-gap', h);");
  const { routes, unresolved } = inventoryFor([file]);
  assert.ok(routes.length + unresolved.length >= 1,
    `newline truoc ( phai duoc xu ly, nhan routes=${routes.length} unresolved=${unresolved.length}`);
});
