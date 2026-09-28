'use strict';

/**
 * Review round 3 #3 — the OpenAPI document must be REAL, VALID YAML.
 *
 * The round-1 and round-2 contract gates parsed openapi.yaml line by line with
 * regex/indent heuristics. That parser happily accepted a document a standard
 * YAML parser rejects: `AssetInput` ended with a scalar `additionalProperties:
 * false` followed by a stray indented mapping, and `AuditEvent` was declared
 * twice, making the key ambiguous. The whole 225-test suite stayed green
 * because nothing ever parsed the file.
 *
 * This gate parses the real file with the `yaml` package, which surfaces both
 * syntax errors and duplicate keys. It is a direct devDependency; the runtime
 * dependency set is unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const OPENAPI_FILE = path.join(__dirname, '..', 'public', 'openapi.yaml');
const SOURCE = fs.readFileSync(OPENAPI_FILE, 'utf8');

/** Parse with duplicate-key detection enabled (yaml reports them as errors). */
function parseStrict(source = SOURCE) {
  return YAML.parse(source, { uniqueKeys: true });
}

function yamlErrors(source = SOURCE) {
  return YAML.parseDocument(source, { uniqueKeys: true }).errors.map((error) => error.message);
}

test('openapi.yaml parse duoc bang YAML that (khong syntax error)', () => {
  let doc;
  try {
    doc = parseStrict();
  } catch (err) {
    assert.fail(`openapi.yaml khong parse duoc:\n  ${err.message}`);
  }
  assert.ok(doc && typeof doc === 'object', 'document phai la mapping');
  assert.equal(doc.openapi ? String(doc.openapi).split('.')[0] : null, '3', 'phai khai bao OpenAPI 3.x');
  assert.ok(doc.info && doc.info.title, 'phai co info.title');
  assert.ok(doc.paths && typeof doc.paths === 'object', 'phai co paths');
});

test('openapi.yaml khong co duplicate mapping key (AuditEvent truoc day bi declare 2 lan)', () => {
  const errors = yamlErrors();
  assert.equal(errors.length, 0, `YAML bao loi (trong do co duplicate key):\n  ${errors.join('\n  ')}`);
});

test('moi component schema resolve duoc $ref va gia tri co kieu dung', () => {
  const doc = parseStrict();
  const schemas = doc.components && doc.components.schemas;
  assert.ok(schemas && typeof schemas === 'object', 'phai co components.schemas');
  // Every $ref inside the document must point at a schema that exists.
  const missing = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) {
        const name = v.slice('#/components/schemas/'.length);
        if (!schemas[name]) missing.add(name);
        continue;
      }
      visit(v);
    }
  };
  visit(doc);
  assert.equal(missing.size, 0, `$ref tro toi schema khong ton tai: ${[...missing].join(', ')}`);
});

test('AssetInput anyOf phai phu tat ca to hop alias doc lap doc, khong dung oneOf', () => {
  const doc = parseStrict();
  const assetInput = doc.components.schemas.AssetInput;
  assert.ok(assetInput, 'AssetInput phai ton tai');
  assert.equal(assetInput.oneOf, undefined, 'runtime fallback tung cap nen dung anyOf, khong dung oneOf');
  assert.ok(Array.isArray(assetInput.anyOf) && assetInput.anyOf.length >= 2, 'AssetInput phai co anyOf it nhat 2 nhanh');
  const groups = [['assetTag', 'tag'], ['manufacturer', 'brand'], ['serialNumber', 'serial']];
  for (const [index, branch] of assetInput.anyOf.entries()) {
    const required = new Set(branch.required || []);
    assert.ok(required.has('model'), `anyOf[${index}] phai require model`);
    for (const group of groups) {
      assert.equal(group.filter((field) => required.has(field)).length, 1,
        `anyOf[${index}] phai chon dung mot alias trong ${group.join('/')}: ${[...required].join(',')}`);
    }
  }
  for (let mask = 0; mask < 8; mask += 1) {
    const expected = new Set(['model']);
    groups.forEach((group, groupIndex) => expected.add(group[(mask >> groupIndex) & 1]));
    const covered = assetInput.anyOf.some((branch) => [...expected].every((field) => (branch.required || []).includes(field)));
    assert.ok(covered, `anyOf phai chap nhan to hop alias ${[...expected].join(', ')}`);
  }
});

