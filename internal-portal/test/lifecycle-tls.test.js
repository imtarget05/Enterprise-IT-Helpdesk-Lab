'use strict';

/**
 * TLS resolution for the PostgreSQL lifecycle store — pure, no database needed.
 *
 * Regression under test: the store used to hardcode `ssl` and only reacted to
 * DATABASE_SSL === 'false'. Against a PostgreSQL without SSL (local docker, CI)
 * the pool refused to connect with "The server does not support SSL connections",
 * which made the whole durable-lifecycle suite unrunnable outside Azure. These
 * tests pin the ranked precedence so that default-off regression cannot return,
 * and so TLS cannot be disabled by accident.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveSsl, createPostgresLifecycleStore } = require('../src/lifecycle-store-postgres');

/** Build a store and read back the TLS the pool will actually use. */
async function poolSslFor(connectionString, env) {
  const saved = {};
  for (const key of ['DATABASE_SSL', 'DATABASE_URL']) {
    saved[key] = process.env[key];
    if (env && key in env) process.env[key] = env[key];
    else delete process.env[key];
  }
  try {
    const store = createPostgresLifecycleStore({ connectionString });
    const ssl = store.pool.options.ssl;
    await store.close();
    return ssl;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('PostgreSQL TLS resolution', () => {
  test('WIRING: the pool uses the resolved TLS, not a hardcoded value', async () => {
    // This is the assertion that would have caught the original defect: the
    // resolver alone was never consulted by the pool, so a mutation that
    // hardcoded `ssl` again survived every unit test while the real integration
    // suite could not connect to any non-Azure database.
    assert.equal(await poolSslFor('postgres://u:p@db:5432/helpdesk?sslmode=disable', {}), false);
    assert.notEqual(await poolSslFor('postgres://u:p@db:5432/helpdesk', {}), false);
  });
  test('SECURE DEFAULT: no sslmode and no env keeps TLS on', () => {
    const ssl = resolveSsl('postgres://u:p@db:5432/helpdesk', {});
    assert.notEqual(ssl, false, 'an unspecified connection must not silently drop TLS');
    assert.equal(ssl.rejectUnauthorized, false);
  });

  test('libpq sslmode=disable is honoured for local/CI databases', () => {
    assert.equal(resolveSsl('postgres://u:p@127.0.0.1:55432/helpdesk?sslmode=disable', {}), false);
  });

  test('DATABASE_SSL=false disables TLS even when the URL says require', () => {
    assert.equal(resolveSsl('postgres://u:p@db/helpdesk?sslmode=require', { DATABASE_SSL: 'false' }), false);
  });

  test('DATABASE_SSL=verify-full is the strictest setting and outranks the URL', () => {
    const ssl = resolveSsl('postgres://u:p@db/helpdesk?sslmode=disable', { DATABASE_SSL: 'verify-full' });
    assert.deepEqual(ssl, { rejectUnauthorized: true });
  });

  test('sslmode=verify-full requires certificate verification', () => {
    assert.deepEqual(
      resolveSsl('postgres://u:p@db/helpdesk?sslmode=verify-full', {}),
      { rejectUnauthorized: true },
    );
  });

  test('a malformed URL does not throw — pg reports the connection error', () => {
    assert.doesNotThrow(() => resolveSsl('not a url at all', {}));
    assert.doesNotThrow(() => resolveSsl(undefined, {}));
  });

  test('NEGATIVE CONTROL: no combination of ordinary dev values disables TLS silently', () => {
    // Anything that is not an explicit opt-out must keep TLS on.
    for (const env of [{}, { DATABASE_SSL: 'true' }, { DATABASE_SSL: 'require' }]) {
      for (const url of ['postgres://u:p@db/helpdesk', 'postgres://u:p@db/helpdesk?sslmode=prefer']) {
        assert.notEqual(resolveSsl(url, env), false, `TLS dropped for ${url} ${JSON.stringify(env)}`);
      }
    }
  });
});