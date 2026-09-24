'use strict';

/**
 * JSON File Store — persistence layer cho portal (không cần native dependency).
 *
 * Chiến lược an toàn dữ liệu:
 *  1. Atomic write: ghi `db.json.tmp-<rand>` rồi `fs.rename()` lên `db.json`
 *     (rename là atomic trên POSIX/NTFS cùng volume → không sinh file_half_written).
 *  2. Serialised writes: mọi commit nối vào 1 promise chain → không race ghi đè.
 *  3. Corrupt-safe: db.json parse lỗi → đổi tên thành db.json.corrupt-<timestamp>
 *     rồi fallback về seed, server vẫn bật được.
 *  4. In-memory cache (`store.data`) → API đọc/ghi nhanh, chỉ flush ra đĩa khi mutate.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { seedData } = require('./seed');
const { normalizeAssetRecord, normalizeTicketRecord } = require('./itsm');

function defaultCollections() {
  return Object.fromEntries(COLLECTIONS.map((key) => [key, []]));
}

const SCHEMA_VERSION = 2;
const COLLECTIONS = [
  'assets', 'tickets', 'licenses', 'ticketEvents', 'problems', 'changes',
  'accessRequests', 'monitoringChecks', 'monitoringHistory', 'auditEvents', 'notifications',
];

function nowIso() {
  return new Date().toISOString();
}

function createStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const file = path.join(dataDir, 'db.json');
  const seed = options.seed || seedData;

  const store = {
    dataDir,
    file,
    schemaVersion: SCHEMA_VERSION,
    data: defaultCollections(),
    seeded: false,
    lastLoadedAt: null,
    writeChain: Promise.resolve(),
  };

  async function readSnapshot() {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      const backup = `${file}.corrupt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      await fs.rename(file, backup).catch(() => fs.writeFile(backup, raw, 'utf8'));
      console.warn(`[store] db.json không hợp lệ (${err.message}) → đã backup ${path.basename(backup)}, khởi tạo lại từ dữ liệu mẫu.`);
      return null;
    }
  }

  store.load = async function load() {
    await fs.mkdir(dataDir, { recursive: true });
    const snapshot = await readSnapshot();
    const sourceVersion = Number(snapshot && (snapshot.schemaVersion || snapshot.version)) || 0;

    if (snapshot && Array.isArray(snapshot.assets)) {
      store.seeded = false;
      store.data = defaultCollections();
      for (const key of COLLECTIONS) {
        store.data[key] = Array.isArray(snapshot[key]) ? snapshot[key] : [];
      }
      store.data.assets = store.data.assets.map(normalizeAssetRecord);
      store.data.tickets = store.data.tickets.map((ticket) => normalizeTicketRecord(ticket));
      if (sourceVersion < SCHEMA_VERSION) {
        const migration = `${file}.migration-${Date.now()}.bak`;
        await fs.copyFile(file, migration);
        store.migrationBackup = migration;
        await persist();
      }
    } else {
      store.seeded = true;
      store.data = defaultCollections();
      Object.assign(store.data, seed());
      store.data.assets = store.data.assets.map(normalizeAssetRecord);
      store.data.tickets = store.data.tickets.map((ticket) => normalizeTicketRecord(ticket));
      await persist();
    }

    store.lastLoadedAt = nowIso();
    return store.data;
  };

  async function persist() {
    const payload = JSON.stringify(
      { version: 1, schemaVersion: SCHEMA_VERSION, updatedAt: nowIso(), ...store.data },
      null,
      2
    );
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, payload + '\n', 'utf8');
    await fs.rename(tmp, file);
    return file;
  }

  /** Đặt lịch ghi đĩa bất đồng bộ nhưng tuần tự (không await được nếu muốn fire-and-forget). */
  store.commit = function commit() {
    store.writeChain = store.writeChain.then(persist, persist);
    return store.writeChain;
  };

  /** Chờ mọi thao tác ghi đĩa xong (dùng khi graceful shutdown / test). */
  store.flush = function flush() {
    return store.writeChain;
  };

  store.nextId = function nextId(collection, start = 1) {
    const rows = store.data[collection] || [];
    if (rows.length === 0) return start;
    return rows.reduce((max, row) => (typeof row.id === 'number' && row.id > max ? row.id : max), start - 1) + 1;
  };

  store.find = function find(collection, id) {
    const numeric = Number(id);
    return (store.data[collection] || []).find((row) => Number(row.id) === numeric);
  };

  store.append = function append(collection, row) {
    if (!store.data[collection]) store.data[collection] = [];
    store.data[collection].push(row);
    return row;
  };

  store.findBy = function findBy(collection, predicate) {
    return (store.data[collection] || []).find(predicate);
  };

  store.remove = function remove(collection, id) {
    const numeric = Number(id);
    const before = (store.data[collection] || []).length;
    store.data[collection] = (store.data[collection] || []).filter((row) => Number(row.id) !== numeric);
    return store.data[collection].length < before;
  };

  store.summary = function summary() {
    return COLLECTIONS.reduce((acc, key) => {
      acc[key] = (store.data[key] || []).length;
      return acc;
    }, {});
  };

  return store;
}

module.exports = { createStore, SCHEMA_VERSION, COLLECTIONS };