test('Asset/AssetInput/AssetPatchInput status deu tro toi canonical lifecycle enum', () => {
  const doc = parseStrict();
  const lifecycleRef = '#/components/schemas/AssetLifecycleStatus';
  for (const name of ['Asset', 'AssetInput', 'AssetPatchInput']) {
    const status = doc.components.schemas[name].properties.status;
    assert.ok(status, `${name} phai co status`);
    assert.equal(status.$ref, lifecycleRef, `${name}.status phai $ref ${lifecycleRef}`);
  }
  const enumValues = (doc.components.schemas.AssetLifecycleStatus.enum || []).map(String);
  const canonical = ['IN_STOCK', 'ASSIGNED', 'REPAIR', 'LOST'];
  for (const value of canonical) {
    assert.ok(enumValues.includes(value), `AssetLifecycleStatus phai chap nhan canonical ${value}`);
  }
});

test('response $ref doc lap theo TUNG status code (200/201 phai doc lap)', () => {
  const doc = parseStrict();
  const p = doc.paths['/api/integrations/minierp/incidents'].post.responses;
  const schemaOf = (code) => {
    const node = p[String(code)];
    return node && node.content && node.content['application/json'] && node.content['application/json'].schema;
  };
  const s200 = schemaOf(200);
  const s201 = schemaOf(201);
  assert.ok(s200 && s200.$ref, 'responses.200 phai co schema $ref rieng');
  assert.ok(s201 && s201.$ref, 'responses.201 phai co schema $ref rieng');
  assert.equal(s200.$ref, '#/components/schemas/MiniERPIncident');
  assert.equal(s201.$ref, '#/components/schemas/MiniERPIncident');
  // The point of the round-3 fix: 200 and 201 are DISTINCT slots.
  assert.notEqual(s200, s201, '200 va 201 phai la hai node rieng biet');
});

test('AssetPatchInput mo ta vlan, minProperties=1 va van cho phep unknown key ben canh field da biet', () => {
  const doc = parseStrict();
  const schemas = doc.components.schemas;
  const patch = schemas.AssetPatchInput;
  assert.ok(patch.properties.vlan, 'AssetPatchInput phai mo ta vlan ma runtime chap nhan');
  assert.equal(patch.minProperties, 1, 'AssetPatchInput phai minProperties=1 cho payload rong');
  assert.notEqual(patch.additionalProperties, false,
    'unknown key van phai duoc phep DI KE ben canh mot field da biet, vi runtime bo qua no');
  for (const name of ['AssetInput', 'AssetPatchInput', 'TicketStatusUpdateInput', 'MiniERPIncidentInput']) {
    assert.notEqual(schemas[name].additionalProperties, false,
      `${name} khong duoc additionalProperties=false khi runtime bo qua unknown key`);
  }
});


// --------------------------------------------------------------------------
// Review round 5 Important 3 — unknown-only PATCH: one chosen policy, proven
// on BOTH sides.
//
// Policy: the runtime rule is kept. A PATCH that carries no field the asset
// route understands is a 400, so the document must reject it too. The schema
// therefore keeps `additionalProperties: true` (unknown keys are tolerated
// alongside known ones, exactly as the runtime tolerates them) and additionally
// requires at least ONE known property through `anyOf` of single-field
// `required` branches. `minProperties: 1` stays as the empty-body guard.
//
// `ajv` is not a dependency of this lab, so the checker below is a deliberately
// small STRUCTURAL subset covering only the keywords this policy uses:
// `type: object`, `minProperties`, `required` (top level and inside `anyOf`),
// and `additionalProperties`. It is not a general JSON Schema validator and is
// not used as one anywhere else in the suite.
function schemaVerdict(schema, payload) {
  const node = schema || {};
  const keys = Object.keys(payload);
  if (node.type === 'object' && Number.isFinite(node.minProperties) && keys.length < node.minProperties) {
    return { ok: false, reason: `minProperties=${node.minProperties} nhung payload co ${keys.length} field` };
  }
  if (Array.isArray(node.required)) {
    const missing = node.required.filter((field) => !Object.hasOwn(payload, field));
    if (missing.length) return { ok: false, reason: `thieu required: ${missing.join(', ')}` };
  }
  if (Array.isArray(node.anyOf) && !node.anyOf.some((branch) => schemaVerdict(branch, payload).ok)) {
    return { ok: false, reason: 'khong branch anyOf nao duoc thoa' };
  }
  if (node.additionalProperties === false) {
    const declared = node.properties || {};
    const extra = keys.filter((field) => !Object.hasOwn(declared, field));
    if (extra.length) return { ok: false, reason: `additionalProperties=false chan: ${extra.join(', ')}` };
  }
  return { ok: true, reason: 'accepted' };
}

