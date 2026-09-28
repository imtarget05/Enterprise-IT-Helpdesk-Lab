'use strict';

/**
 * Review Important 3 — the OpenAPI ↔ runtime ↔ DTO ↔ UI contract gate.
 *
 * The previous gate compared only method/path sets and operationId presence. It
 * made no assertion about request DTO fields, response schemas, or the UI's
 * actual request wrappers, so a documented-but-unimplemented field (or a
 * runtime field the spec never declared) passed silently.
 *
 * Each test below covers ONE root cause so a failure names exactly what broke:
 *   1. request DTO fields required by the plan
 *   2. response schemas for every mandatory resource group
 *   3. UI endpoint extraction through every wrapper (incl. dynamic builders)
 *   4. operationId naming convention (review Minor 1)
 *
 * Assertions parse the real OpenAPI file and the real UI source. They are
 * static contract checks; the behavioural side is covered by the HTTP tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSourceRoutes, normalisePath, PORTAL_ROOT } = require('./list-routes');
const { createTestClient } = require('./helpers');

const OPENAPI = fs.readFileSync(path.join(PORTAL_ROOT, 'public', 'openapi.yaml'), 'utf8');
const UI = fs.readFileSync(path.join(PORTAL_ROOT, 'public', 'app.js'), 'utf8');

// ---------- minimal OpenAPI model: paths -> methods -> operation ----------

// Parse the real document with the `yaml` package. The round-1/round-2
// line-oriented parser accepted documents a real parser rejects (a stray
// indented mapping, a duplicate `AuditEvent` key), so every gate built on it was
// structurally incapable of failing on malformed YAML.
const YAML = require('yaml');
const OPENAPI_DOC = YAML.parse(OPENAPI, { uniqueKeys: true });

/** Resolve a local `#/components/schemas/Name` reference. */
function deref(node) {
  if (node && typeof node === 'object' && typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) {
    return OPENAPI_DOC.components.schemas[node.$ref.slice('#/components/schemas/'.length)] || null;
  }
  return node || null;
}

/**
 * Response schema PER STATUS CODE. The old parser kept a single
 * `responseSchema` taken from the first ref anywhere under `responses`, so
 * removing MiniERP's 200 ref while leaving its 201 ref still produced
 * `MiniERPIncident` and passed. Each status code is now an independent slot.
 */
function responseSchemaFor(path, method, statusCode) {
  const entry = OPENAPI_DOC.paths[path] && OPENAPI_DOC.paths[path][method];
  if (!entry || !entry.responses) return undefined;
  const node = entry.responses[String(statusCode)];
  const schema = node && node.content && node.content['application/json'] && node.content['application/json'].schema;
  return schema ? schema.$ref : undefined;
}

/** Path/method/operationId model, derived from the parsed document. */
function parseOpenApi() {
  const paths = new Map();
  for (const [p, methods] of Object.entries(OPENAPI_DOC.paths || {})) {
    const map = new Map();
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      const requestSchema = op.requestBody && op.requestBody.content
        && op.requestBody.content['application/json'] && op.requestBody.content['application/json'].schema;
      map.set(method, {
        operationId: op.operationId || null,
        requestSchema: requestSchema ? (requestSchema.$ref ? requestSchema.$ref.split('/').pop() : 'inline') : null,
        responseSchemas: Object.fromEntries(Object.entries(op.responses || {}).map(([code, node]) => {
          const s = node && node.content && node.content['application/json'] && node.content['application/json'].schema;
          return [code, s ? (s.$ref || s.type || 'inline') : null];
        })),
      });
    }
    paths.set(p, map);
  }
  return paths;
}

const OPENAPI_PATHS = parseOpenApi();

/** Read a named component schema's direct `properties:` keys (one level). */
function schemaProperties(name) {
  const schema = OPENAPI_DOC.components && OPENAPI_DOC.components.schemas && OPENAPI_DOC.components.schemas[name];
  if (!schema || !schema.properties) return null;
  return new Set(Object.keys(schema.properties));
}

