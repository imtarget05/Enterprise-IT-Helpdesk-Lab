'use strict';

/**
 * Queue abstraction for approved automation jobs.
 *
 * Two implementations, one contract:
 *
 *  · `createDurableQueue` — the real one. Messages are written to disk so a
 *    process restart between "enqueued" and "executed" does not lose the job.
 *    This is what makes the crash-window tests meaningful.
 *
 *  · `createInMemoryQueue` — for tests that only care about publish semantics. It
 *    is explicitly NOT durable and says so in its own `kind`, because a
 *    durable-approval claim that silently ran on an in-memory queue would be a
 *    false evidence claim.
 *
 * The queue is a TRANSPORT, never an authority. It stores an envelope of
 * identifiers; approval, risk, catalog membership and the payload hash are all
 * re-checked by the worker against the durable store. Publishing grants nothing.
 *
 * Dead-lettering is part of the contract, not an afterthought: a job that keeps
 * failing must end up somewhere an operator can see and replay, never in an
 * infinite redelivery loop.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { MESSAGE_SCHEMA_VERSION } = require('./action-lifecycle');

/** Fields an envelope must carry to be considered well-formed. */
const REQUIRED_FIELDS = Object.freeze(['schemaVersion', 'jobId', 'proposalId', 'tenantId', 'idempotencyKey']);

function validateEnvelope(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, code: 'INVALID_MESSAGE', error: 'message must be an object' };
  }
  const missing = REQUIRED_FIELDS.filter((f) => message[f] === undefined || message[f] === null || message[f] === '');
  if (missing.length) return { ok: false, code: 'INVALID_MESSAGE', error: `missing: ${missing.join(',')}`, missing };
  if (message.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
    // Refusing an unknown version is the whole point of carrying one: a consumer
    // must not execute a message whose shape it does not understand.
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      error: `schemaVersion ${message.schemaVersion} is not supported (expected ${MESSAGE_SCHEMA_VERSION})`,
    };
  }
  return { ok: true };
}

/**
 * Transient vs permanent. Only infrastructure-level conditions earn a retry; a
 * policy refusal must NOT be retried, because retrying it burns budget and
 * eventually dead-letters something that is not a flaky dependency.
 */
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', '429', '502', '503', '504']);

function isTransient(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  if (error.retryable === false) return false;
  const code = error.code || error.name || '';
  if (TRANSIENT_CODES.has(code)) return true;
  const status = Number(error.status || error.statusCode || 0);
  return [429, 502, 503, 504].includes(status);
}

/**
 * Durable queue backed by JSON files.
 *
 * Writes are atomic (tmp + rename) and serialised through a promise chain, so two
 * concurrent publishes cannot interleave into a corrupt file.
 */
