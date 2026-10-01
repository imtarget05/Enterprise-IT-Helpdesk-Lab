'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStoreAdapter } = require('../src/postgres-adapter');
const { createStore } = require('../src/store');

describe('PostgreSQL Store Adapter & Seam', () => {
  test('createStore defaults to file persistence when DATABASE_URL is unset', () => {
    delete process.env.DATABASE_URL;
    const store = createStore();
    assert.strictEqual(store.isPostgres, false);
    assert.strictEqual(typeof store.load, 'function');
    assert.strictEqual(typeof store.commit, 'function');
  });

  test('createStore enables Postgres adapter when databaseUrl option is supplied', () => {
    const store = createStore({ databaseUrl: 'postgresql://fakeuser:fakepass@localhost:5432/fakedb' });
    assert.strictEqual(store.isPostgres, true);
  });

  test('PostgresStoreAdapter properly builds schema SQL and executes in transaction', async () => {
    const queries = [];
    const mockClient = {
      query: async (sql, params) => {
        queries.push({ sql: sql.trim(), params });
        if (sql.includes('SELECT collection_name')) {
          return {
            rows: [
              { collection_name: 'tickets', data: [{ id: 101, title: 'Network Down' }] },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {},
    };

    const adapter = new PostgresStoreAdapter(
      'postgresql://fakeuser:fakepass@localhost:5432/fakedb',
      ['tickets', 'assets'],
      () => ({ tickets: [], assets: [] })
    );

    // Swap pool.connect with mock
    adapter.pool.connect = async () => mockClient;

    const data = await adapter.load();
    assert.ok(queries.some((q) => q.sql.includes('CREATE TABLE IF NOT EXISTS portal_collections')));
    assert.deepStrictEqual(data.tickets, [{ id: 101, title: 'Network Down' }]);
    assert.deepStrictEqual(data.assets, []);

    // Now test persist
    queries.length = 0;
    await adapter.persist({ tickets: [{ id: 101, title: 'Resolved' }], assets: [] });
    assert.ok(queries.some((q) => q.sql === 'BEGIN'));
    assert.ok(queries.some((q) => q.sql.includes('INSERT INTO portal_collections')));
    assert.ok(queries.some((q) => q.sql === 'COMMIT'));
  });
});
