'use strict';

/**
 * Cross-tenant adversarial control — real HTTP, real Express app, real tokens.
 *
 * The invariants under test:
 *
 *     cross_tenant_ticket_access = 0
 *     cross_tenant_asset_access  = 0
 *
 * What this file exists to correct: tenant was previously PERSISTED but never
 * ENFORCED. `enterprise-routes.js` filtered on status/priority/source and never
 * mentioned tenant, sessions carried no tenant at all, and the AI agent routes
 * read `tenant` straight out of the request BODY — so any authenticated caller
 * could name any tenant. The ledger honestly recorded this as NOT_PRESENT.
 *
 * Design point the negative controls pin: the caller's tenant comes from the
 * CONFIGURED user record via the session, never from a header, query parameter
 * or body field. If that regresses, a caller reaches tenant-b's data by naming
 * it, and "tenant scoped" becomes decoration.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createTestClient } = require('./helpers');

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

const labAuth = {
  authMode: 'lab',
  authUsers: {
    'a.admin': { password: 'pw-a-admin', role: 'IT_ADMIN', tenant: TENANT_A },
    'b.admin': { password: 'pw-b-admin', role: 'IT_ADMIN', tenant: TENANT_B },
    'a.viewer': { password: 'pw-a-viewer', role: 'VIEWER', tenant: TENANT_A },
  },
  requestLogger: false,
};

let client;

async function tokenAs(username, password) {
  const r = await client.json('POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, `login ${username} failed: ${r.status}`);
  return { Authorization: `Bearer ${r.data.token}` };
}

/** A ticket created by `headers` is owned by that caller's tenant. */
async function createTicket(headers, title) {
  const r = await client.json('POST', '/api/tickets', { title, requester: 'someone', dept: 'IT' }, headers);
  assert.equal(r.status, 201, `ticket create failed: ${r.status}`);
  return r.data;
}

before(async () => {
  client = await createTestClient(labAuth);
  await client.start();
});
after(async () => { if (client) await client.stop(); });

describe('cross-tenant isolation — tickets', () => {
  test("a ticket is stamped with the creator's tenant, not a client-supplied one", async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const created = await createTicket(a, 'tenant A incident');
    assert.equal(created.tenant, TENANT_A);

    // NEGATIVE CONTROL: the client cannot choose the tenant. Asking for
    // tenant-beta in the body must not change ownership.
    const spoof = await client.json(
      'POST', '/api/tickets',
      { title: 'spoof attempt', requester: 'mallory', tenant: TENANT_B },
      a,
    );
    assert.equal(spoof.status, 201);
    assert.equal(spoof.data.tenant, TENANT_A, 'body.tenant overrode the session tenant');
  });

  test("a list request returns only the caller's own tenant", async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const mine = await createTicket(a, 'belongs to A only');

    const listA = await client.json('GET', '/api/tickets', undefined, a);
    assert.equal(listA.status, 200);
    assert.ok(listA.data.some((t) => t.id === mine.id), 'A must see its own ticket');
    for (const row of listA.data) {
      assert.equal(row.tenant, TENANT_A, `tenant A saw a foreign row: ${row.tenant}`);
    }

    const listB = await client.json('GET', '/api/tickets', undefined, b);
    assert.equal(listB.status, 200);
    assert.ok(!listB.data.some((t) => t.id === mine.id), 'tenant B list leaked a tenant-A ticket');
    for (const row of listB.data) assert.equal(row.tenant, TENANT_B);
  });

  test("reading another tenant's ticket by id answers 404, not 403", async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const secret = await createTicket(a, 'tenant A confidential');

    const cross = await client.json('GET', `/api/tickets/${secret.id}`, undefined, b);
    assert.equal(cross.status, 404, 'cross-tenant read must not be distinguishable from absent');
    assert.ok(!JSON.stringify(cross.data || {}).includes('confidential'), 'the 404 body leaked the foreign row');
  });

  test('a query parameter cannot widen the result set back to all tenants', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    await createTicket(a, 'tenant A hidden by filter');

    // A caller who guesses the query shape must not be able to unscope it.
    const attempt = await client.json('GET', `/api/tickets?tenant=${TENANT_A}`, undefined, b);
    assert.equal(attempt.status, 200);
    assert.ok(
      !attempt.data.some((t) => String(t.title).includes('hidden by filter')),
      '?tenant= re-opened another tenant rows',
    );
  });

  test('the CSV export is scoped too — an export must not be the side door', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    await createTicket(a, 'tenant A export canary');

    // `json()` returns the body as text for a CSV response, which is what the
    // assertion needs to inspect.
    const csv = await client.json('GET', '/api/tickets/export.csv', undefined, b);
    assert.ok(!String(csv.data).includes('export canary'), 'cross-tenant rows leaked through the CSV export');
  });
});