function hasSchema(name) {
  return Boolean(OPENAPI_DOC.components && OPENAPI_DOC.components.schemas && OPENAPI_DOC.components.schemas[name]);
}

function operation(p, method) {
  const ep = OPENAPI_PATHS.get(p);
  return ep ? ep.get(method) || null : null;
}

const toExpress = (p) => normalisePath(p.replace(/\{([^}]+)\}/g, ':$1'));
const offlineNotifier = () => ({
  webhookUrl: null,
  lastDelivery: null,
  history: () => ({ count: 0, items: [] }),
  alert: () => ({ alerted: false, reason: 'test-offline' }),
});

// ---------------------------------------------------------------- group 1
// Request DTO fields required by the plan (Task 4.4 item 3).
const REQUEST_FIELD_CONTRACT = [
  { path: '/api/assets', method: 'post', schema: 'AssetInput', fields: ['assetTag', 'type', 'serial', 'employee', 'status'], label: 'asset create' },
  { path: '/api/tickets', method: 'post', schema: 'TicketInput', fields: ['title', 'description', 'priority', 'category'], label: 'ticket create' },
  { path: '/api/tickets/{id}/status', method: 'patch', schema: 'TicketStatusUpdateInput', fields: ['status', 'note'], label: 'ticket status update' },
  { path: '/api/integrations/minierp/incidents', method: 'post', schema: 'MiniERPIncidentInput', fields: ['source', 'externalRef', 'title', 'description', 'severity'], label: 'MiniERP incident' },
];

test('request DTO: AssetInput/TicketInput/status/incident khai bao du field theo contract', () => {
  const missing = [];
  for (const entry of REQUEST_FIELD_CONTRACT) {
    const op = operation(entry.path, entry.method);
    if (!op) { missing.push(`${entry.label}: operation ${entry.method.toUpperCase()} ${entry.path} khong ton tai trong OpenAPI`); continue; }
    if (op.requestSchema !== entry.schema) { missing.push(`${entry.label}: operation khong $ref schema ${entry.schema} (dang la ${op.requestSchema || 'khong co'})`); continue; }
    const props = schemaProperties(entry.schema);
    if (!props) { missing.push(`${entry.label}: schema ${entry.schema} khong tim thay`); continue; }
    for (const field of entry.fields) if (!props.has(field)) missing.push(`${entry.label} (${entry.schema}): thieu field "${field}"`);
  }
  assert.equal(missing.length, 0, `request DTO khong khop runtime:\n  ${missing.join('\n  ')}`);
});

// ---------------------------------------------------------------- group 2
// Mandatory response schema groups.
const RESPONSE_SCHEMA_GROUPS = [
  { name: 'Asset', check: 'asset create/get response' },
  { name: 'Ticket', check: 'ticket create/get response' },
  { name: 'License', check: 'license list' },
  { name: 'Problem', check: 'problem list' },
  { name: 'Change', check: 'change list' },
  { name: 'AccessRequest', check: 'access request list' },
  { name: 'MonitoringCheck', check: 'monitoring checks' },
  { name: 'AuditEvent', check: 'audit events' },
  { name: 'AiStatus', check: 'ai status' },
  { name: 'MiniERPIncident', check: 'MiniERP incident' },
];

test('response DTO: moi resource group co schema trong components', () => {
  const missing = RESPONSE_SCHEMA_GROUPS.filter((g) => !hasSchema(g.name)).map((g) => `${g.name} (${g.check})`);
  assert.equal(missing.length, 0, `schema response thieu:\n  ${missing.join('\n  ')}`);
});

