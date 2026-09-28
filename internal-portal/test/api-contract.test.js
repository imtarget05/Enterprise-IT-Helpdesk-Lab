'use strict';

/**
 * Contract test: OpenAPI <-> runtime/source routes <-> UI mapping.
 *
 * Part A (H-05): source registration must not contain duplicate signatures.
 * The duplicate assertion runs on the RAW list (every registration kept), so a
 * dedupe in the inventory cannot hide a shadowed handler.
 *
 * Part B (contract): OpenAPI paths must match the unique runtime/source set
 * (minus the self-document endpoint), operationIds must be unique + non-empty,
 * and every endpoint the UI calls must exist in the backend set.
 *
 * These assertions are decided by parsing the real files and the real route
 * registrations — not by grepping for a magic constant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRawSourceRoutes, listSourceRoutes, findDuplicateSignatures, normalisePath, PORTAL_ROOT } = require('./list-routes');

const OPENAPI_FILE = path.join(PORTAL_ROOT, 'public', 'openapi.yaml');
const UI_FILE = path.join(PORTAL_ROOT, 'public', 'app.js');
const openapi = fs.readFileSync(OPENAPI_FILE, 'utf8');
const ui = fs.readFileSync(UI_FILE, 'utf8');

// NOTE (review Minor 2): there is NO `GET /api/openapi.json` route in this app.
// `public/openapi.yaml` is the spec, and `src/app.js` only mounts the public
// directory statically, so nothing serves that URL as JSON. An earlier revision
// excluded the key from the runtime set on the false assumption that the route
// existed. That exclusion is removed: if the key is ever documented in OpenAPI
// or registered in source, the comparison below must report it as a mismatch
// instead of silently dropping it. Both sides are now compared with no
// exemptions.
const SELF_DOCUMENT = null;

// ---------- OpenAPI parsing (minimal, path/method/operationId only) ----------

function parseOpenApiPaths(src) {
  const lines = src.split('\n');
  const paths = new Map();
  let inPaths = false;
  let currentPath = null;
  let currentMethod = null;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^\S/.test(line)) { inPaths = false; currentPath = null; currentMethod = null; }
    if (!inPaths) continue;
    const pathMatch = line.match(/^ {2}(\/[^:]*):\s*$/);
    if (pathMatch) { currentPath = pathMatch[1]; currentMethod = null; if (!paths.has(currentPath)) paths.set(currentPath, new Map()); continue; }
    const methodMatch = line.match(/^ {4}(get|post|put|patch|delete|head|options):\s*$/i);
    if (methodMatch && currentPath) { currentMethod = methodMatch[1].toLowerCase(); if (!paths.get(currentPath).has(currentMethod)) paths.get(currentPath).set(currentMethod, {}); continue; }
    const opMatch = line.match(/^ {6}operationId:\s*(\S+)\s*$/);
    if (opMatch && currentPath && currentMethod) {
      paths.get(currentPath).get(currentMethod).operationId = opMatch[1];
    }
  }
  return paths;
}

const openapiPaths = parseOpenApiPaths(openapi);

// OpenAPI dùng {id}; Express dùng :id. Chuẩn hoá về cùng convention trước khi so.
function openApiPathToExpress(p) {
  return p.replace(/\{([^}]+)\}/g, ':$1');
}

function openApiSignatureSet() {
  const set = new Set();
  for (const [p, methods] of openapiPaths) for (const [method] of methods) set.add(`${method.toUpperCase()} ${normalisePath(openApiPathToExpress(p))}`);
  return set;
}

// ---------- runtime/source route sets ----------

const rawRoutes = listRawSourceRoutes();
const uniqueRoutes = listSourceRoutes();
const backendSet = new Set(uniqueRoutes.map((r) => `${r.method} ${normalisePath(r.path)}`));

// ---------- Part A: duplicate signature detection ----------

test('H-05: source registration khong co duplicate route signature', () => {
  const duplicates = findDuplicateSignatures();
  if (duplicates.length > 0) {
    const detail = duplicates
      .map((d) => {
        const occ = d.occurrences.map((o) => `${o.method} ${o.path} ${o.file}:${o.line}`).join('\n      ');
        return `  ${d.method} ${d.path} (${d.occurrences.length} registrations)\n      ${occ}`;
      })
      .join('\n');
    assert.fail(`duplicate_signatures.length = ${duplicates.length}, mong doi 0:\n${detail}`);
  }
  assert.equal(findDuplicateSignatures().length, 0, 'duplicate_signatures.length phai bang 0');
});

test('H-05: /api/tickets/export.csv va /api/tickets/:id la hai signature khac nhau', () => {
  // Sanity on the normaliser that powers duplicate detection: a literal segment
  // must not collapse into a param route.
  const exportKeys = rawRoutes.filter((r) => r.path.includes('export.csv')).map((r) => r.key);
  const paramKeys = rawRoutes.filter((r) => r.path === '/api/tickets/:id').map((r) => r.key);
  for (const k of exportKeys) {
    assert.ok(!paramKeys.includes(k), `export.csv khong được trùng signature với /api/tickets/:id (${k})`);
  }
  assert.ok(exportKeys.length > 0, 'phai tim thay GET /api/tickets/export.csv trong source');
});

test('H-05: trailing slash duoc normalise de bat duplicate dang /x/ vs /x', () => {
  assert.equal(normalisePath('/api/assets/'), '/api/assets');
  assert.equal(normalisePath('/api/assets'), '/api/assets');
  // The break: a normaliser that ignored trailing slashes would let
  // `GET /api/assets` + `GET /api/assets/` register as two distinct routes.
  // Prove detection works on a synthetic source that contains exactly that pair.
  const synthetic = path.join(os.tmpdir(), `w1-trailing-slash-${process.pid}.js`);
  fs.writeFileSync(synthetic, "app.get('/api/assets', h1);\napp.get('/api/assets/', h2);\n");
  try {
    const dups = findDuplicateSignatures([synthetic]);
    assert.equal(dups.length, 1, 'normaliser phai bat duplicate /api/assets vs /api/assets/');
    assert.equal(dups[0].method, 'GET');
    assert.equal(dups[0].path, '/api/assets');
  } finally {
    fs.rmSync(synthetic, { force: true });
  }
  // And the real source must be clean for that same key.
  const real = rawRoutes.filter((r) => r.key === 'GET /api/assets');
  assert.ok(real.length >= 1, 'GET /api/assets phai duoc dang ky it nhat mot lan');
});

// ---------- Part B: OpenAPI <-> runtime contract ----------

test('contract: OpenAPI paths bang runtime/source route set (khong loai tru route nao)', () => {
  const exemptSet = new Set(SELF_DOCUMENT === null ? [] : [SELF_DOCUMENT]);
  const openApiSet = new Set([...openApiSignatureSet()].filter((k) => !exemptSet.has(k)));
  // No exemptions. SELF_DOCUMENT is null because no such route exists, so the
  // filter keeps every real route; if a route is ever exempted, the exemption
  // must be removed from BOTH sides, not just the runtime set.
  const exempt = new Set(SELF_DOCUMENT === null ? [] : [SELF_DOCUMENT]);
  const runtimeSet = new Set([...backendSet].filter((k) => !exempt.has(k)));
  const onlyInOpenApi = [...openApiSet].filter((k) => !runtimeSet.has(k)).sort();
  const onlyInRuntime = [...runtimeSet].filter((k) => !openApiSet.has(k)).sort();
  assert.equal(
    onlyInOpenApi.length + onlyInRuntime.length,
    0,
    `runtime_openapi_diffs != 0\n  chi trong OpenAPI: ${onlyInOpenApi.join(', ') || '(none)'}\n  chi trong runtime: ${onlyInRuntime.join(', ') || '(none)'}`
  );
});

test('contract: moi operationId unique va khong rong', () => {
  const ids = new Map();
  const missing = [];
  for (const [p, methods] of openapiPaths) {
    for (const [method, op] of methods) {
      const id = op.operationId;
      if (!id) { missing.push(`${method.toUpperCase()} ${p}`); continue; }
      if (ids.has(id)) { missing.push(`${id} trùng: ${ids.get(id)} vs ${method.toUpperCase()} ${p}`); continue; }
      ids.set(id, `${method.toUpperCase()} ${p}`);
    }
  }
  assert.equal(missing.length, 0, `operationId rong/trung:\n  ${missing.join('\n  ')}`);
});

test('contract: static UI endpoint literals deu thuoc backend set', () => {
  const called = [...ui.matchAll(/apiJson\(\s*[`'"]([^`'"$]+)/g)]
    .map((m) => m[1])
    .concat([...ui.matchAll(/downloadFile\(\s*`([^`'"$]+)/g)].map((m) => m[1]));
  const missing = [];
  for (const raw of called) {
    const p = raw.split('?')[0].replace(/\/1$/, '/:id');
    const normalised = normalisePath(p);
    const ok = backendSet.has(`${'GET'} ${normalised}`) || [...backendSet].some((k) => k.endsWith(` ${normalised}`));
    if (!ok) missing.push(raw);
  }
  assert.equal(missing.length, 0, `ui_backend_route_diffs != 0; UI goi route khong ton tai: ${missing.join(', ')}`);
});