test('AssetPatchInput anyOf phai phu dung field runtime chap nhan, khong thua khong thieu', () => {
  const patch = parseStrict().components.schemas.AssetPatchInput;
  const declared = Object.keys(patch.properties || {});
  const branches = patch.anyOf || [];
  assert.ok(branches.length > 0, 'AssetPatchInput phai co anyOf de yeu cau it nhat mot field da biet');
  for (const [index, branch] of branches.entries()) {
    assert.deepEqual(branch.required && branch.required.length, 1,
      `anyOf[${index}] phai yeu cau DUNG MOT field da biet`);
    assert.ok(declared.includes(branch.required[0]), `anyOf[${index}] yeu cau field khong duoc document: ${branch.required[0]}`);
  }
  const covered = branches.flatMap((branch) => branch.required || []);
  assert.equal(new Set(covered).size, covered.length, "anyOf khong duoc lap lai cung mot field");
  assert.deepEqual(covered.slice().sort(), declared.slice().sort(),
    'anyOf phai phu DUNG field da document, khong thieu va khong thua');
});

test('AssetPatchInput: unknown-only PATCH bi ca schema va runtime tu choi giong nhau', async () => {
  const patch = parseStrict().components.schemas.AssetPatchInput;
  const cases = [
    { payload: { futureField: 'x' }, expected: false, label: 'chi field la' },
    { payload: {}, expected: false, label: 'payload rong' },
    { payload: { vlan: '20' }, expected: true, label: 'vlan' },
    { payload: { tag: 'LP-QA-1', notes: 'partial legacy alias' }, expected: true, label: 'partial legacy alias' },
    { payload: { assetTag: 'LP-QA-2', vlan: '10', futureField: 'x' }, expected: true, label: 'canonical + unknown' },
  ];
  for (const item of cases) {
    const verdict = schemaVerdict(patch, item.payload);
    assert.equal(verdict.ok, item.expected,
      `schema phai ${item.expected ? 'chap nhan' : 'tu choi'} ${item.label} (${JSON.stringify(item.payload)}): ${verdict.reason}`);
  }

  const { createTestClient } = require('./helpers');
  const notifier = { webhookUrl: null, lastDelivery: null, history: () => ({ count: 0, items: [] }), alert: () => ({ alerted: false, reason: 'offline' }) };
  const c = await createTestClient({ notifier, requestLogger: false });
  await c.start();
  try {
    const created = await c.json('POST', '/api/assets', {
      assetTag: 'LP-QA-PATCH', brand: 'Dell', model: 'Latitude 5450', serial: 'QA-PATCH-1',
    });
    assert.equal(created.status, 201, `fixture asset phai tao duoc: ${JSON.stringify(created.data)}`);
    const id = created.data.id;

    const unknown = await c.json('PATCH', `/api/assets/${id}`, { futureField: 'x' });
    assert.equal(unknown.status, 400, `runtime phai tu choi PATCH chi-chua-field-la, nhan ${unknown.status}`);

    const empty = await c.json('PATCH', `/api/assets/${id}`, {});
    assert.equal(empty.status, 400, 'runtime phai tu choi PATCH rong');

    const vlan = await c.json('PATCH', `/api/assets/${id}`, { vlan: '20' });
    assert.equal(vlan.status, 200, `PATCH vlan phai duoc chap nhan, nhan ${vlan.status}`);
    assert.equal(vlan.data.vlan, 'VLAN20');

    const alias = await c.json('PATCH', `/api/assets/${id}`, { tag: 'LP-QA-PATCH-2', notes: 'partial legacy alias' });
    assert.equal(alias.status, 200, `PATCH partial legacy alias phai duoc chap nhan, nhan ${alias.status}`);
    assert.equal(alias.data.tag, 'LP-QA-PATCH-2');

    const mixed = await c.json('PATCH', `/api/assets/${id}`, { assetTag: 'LP-QA-PATCH-3', vlan: '10', futureField: 'x' });
    assert.equal(mixed.status, 200, `PATCH canonical + unknown key phai duoc chap nhan, nhan ${mixed.status}`);
    assert.equal(mixed.data.assetTag, 'LP-QA-PATCH-3');
    assert.equal(Object.hasOwn(mixed.data, 'futureField'), false, 'unknown key khong duoc persist');
  } finally { await c.cleanup(); }
});