test('response DTO: monitoring status/history va audit co schema, khong phai response trong', () => {
  // The UI reads monitoring.checks/up/down/degraded and audit.items/count.
  const must = [
    { path: '/api/monitoring/status', fields: ['checks', 'up', 'down', 'degraded'], label: 'GET /api/monitoring/status' },
    { path: '/api/audit', fields: ['items', 'count'], label: 'GET /api/audit' },
  ];
  const missing = [];
  for (const entry of must) {
    const op = operation(entry.path, 'get');
    if (!op) { missing.push(`${entry.label}: operation khong ton tai`); continue; }
    const ref = responseSchemaFor(entry.path, 'get', '200');
    if (!ref) { missing.push(`${entry.label}: response 200 chua $ref schema`); continue; }
    const name = ref.split('/').pop();
    const props = schemaProperties(name);
    if (!props) { missing.push(`${entry.label}: schema ${name} khong tim thay`); continue; }
    for (const f of entry.fields) if (!props.has(f)) missing.push(`${entry.label} (${op.responseSchema}): thieu field "${f}"`);
  }
  assert.equal(missing.length, 0, `response schema khong khop UI:\n  ${missing.join('\n  ')}`);
});

// ---------------------------------------------------------------- group 3
// UI endpoint extraction through every wrapper.
const backendSet = new Set(listSourceRoutes().map((r) => `${r.method} ${normalisePath(r.path)}`));

/** Every wrapper that ends up issuing a request. */
const UI_WRAPPERS = ['apiJson', 'load', 'downloadFile', 'exportCsv'];