function createDurableQueue(options = {}) {
  const dir = options.dir ? path.resolve(options.dir) : null;
  const maxAttempts = Number(options.maxAttempts || 5);

  if (!dir) throw new Error('createDurableQueue requires options.dir');
  fs.mkdirSync(dir, { recursive: true });

  const files = {
    pending: path.join(dir, 'queue-pending.json'),
    dead: path.join(dir, 'queue-dead.json'),
    history: path.join(dir, 'queue-history.json'),
  };

  let writeChain = Promise.resolve();

  function read(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      // A corrupt file must not silently become "no messages" and cause work to
      // be dropped. Fail loudly; an operator restores or inspects it.
      throw new Error(`queue file is corrupt: ${file}`);
    }
  }

  function writeAtomic(file, value) {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    writeChain = writeChain.then(async () => {
      await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, file);
    });
    return writeChain;
  }

  const queue = {
    kind: 'durable-file',
    durable: true,
    maxAttempts,
    dir,

    async publish(message) {
      const check = validateEnvelope(message);
      if (!check.ok) throw Object.assign(new Error(check.error), { code: check.code });
      await writeChain;
      const pending = read(files.pending, []);
      // At-least-once means the same jobId may legitimately arrive twice. The
      // queue de-duplicates by jobId: re-publishing a pending id is a no-op, not
      // a second job.
      if (pending.some((m) => m.jobId === message.jobId)) {
        return { ok: true, deduplicated: true, jobId: message.jobId };
      }
      pending.push(message);
      await writeAtomic(files.pending, pending);
      return { ok: true, deduplicated: false, jobId: message.jobId };
    },

    async receive() {
      await writeChain;
      const pending = read(files.pending, []);
      return pending.length ? pending[0] : null;
    },

    /** Remove a message after the worker has durably completed it. */
    async complete(message, result) {
      await writeChain;
      const pending = read(files.pending, []);
      const idx = pending.findIndex((m) => m.jobId === message.jobId);
      if (idx === -1) return { ok: false, code: 'NOT_FOUND' };
      pending.splice(idx, 1);
      await writeAtomic(files.pending, pending);

      const history = read(files.history, []);
      history.push({
        jobId: message.jobId,
        outcome: 'completed',
        at: new Date().toISOString(),
        status: result && result.status,
      });
      await writeAtomic(files.history, history);
      return { ok: true };
    },

    /** Bounded retry for transient causes, then dead-letter with a reason. */
    async fail(message, error) {
      await writeChain;
      const pending = read(files.pending, []);
      const idx = pending.findIndex((m) => m.jobId === message.jobId);
      if (idx === -1) return { ok: false, code: 'NOT_FOUND' };
      // `attempt` is the number of the attempt that JUST failed. Retrying is allowed
      // while fewer than `maxAttempts` attempts have been made, i.e. while
      // `attempt < maxAttempts`. A previous version computed the NEXT attempt
      // number first and compared that, which made the effective budget one
      // attempt smaller than configured — a retryable job was dead-lettered on
      // its second delivery instead of its third.
      const attempt = Number(message.attempt || 1);

      if (attempt < maxAttempts && isTransient(error)) {
        pending[idx] = { ...message, attempt: attempt + 1 };
        await writeAtomic(files.pending, pending);
        return { ok: true, retried: true, attempt: attempt + 1 };
      }

      pending.splice(idx, 1);
      await writeAtomic(files.pending, pending);

      const dead = read(files.dead, []);
      dead.push({
        ...message,
        attempt,
        deadLetteredAt: new Date().toISOString(),
        reason: String((error && error.reason) || (error && error.message) || 'unknown').slice(0, 500),
        code: (error && error.code) || 'UNKNOWN',
      });
      await writeAtomic(files.dead, dead);
      return { ok: true, retried: false, deadLettered: true, attempt };
    },

    async deadLetters() {
      await writeChain;
      return read(files.dead, []);
    },

    /**
     * Replay is explicit and idempotent: it re-publishes a dead letter under its
     * original jobId, and `publish` de-duplicates, so replaying the same DLQ entry
     * twice cannot create two jobs.
     */
    async replay(jobId) {
      await writeChain;
      const dead = read(files.dead, []);
      const entry = dead.find((m) => m.jobId === jobId);
      if (!entry) return { ok: false, code: 'NOT_IN_DLQ' };
      const remaining = dead.filter((m) => m.jobId !== jobId);
      await writeAtomic(files.dead, remaining);
      const republished = await queue.publish({ ...entry, attempt: 1 });
      return { ok: true, jobId, deduplicated: republished.deduplicated };
    },

    async depth() {
      await writeChain;
      return read(files.pending, []).length;
    },

    async close() {
      await writeChain;
    },
  };

  return queue;
}
/**
 * In-memory queue for tests that only exercise publish semantics.
 *
 * `durable: false` is stated in the object so a test that claims durability can
 * be caught by reading the queue's own kind rather than by trusting the harness.
 */
function createInMemoryQueue(options = {}) {
  const pending = [];
  const dead = [];
  const maxAttempts = Number(options.maxAttempts || 5);

  const queue = {
    kind: 'in-memory',
    durable: false,
    maxAttempts,

    async publish(message) {
      const check = validateEnvelope(message);
      if (!check.ok) throw Object.assign(new Error(check.error), { code: check.code });
      if (pending.some((m) => m.jobId === message.jobId)) return { ok: true, deduplicated: true };
      pending.push(message);
      return { ok: true, deduplicated: false };
    },

    async receive() {
      return pending.length ? pending[0] : null;
    },

    async complete(message) {
      const i = pending.findIndex((m) => m.jobId === message.jobId);
      if (i === -1) return { ok: false, code: 'NOT_FOUND' };
      pending.splice(i, 1);
      return { ok: true };
    },

    async fail(message, error) {
      const i = pending.findIndex((m) => m.jobId === message.jobId);
      if (i === -1) return { ok: false, code: 'NOT_FOUND' };
      // Same accounting as the durable queue: `attempt` is the attempt that just
      // failed, and retrying is allowed while `attempt < maxAttempts`.
      const attempt = Number(message.attempt || 1);
      if (attempt < maxAttempts && isTransient(error)) {
        pending[i] = { ...message, attempt: attempt + 1 };
        return { ok: true, retried: true, attempt: attempt + 1 };
      }
      pending.splice(i, 1);
      dead.push({ ...message, attempt, reason: String((error && error.reason) || 'unknown') });
      return { ok: true, retried: false, deadLettered: true, attempt };
    },

    async deadLetters() {
      return dead;
    },

    async replay(jobId) {
      const i = dead.findIndex((m) => m.jobId === jobId);
      if (i === -1) return { ok: false, code: 'NOT_IN_DLQ' };
      const [entry] = dead.splice(i, 1);
      await queue.publish({ ...entry, attempt: 1 });
      return { ok: true, jobId };
    },

    async depth() {
      return pending.length;
    },

    async close() {},
  };

  return queue;
}

module.exports = { createDurableQueue, createInMemoryQueue, validateEnvelope, isTransient, MESSAGE_SCHEMA_VERSION };