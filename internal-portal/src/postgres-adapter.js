'use strict';

/**
 * PostgreSQL Persistence Adapter for Enterprise IT Helpdesk Portal.
 *
 * Provides ACID durability, concurrent-write safety across multi-replica Container Apps,
 * and seamless fallback to atomic file/journal when DATABASE_URL is unset.
 */

const { Pool } = require('pg');

class PostgresStoreAdapter {
  constructor(databaseUrl, collections, seedFn) {
    this.databaseUrl = databaseUrl;
    this.collections = collections;
    this.seedFn = seedFn;
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_MAX_POOL || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.initialized = false;
  }

  async initSchema() {
    if (this.initialized) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TABLE IF NOT EXISTS portal_collections (
          collection_name VARCHAR(64) PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS portal_audit_ledger (
          id SERIAL PRIMARY KEY,
          action VARCHAR(64) NOT NULL,
          actor VARCHAR(128) NOT NULL,
          target_type VARCHAR(64),
          target_id VARCHAR(64),
          details JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query('COMMIT');
      this.initialized = true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async load() {
    await this.initSchema();
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT collection_name, data FROM portal_collections');
      const data = {};
      for (const col of this.collections) {
        data[col] = [];
      }

      if (res.rows.length === 0) {
        // Seed initial data
        const initial = this.seedFn();
        await client.query('BEGIN');
        for (const [key, rows] of Object.entries(initial)) {
          if (this.collections.includes(key)) {
            data[key] = rows;
            await client.query(
              `INSERT INTO portal_collections (collection_name, data, updated_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (collection_name) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
              [key, JSON.stringify(rows)]
            );
          }
        }
        await client.query('COMMIT');
      } else {
        for (const row of res.rows) {
          if (this.collections.includes(row.collection_name)) {
            data[row.collection_name] = Array.isArray(row.data) ? row.data : [];
          }
        }
      }
      return data;
    } finally {
      client.release();
    }
  }

  async persist(collectionsData) {
    await this.initSchema();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const col of this.collections) {
        const rows = collectionsData[col] || [];
        await client.query(
          `INSERT INTO portal_collections (collection_name, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (collection_name) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [col, JSON.stringify(rows)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PostgresStoreAdapter };
