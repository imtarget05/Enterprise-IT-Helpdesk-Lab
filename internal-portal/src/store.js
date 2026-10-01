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
 *  5. Write-ahead intent journal (`db.json.journal`): trước khi ghi đè db.json,
 *     append 1 dòng intent (JSONL) + fsync journal → ghi tmp + fsync → rename
 *     atomic → truncate journal. Crash giữa chừng để lại journal non-empty;
 *     lần `load()` tiếp theo sẽ recover deterministically.
 *
 * RECOVERY POLICY (replay-or-discard, deterministic, idempotent):
 *  - Mỗi dòng intent ghi lại `{op:'write', tmp:<basename>, sha256, bytes, at}`.
 *  - Nếu crash SAU khi tmp đã fsync nhưng TRƯỚC rename: tmp còn trên đĩa,
 *    nội dung verify OK (parse được JSON + khớp sha256) → REPLAY bằng cách
 *    rename tmp → db.json (dữ liệu đã fsync nên không mất commit).
 *  - Nếu crash TRƯỚC khi tmp hoàn chỉnh (tmp thiếu / parse lỗi / sai hash):
 *    DISCARD tmp đó (unlink) — commit chưa từng fsync đầy đủ nên không được
 *    phép thành db.json; db.json cũ vẫn nguyên vẹn nhờ rename-atomic.
 *  - Nhiều dòng intent (nhiều crash chồng nhau): xử lý theo thứ tự, tmp hợp
 *    lệ CUỐI CÙNG thắng — tương đương thứ tự persist ban đầu.
 *  - Xong recover luôn truncate journal về rỗng → chạy lại recover lần 2 là
 *    no-op (idempotent). Journal KHÔNG chứa full payload (chỉ intent + hash)
 *    nên không bao giờ tự "bịa" dữ liệu: không có tmp hợp lệ thì giữ db.json
 *    hiện tại và rơi về luồng corrupt-safe/seed sẵn có.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { seedData } = require('./seed');
const { normalizeAssetRecord, normalizeTicketRecord } = require('./itsm');
const { PostgresStoreAdapter } = require('./postgres-adapter');

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
  const journalFile = `${file}.journal`;
  const seed = options.seed || seedData;
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
  const pgAdapter = databaseUrl ? new PostgresStoreAdapter(databaseUrl, COLLECTIONS, seed) : null;

  const store = {
    dataDir,
    file,
    journalFile,
    schemaVersion: SCHEMA_VERSION,
    data: defaultCollections(),
    seeded: false,
    lastLoadedAt: null,
    writeChain: Promise.resolve(),
    isPostgres: Boolean(pgAdapter),
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
    if (pgAdapter) {
      store.data = await pgAdapter.load();
      store.data.assets = (store.data.assets || []).map(normalizeAssetRecord);
      store.data.tickets = (store.data.tickets || []).map((ticket) => normalizeTicketRecord(ticket));
      store.lastLoadedAt = nowIso();
      return store.data;
    }
    await fs.mkdir(dataDir, { recursive: true });
    await recoverJournal();
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

  /** Ghi file + fsync trước khi trả về (đảm bảo dữ liệu đã xuống đĩa). */
  async function writeFileSynced(target, data) {
    const handle = await fs.open(target, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Best-effort fsync thư mục để rename được durable (bỏ qua lỗi trên Windows). */
  async function fsyncDir(dir) {
    try {
      const handle = await fs.open(dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Windows không cho open directory → bỏ qua, rename vẫn atomic.
    }
  }

  /**
   * Recover journal khi khởi động (xem RECOVERY POLICY ở header).
   * Idempotent: cuối recover luôn truncate journal → chạy lại là no-op.
   */
  async function recoverJournal() {
    let raw;
    try {
      raw = await fs.readFile(journalFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { recovered: false, reason: 'no-journal' };
      throw err;
    }
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) return { recovered: false, reason: 'empty-journal' };
    let replayed = null;
    for (const line of lines) {
      let intent;
      try {
        intent = JSON.parse(line);
      } catch {
        continue; // dòng intent dở (crash khi append) → discard dòng này
      }
      if (!intent || intent.op !== 'write' || typeof intent.tmp !== 'string') continue;
      const tmpPath = path.isAbsolute(intent.tmp) ? intent.tmp : path.join(dataDir, path.basename(intent.tmp));
      let tmpRaw;
      try {
        tmpRaw = await fs.readFile(tmpPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') continue; // crash trước khi tmp ra đời → discard
        throw err;
      }
      let valid = false;
      try {
        JSON.parse(tmpRaw); // tmp phải là JSON hoàn chỉnh
        if (intent.sha256) {
          const digest = crypto.createHash('sha256').update(tmpRaw, 'utf8').digest('hex');
          // tmp được ghi kèm '\n' cuối file nhưng sha tính trên payload (không '\n':
          // chấp nhận cả hai dạng để tương thích crash giữa chừng.
          const digestNoNl = crypto.createHash('sha256')
            .update(tmpRaw.endsWith('\n') ? tmpRaw.slice(0, -1) : tmpRaw, 'utf8').digest('hex');
          valid = digest === intent.sha256 || digestNoNl === intent.sha256;
        } else {
          valid = true;
        }
      } catch {
        valid = false;
      }
      if (valid) {
        await fs.rename(tmpPath, file); // REPLAY intent đã fsync đầy đủ
        replayed = tmpPath;
      } else {
        await fs.unlink(tmpPath).catch(() => {}); // DISCARD tmp dở/corrupt
      }
    }
    await writeFileSynced(journalFile, ''); // truncate → idempotent
    await fsyncDir(dataDir);
    return { recovered: true, replayed };
  }

  async function persist() {
    if (pgAdapter) {
      await pgAdapter.persist(store.data);
      return 'postgres';
    }
    const payload = JSON.stringify(
      { version: 1, schemaVersion: SCHEMA_VERSION, updatedAt: nowIso(), ...store.data },
      null,
      2
    );
    const digest = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    // 1. Journal intent TRƯỚC khi đụng tới db.json (fsync để crash-safe).
    const intent = JSON.stringify({
      op: 'write', tmp: path.basename(tmp), sha256: digest,
      bytes: Buffer.byteLength(payload, 'utf8'), at: nowIso(),
    }) + '\n';
    const jh = await fs.open(journalFile, 'a');
    try {
      await jh.write(intent, null, 'utf8');
      await jh.sync();
    } finally {
      await jh.close();
    }
    // 2. Ghi tmp + fsync → 3. rename atomic → 4. truncate journal.
    await writeFileSynced(tmp, payload + '\n');
    await fs.rename(tmp, file);
    await fsyncDir(dataDir);
    await writeFileSynced(journalFile, '');
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

  store.close = async function close() {
    if (pgAdapter) {
      await pgAdapter.close();
    }
  };
  /** Seams cho test journal (không dùng trong production code). */
  store.recoverJournal = recoverJournal;

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