describe('cross-tenant isolation — assets', () => {
  test("an asset is stamped with the creator's tenant and hidden from other tenants", async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');

    const created = await client.json('POST', '/api/assets', {
      assetTag: `ASSET-${TENANT_A}-1`,
      manufacturer: 'Dell', model: 'Latitude', serialNumber: 'SN-ALPHA-1',
    }, a);
    assert.equal(created.status, 201);
    assert.equal(created.data.tenant, TENANT_A);

    const cross = await client.json('GET', `/api/assets/${created.data.id}`, undefined, b);
    assert.equal(cross.status, 404, 'cross-tenant asset read must be indistinguishable from absent');

    const listB = await client.json('GET', '/api/assets', undefined, b);
    assert.ok(!listB.data.some((x) => x.id === created.data.id), 'asset leaked into tenant B list');
  });

  test("deleting another tenant's asset is refused, and the row survives", async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const created = await client.json('POST', '/api/assets', {
      assetTag: `ASSET-${TENANT_A}-2`,
      manufacturer: 'HP', model: 'EliteBook', serialNumber: 'SN-ALPHA-2',
    }, a);

    const attack = await client.json('DELETE', `/api/assets/${created.data.id}`, undefined, b);
    assert.equal(attack.status, 404, 'cross-tenant delete must be refused');

    // The row must still exist for its owner — a refused delete is not a
    // successful one that merely reported an error code.
    const stillThere = await client.json('GET', `/api/assets/${created.data.id}`, undefined, a);
    assert.equal(stillThere.status, 200, 'the refused delete actually removed the row');
  });

  test('NEGATIVE CONTROL: an anonymous caller reaches no tenant data at all', async () => {
    const list = await client.json('GET', '/api/tickets');
    assert.equal(list.status, 401, 'the /api auth guard must reject an anonymous read');
  });

  test("a tenant A VIEWER gets READ for A and still nothing of B", async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const viewerA = await tokenAs('a.viewer', 'pw-a-viewer');
    const mine = await createTicket(a, 'tenant A viewer boundary');

    // The viewer holds READ for its own tenant...
    const own = await client.json('GET', `/api/tickets/${mine.id}`, undefined, viewerA);
    assert.equal(own.status, 200);

    // ...and forging a tenant header must not turn that grant into a cross-tenant
    // one. (There is nothing of B's to find here, so the assertion is that the
    // forged request cannot make B's name authoritative.)
    const forged = await client.json('GET', `/api/tickets/${mine.id}`, undefined, {
      ...viewerA, 'X-Tenant': TENANT_B,
    });
    assert.equal(forged.status, 200, 'the A viewer still sees its own row');
  });

  test('NEGATIVE CONTROL: the AI agent routes ignore a client-named tenant', async () => {
    // `POST /api/ai/agent` and `/api/ai/agent/approve` used to read
    // `body.tenant`, so any authenticated caller could drive the agent inside
    // another tenant's context.
    //
    // The assertion is deliberately an OBSERVABLE EFFECT, not a string search in
    // the response. A mutation that restored `tenant: str(body.tenant)` passed
    // an earlier version of this test that only grepped the response body — the
    // agent simply does not echo the tenant back. Long-term memory is keyed by
    // `(tenant, user)` (`memory.js: userKey`), so the tenant the agent actually
    // used is observable in the persisted key.
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    // A fact the memory extractors recognise ("tôi tên là …"), so the run
    // actually WRITES a memory entry. Without a write there would be no key to
    // inspect and the negative assertions below would pass vacuously.
    const QUESTION = 'tôi tên là Nguyễn Văn Kiểm Tra Tenant';

    // Both callers use the SAME user name with DIFFERENT session tenants, and
    // both try to claim the other's tenant in the body.
    for (const [headers, spoof] of [[a, TENANT_B], [b, TENANT_A]]) {
      const r = await client.json('POST', '/api/ai/agent', { question: QUESTION, tenant: spoof }, headers);
      assert.equal(r.status, 200, `agent run failed: ${r.status}`);
    }

    // The agent keys long-term memory by `${tenant}:${user}` (`memory.js: userKey`)
    // and persists it to `<dataDir>/agent-memory.json`. Reading that file observes
    // the tenant the agent ACTUALLY ran under, which is the property under test.
    const fs = require('node:fs');
    const memoryFile = `${client.dataDir}/agent-memory.json`;

    // `persist()` is queued asynchronously; drain it so the assertion reads
    // settled state instead of racing the writer.
    const memory = client.context.agent._internals.memory;
    assert.ok(memory && typeof memory.persist === 'function', 'agent memory handle is not observable');
    await memory.persist();

    assert.ok(fs.existsSync(memoryFile), `no agent memory file at ${memoryFile}; the test would prove nothing`);
    const persisted = fs.readFileSync(memoryFile, 'utf8');
    assert.ok(persisted.trim().length > 2, 'agent memory is empty; the test would prove nothing');
    assert.ok(
      !persisted.includes(`"${TENANT_B}:a.admin"`),
      'a caller drove the agent under a client-named tenant',
    );
    assert.ok(
      !persisted.includes(`"${TENANT_A}:b.admin"`),
      'a caller drove the agent under a client-named tenant',
    );
    // ...and the sessions really were recorded under the correct tenants, so the
    // negative assertions above are not passing merely because nothing ran.
    assert.ok(
      persisted.includes(`"${TENANT_A}:a.admin"`),
      'tenant A caller did not get a memory key under its own tenant',
    );
    assert.ok(
      persisted.includes(`"${TENANT_B}:b.admin"`),
      'tenant B caller did not get a memory key under its own tenant',
    );
  });

  test('NEGATIVE CONTROL: legacy rows without a tenant belong to the default tenant only', async () => {
    // Seeded/pre-tenancy rows carry no `tenant` field. They must not become
    // visible to every tenant — that would be the same leak in the other
    // direction.
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const listA = await client.json('GET', '/api/tickets', undefined, a);
    assert.equal(listA.status, 200);
    for (const row of listA.data) {
      assert.ok(
        row.tenant === undefined || row.tenant === TENANT_A,
        `tenant A saw a row owned by ${row.tenant}`,
      );
    }
  });
});