function extractUiEndpoints() {
  const found = [];
  for (const wrapper of UI_WRAPPERS) {
    const callRe = new RegExp('\\b' + wrapper + '\\s*\\(', 'g');
    let cm;
    while ((cm = callRe.exec(UI)) !== null) {
      // Walk the balanced argument list: the path is not always the first
      // argument (exportCsv(button, path, ...)), and downloadFile is reached
      // through a variable, so every wrapper must be scanned, not just the
      // direct apiJson/load literals the previous extractor looked at.
      const open = cm.index + cm[0].length - 1;
      let depth = 0;
      let end = open;
      for (let i = open; i < UI.length; i += 1) {
        if (UI[i] === '(') depth += 1;
        else if (UI[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      const body = UI.slice(open + 1, end);
      const litRe = /[`'"]((?:\/api\/)[^`'"\s]*)[`'"]/g;
      let lm;
      while ((lm = litRe.exec(body)) !== null) {
        let path = lm[1].split('?')[0];
        // Dynamic template: `/api/tickets/${id}/status` -> `/api/tickets/:id/status`
        // `${...}` is a path segment ONLY when it directly follows '/'
        // (e.g. `/api/tickets/${id}/status`). Otherwise it is a query-string
        // builder appended to a complete path (e.g. `/api/assets/export.csv${qs(..)}`).
        path = path.replace(/\/\$\{[^}]*\}/g, '/:id');
        const q = path.indexOf('/:');
        path = path.replace(/\$\{[^}]*\}.*$/, '');
        found.push({ wrapper, path: normalisePath(path) });
      }
    }
  }
  return found;
}

test('UI extractor quét duoc moi wrapper va it nhat 15 endpoint', () => {
  const found = extractUiEndpoints();
  const wrappersHit = new Set(found.map((f) => f.wrapper));
  // downloadFile is called with a variable (`downloadFile(path, ...)` inside
  // exportCsv), so it carries no literal of its own. It is covered transitively:
  // every exportCsv call site is extracted, and that is the only way a
  // downloadFile request can be issued.
  const literalWrappers = UI_WRAPPERS.filter((w) => w !== 'downloadFile');
  for (const w of literalWrappers) assert.ok(wrappersHit.has(w), `wrapper ${w} phai duet quet, hien chi thay ${[...wrappersHit].join(', ')}`);
  assert.ok(UI.includes('downloadFile(path'), 'downloadFile van phai duoc goi qua bien trong exportCsv');
  assert.ok(wrappersHit.has('exportCsv'), 'exportCsv phai dua literal path vao downloadFile');
  assert.ok(found.length >= 15, `phai rut it nhat 15 endpoint tu UI, nhan ${found.length}`);
});

test('mọi endpoint UI goi deu ton tai trong backend (ke ca dynamic :id va subresource)', () => {
  const found = extractUiEndpoints();
  const missing = [];
  for (const { wrapper, path } of found) {
    if (![...backendSet].some((k) => k.endsWith(` ${path}`))) missing.push(`${wrapper} -> ${path}`);
  }
  assert.equal(missing.length, 0, `UI goi route backend khong co:\n  ${missing.join('\n  ')}`);
});

test('UI dynamic builder phai resolve dung item + status subresource', () => {
  const found = extractUiEndpoints();
  const must = ['/api/assets/:id', '/api/tickets/:id/status', '/api/assets/export.csv', '/api/tickets/export.csv'];
  for (const path of must) {
    assert.ok(found.some((f) => f.path === path), `UI phai goi ${path} (template dong), hien rut duoc: ${found.map((f) => f.path).join(', ')}`);
  }
});

// ---------------------------------------------------------------- group 4
// Review Minor 1: operationId naming convention.
test('operationId convention: collection GET dung list*, item GET dung get*', () => {
  const violations = [];
  for (const [p, methods] of OPENAPI_PATHS) {
    for (const [method, op] of methods) {
      if (!op.operationId) continue;
      const isItem = p.includes('{');
      const isExport = p.endsWith('.csv');
      // A "collection listing" is a GET on a plural, parameterless resource
      // path. Singletons (health, .../status, .../me, .../stats) and CSV exports
      // are not listings and keep get*/export*.
      const isListing = !isItem && !isExport && /\/(assets|tickets|licenses|notifications|problems|changes|access-requests|audit)$/.test(p);
      if (method === 'get' && isListing && !op.operationId.startsWith('list')) violations.push(`${op.operationId} (GET listing ${p}) phai bat dau bang "list"`);
      if (method === 'get' && isItem && !op.operationId.startsWith('get')) violations.push(`${op.operationId} (GET item ${p}) phai bat dau bang "get"`);
    }
  }
  assert.equal(violations.length, 0, `operationId sai convention:\n  ${violations.join('\n  ')}`);
});

// ---------------------------------------------------------------- review r2 #3
// Round 1 only asserted that a named component EXISTS. Removing the 200 schema
// from an operation left the component unused and the test still green. These
// tests assert that each required success operation actually RESOLVES to the
// expected component, so an unwired operation fails.

// Which component each required success response must resolve to.
const REQUIRED_RESPONSE_REFS = [
  { path: '/api/monitoring/checks', method: 'get', schema: 'MonitoringCheckList' },
  { path: '/api/monitoring/checks/{id}', method: 'get', schema: 'MonitoringCheck' },
  { path: '/api/monitoring/status', method: 'get', schema: 'MonitoringStatus' },
  { path: '/api/monitoring/history', method: 'get', schema: 'MonitoringHistoryPage' },
  { path: '/api/integrations/minierp/incidents', method: 'post', schema: 'MiniERPIncident', response: '201' },
  { path: '/api/integrations/minierp/incidents', method: 'post', schema: 'MiniERPIncident', response: '200' },
  { path: '/api/access-requests/{id}/complete', method: 'post', schema: 'AccessRequest' },
  { path: '/api/access-requests/{id}/offboard', method: 'post', schema: 'AccessRequest' },
  { path: '/api/monitoring/checks/{id}/run', method: 'post', schema: 'MonitoringRunResult' },
];

test('REQUIRED RESPONSE WIRING: moi success operation bat buoc $ref DUNG STATUS CODE', () => {
  // Each entry pins ONE status code. Reading "the first ref under responses"
  // let a missing 200 pass as long as the 201 was present.
  const missing = [];
  for (const entry of REQUIRED_RESPONSE_REFS) {
    const code = entry.response || '200';
    const actual = responseSchemaFor(entry.path, entry.method, code);
    if (actual !== `#/components/schemas/${entry.schema}`) {
      missing.push(`${entry.method.toUpperCase()} ${entry.path} [${code}]: $ref "${actual || 'khong co'}", can "${entry.schema}"`);
    }
  }
  assert.equal(missing.length, 0, `success response chua $ref component:\n  ${missing.join('\n  ')}`);
});

test('REQUIRED RESPONSE WIRING: moi component bat buoc duoc it nhat mot operation tro toi', () => {
  // Guards the inverse false-green: a component that exists but is wired to
  // nothing is dead documentation.
  const referenced = new Set();
  for (const [, methods] of OPENAPI_PATHS) {
    for (const [, op] of methods) for (const [code, ref] of Object.entries(op.responseSchemas || {})) {
      if (ref && ref.startsWith('#/components/schemas/')) referenced.add(ref.slice('#/components/schemas/'.length));
    }
  }
  const orphans = REQUIRED_RESPONSE_REFS.map((r) => r.schema).filter((s) => !referenced.has(s));
  assert.equal(orphans.length, 0, `component khong operation nao tro toi: ${orphans.join(', ')}`);
});

test('AssetInput phai mo ta duoc ca alias set va canonical set', () => {
  // The removed legacy payload used tag/brand/serial; the canonical one uses
  // assetTag/manufacturer/serialNumber. Runtime accepts both, so the schema
  // must not `required` a legacy-only set that rejects the canonical payload.
  const requiredLine = OPENAPI.split('\n').find((l) => /^ {4}AssetInput:/.test(l));
  void requiredLine;
  const props = schemaProperties('AssetInput');
  const canonical = ['assetTag', 'assetType', 'manufacturer', 'serialNumber', 'employee'];
  const legacy = ['tag', 'type', 'brand', 'serial', 'assignedTo'];
  const missing = [...canonical, ...legacy].filter((f) => !props.has(f));
  assert.equal(missing.length, 0, `AssetInput thieu field: ${missing.join(', ')}`);
  // `required` must be satisfiable by BOTH shapes, i.e. it cannot demand a
  // legacy-only field while leaving the canonical equivalent optional.
  const idx = OPENAPI.split('\n').findIndex((l) => l === '    AssetInput:');
  const required = (OPENAPI.split('\n').slice(idx, idx + 8).find((l) => l.trim().startsWith('required:')) || '');
  const reqFields = (required.match(/\[([^\]]*)\]/) || [, ''])[1].split(',').map((x) => x.trim()).filter(Boolean);
  const legacyOnly = reqFields.filter((f) => legacy.includes(f) && !canonical.includes(f));
  assert.equal(legacyOnly.length, 0,
    `AssetInput.required khong duoc chi dinh field legacy-only ${legacyOnly.join(', ')}; runtime chap nhan ca hai shape`);
});

test('AssetPatchInput phai document cac alias runtime chap nhan', () => {
  const props = schemaProperties('AssetPatchInput');
  assert.ok(props, 'AssetPatchInput phai ton tai');
  const runtimeAccepted = ['assetTag', 'assetType', 'manufacturer', 'serialNumber', 'model', 'employee', 'assignedTo', 'dept', 'businessArea', 'location', 'hostname', 'macAddress', 'notes', 'ipAddress', 'ip', 'vlan', 'criticality', 'status', 'lifecycleStatus', 'tag', 'type', 'brand', 'serial'];
  const missing = runtimeAccepted.filter((f) => !props.has(f));
  assert.equal(missing.length, 0, `AssetPatchInput thieu alias: ${missing.join(', ')}`);
  const extra = [...props.keys()].filter((f) => !runtimeAccepted.includes(f));
  assert.equal(extra.length, 0,
    `AssetPatchInput khong duoc document field runtime khong chap nhan: ${extra.join(', ')}`);
});

test('status update: default Resolved phai hop len voi required cua schema', () => {
  // openapi.yaml says an omitted status defaults to Resolved, so `required`
  // must NOT contain status. If it does, a validator rejects the documented
  // default request — an internal contradiction.
  const props = schemaProperties('TicketStatusUpdateInput');
  assert.ok(props, 'TicketStatusUpdateInput phai ton tai');
  assert.ok(props.has('status'), 'schema van phai mo ta field status');
  assert.ok(props.has('note'), 'schema van phai mo ta field note');
  const idx = OPENAPI.split('\n').findIndex((l) => l === '    TicketStatusUpdateInput:');
  const block = OPENAPI.split('\n').slice(idx, idx + 20).join('\n');
  const requiredMatch = block.match(/required:\s*\[([^\]]*)\]/);
  const reqFields = requiredMatch ? requiredMatch[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
  assert.ok(!reqFields.includes('status'),
    `TicketStatusUpdateInput khong duoc require status neu runtime default Resolved khi thieu status (required=[${reqFields.join(', ')}])`);
});

test('runtime asset: mixed alias, canonical status, vlan va unknown key khop schema that', async () => {
  const schemas = OPENAPI_DOC.components.schemas;
  const anyOf = schemas.AssetInput.anyOf;
  assert.ok(Array.isArray(anyOf), 'AssetInput phai dung anyOf truoc khi kiem tra runtime');
  const payload = { assetTag: 'QA-MIXED-1', brand: 'Dell', model: 'Latitude 5450', serial: 'QA-SERIAL-MIXED-1', status: 'IN_STOCK', futureField: 'ignored' };
  const covered = anyOf.some((branch) => ['assetTag', 'brand', 'model', 'serial'].every((field) => (branch.required || []).includes(field)));
  assert.ok(covered, 'schema that phai chap nhan to hop alias mixed');
  assert.notEqual(schemas.AssetInput.additionalProperties, false, 'schema that phai cho phep unknown key nhu runtime');
  assert.equal(schemas.AssetPatchInput.minProperties, 1, 'empty patch phai bi schema tu choi nhu runtime');

  const c = await createTestClient({ notifier: offlineNotifier(), requestLogger: false });
  await c.start();
  try {
    const created = await c.json('POST', '/api/assets', payload);
    assert.equal(created.status, 201, `mixed alias phai duoc runtime chap nhan: ${JSON.stringify(created.data)}`);
    assert.equal(created.data.status, 'IN_STOCK');
    assert.equal(created.data.lifecycleStatus, 'IN_STOCK');
    assert.equal(Object.hasOwn(created.data, 'futureField'), false, 'unknown key khong duoc ghi vao asset');

    for (const status of ['ASSIGNED', 'REPAIR', 'LOST']) {
      const patched = await c.json('PATCH', `/api/assets/${created.data.id}`, { status });
      assert.equal(patched.status, 200, `canonical status ${status} phai duoc chap nhan`);
      assert.equal(patched.data.status, status);
      assert.equal(patched.data.lifecycleStatus, status);
    }

    const vlan = await c.json('PATCH', `/api/assets/${created.data.id}`, { vlan: '20' });
    assert.equal(vlan.status, 200);
    assert.equal(vlan.data.vlan, 'VLAN20');
    const empty = await c.json('PATCH', `/api/assets/${created.data.id}`, {});
    assert.equal(empty.status, 400, 'empty patch phai bi runtime tu choi');
  } finally { await c.cleanup(); }
});

test('runtime MiniERP incident bo qua unknown key nhu schema da chon', async () => {
  const schema = OPENAPI_DOC.components.schemas.MiniERPIncidentInput;
  assert.notEqual(schema.additionalProperties, false, 'MiniERPIncidentInput phai cho phep unknown key nhu runtime');
  const c = await createTestClient({ notifier: offlineNotifier(), requestLogger: false, miniErpIntegrationKey: 'qa-key' });
  await c.start();
  try {
    const created = await c.json('POST', '/api/integrations/minierp/incidents', {
      source: 'MINIERP',
      externalRef: 'ERP-UNKNOWN-1',
      title: 'unknown key contract',
      description: 'runtime ignores unknown fields',
      severity: 'LOW',
      futureField: 'ignored',
    }, { Authorization: 'Bearer qa-key' });
    assert.equal(created.status, 201, `unknown key phai khong lam MiniERP incident that: ${JSON.stringify(created.data)}`);
    assert.equal(created.data.externalRef, 'ERP-UNKNOWN-1');
    assert.equal(Object.hasOwn(created.data, 'futureField'), false);
  } finally { await c.cleanup(); }
});