describe('cross-tenant isolation — problems and changes (ITSM)', () => {
  // These two collections were the last known unscoped area. They carried real
  // sensitivity: root causes, workarounds, rollback plans and maintenance
  // windows, all served whole to any authenticated caller.

  test('a created problem is stamped with its creator tenant and hidden from others', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');

    const created = await client.json('POST', '/api/problems', {
      title: 'tenant A known error', service: 'Identity', rootCause: 'internal detail A',
    }, a);
    assert.equal(created.status, 201);
    assert.equal(created.data.tenant, TENANT_A);

    const listB = await client.json('GET', '/api/problems', undefined, b);
    assert.equal(listB.status, 200);
    assert.ok(!listB.data.some((p) => p.id === created.data.id), 'tenant B saw tenant A\'s problem');
    for (const row of listB.data) assert.equal(row.tenant, TENANT_B);

    const cross = await client.json('GET', `/api/problems/${created.data.id}`, undefined, b);
    assert.equal(cross.status, 404, 'a cross-tenant problem read must be indistinguishable from absent');
    assert.ok(!JSON.stringify(cross.data).includes('internal detail A'), 'the 404 body leaked the root cause');
  });

  test('a created change is stamped and hidden, including its rollback plan', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');

    const created = await client.json('POST', '/api/changes', {
      title: 'tenant A emergency change', risk: 'HIGH', rollbackPlan: 'secret rollback A',
    }, a);
    assert.equal(created.status, 201);
    assert.equal(created.data.tenant, TENANT_A);

    const listB = await client.json('GET', '/api/changes', undefined, b);
    assert.ok(!listB.data.some((c) => c.id === created.data.id), 'tenant B saw tenant A\'s change');
    assert.ok(!JSON.stringify(listB.data).includes('secret rollback A'), 'a rollback plan leaked across tenants');

    const cross = await client.json('GET', `/api/changes/${created.data.id}`, undefined, b);
    assert.equal(cross.status, 404);
  });

  test('a foreign change cannot be APPROVED — approval is a cross-tenant write', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const created = await client.json('POST', '/api/changes', {
      title: 'tenant A change to approve', risk: 'HIGH', rollbackPlan: 'plan A',
    }, a);

    const attack = await client.json('POST', `/api/changes/${created.data.id}/approve`, {}, b);
    assert.equal(attack.status, 404, 'tenant B approved tenant A\'s change');

    const still = await client.json('GET', `/api/changes/${created.data.id}`, undefined, a);
    assert.notEqual(still.data.approvalState, 'APPROVED', 'the cross-tenant approval took effect');
  });

  test('a foreign problem cannot be edited', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const created = await client.json('POST', '/api/problems', { title: 'tenant A problem to edit' }, a);

    const attack = await client.json(
      'PATCH', `/api/problems/${created.data.id}`, { rootCause: 'overwritten by B' }, b,
    );
    assert.equal(attack.status, 404, 'tenant B edited tenant A\'s problem');

    const still = await client.json('GET', `/api/problems/${created.data.id}`, undefined, a);
    assert.notEqual(still.data.rootCause, 'overwritten by B');
  });

  test('a problem may only link a ticket its own tenant can see', async () => {
    const a = await tokenAs('a.admin', 'pw-a-admin');
    const b = await tokenAs('b.admin', 'pw-b-admin');
    const ticketA = await createTicket(a, 'tenant A ticket to link');
    const problemB = await client.json('POST', '/api/problems', { title: 'tenant B problem' }, b);

    // Tenant B must not be able to attach tenant A's ticket to its problem — the
    // ticket lookup is already tenant-scoped, so this has to be refused.
    const attack = await client.json(
      'POST', `/api/problems/${problemB.data.id}/link-ticket`, { ticketId: ticketA.id }, b,
    );
    assert.equal(attack.status, 404, 'a cross-tenant ticket was linked');

    const problem = await client.json('GET', `/api/problems/${problemB.data.id}`, undefined, b);
    assert.ok(!problem.data.linkedTicketIds.includes(ticketA.id));
  });
});