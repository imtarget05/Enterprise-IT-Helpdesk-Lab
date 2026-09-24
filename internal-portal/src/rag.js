'use strict';

/**
 * RAG — truy vấn tri thức doanh nghiệp (tickets/ + docs/) cho AI phân tích.
 *
 * Zero-dependency (chỉ dùng fs + fetch global):
 *  - Chunking theo header ## (mirror python-portal/rag/chunking.py).
 *  - Embedding: Ollama /api/embeddings (nomic-embed-text) nếu có,
 *    fallback hash-TF deterministic (mirror vectors.py) → demo/CI không gãy.
 *  - Vector store: Qdrant REST (QDRANT_URL) nếu reachable,
 *    fallback InMemory cosine trên RAM.
 *
 * API: retrieve(query, topK) → [{text, source, section, score}]
 *      formatContext(hits) → string ghép vào prompt Qwen
 *      ragStatus() → {chunks, mode, backend} cho GET /api/ai/status
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const QDRANT_URL = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '');
const COLLECTION = process.env.QDRANT_COLLECTION || 'it_helpdesk_runbooks';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const HASH_DIM = 384;
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

// --- Chunking ---------------------------------------------------------------
function chunkMarkdown(text, source) {
  const clean = str(text).replace(/\r\n/g, '\n');
  if (!clean) return [];
  const parts = [];
  let header = '';
  let buf = [];
  for (const line of clean.split('\n')) {
    const m = line.trim().match(/^(#{2,3})\s+(.+)$/);
    if (m) {
      if (buf.join('\n').trim()) parts.push([header, buf.join('\n').trim()]);
      header = m[2].trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.join('\n').trim()) parts.push([header, buf.join('\n').trim()]);

  const chunks = [];
  for (const [h, body] of parts) {
    const prefix = h ? `[${source} | ${h}]\n` : `[${source}]\n`;
    let start = 0;
    while (start < body.length) {
      chunks.push({ text: prefix + body.slice(start, start + CHUNK_SIZE), source, section: h || 'general' });
      if (start + CHUNK_SIZE >= body.length) break;
      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  }
  return chunks;
}

function loadChunks() {
  const chunks = [];
  for (const sub of ['tickets', 'docs']) {
    const dir = path.join(REPO_ROOT, sub);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    } catch { /* thư mục thiếu → bỏ qua */ }
    for (const f of files) {
      try {
        chunks.push(...chunkMarkdown(fs.readFileSync(path.join(dir, f), 'utf8'), `${sub}/${f}`));
      } catch { /* file lỗi → bỏ qua */ }
    }
  }
  return chunks;
}

// --- Embeddings ---------------------------------------------------------------
function l2norm(vec) {
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / n);
}

function hashEmbed(text, dim = HASH_DIM) {
  const vec = new Array(dim).fill(0);
  const toks = (text.toLowerCase().match(/[a-z0-9à-ỹ]+/gi) || []);
  for (const tok of toks) {
    const h = parseInt(crypto.createHash('md5').update(tok).digest('hex').slice(0, 8), 16);
    vec[h % dim] += 1;
    vec[Math.floor(h / 7) % dim] += 0.15;
  }
  return l2norm(vec);
}

async function ollamaEmbedBatch(texts, fetchImpl) {
  const out = [];
  for (const t of texts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetchImpl(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: t.slice(0, 2000) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.embedding) throw new Error('empty embedding');
      out.push(l2norm(data.embedding));
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

// --- Index (lazy, cache trong process) ---------------------------------------
let cache = null; // {chunks, vecs, backend, dim}

async function getIndex(fetchImpl) {
  if (cache) return cache;
  const chunks = loadChunks();
  const fetchFn = fetchImpl || globalThis.fetch;
  let vecs = null;
  let backend = 'hash-tf';
  try {
    vecs = await ollamaEmbedBatch(chunks.map((c) => c.text), fetchFn);
    backend = `ollama:${EMBED_MODEL}`;
  } catch {
    vecs = chunks.map((c) => hashEmbed(c.text));
  }
  cache = { chunks, vecs, backend, dim: vecs.length ? vecs[0].length : HASH_DIM };
  return cache;
}

// --- Qdrant (optional, fail-soft) ----------------------------------------------
async function qdrantSearch(vector, topK, fetchImpl) {
  const post = async (p, body) => {
    const res = await fetchImpl(`${QDRANT_URL}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Qdrant HTTP ${res.status}`);
    return res.json();
  };
  const data = await post(`/collections/${COLLECTION}/points/search`, {
    vector, limit: topK, with_payload: true,
  });
  return (data.result || []).map((pt) => ({ score: pt.score, ...(pt.payload || {}) }));
}

function memorySearch(chunks, vecs, vector, topK) {
  const scored = chunks.map((c, i) => {
    let s = 0;
    const v = vecs[i];
    for (let j = 0; j < vector.length && j < v.length; j++) s += vector[j] * v[j];
    return { score: Math.round(s * 10000) / 10000, text: c.text, source: c.source, section: c.section };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * Truy vấn tri thức doanh nghiệp. Không bao giờ throw — lỗi → [].
 */
async function retrieve(query, topK = 3, options = {}) {
  try {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const { chunks, vecs, backend } = await getIndex(options.fetchImpl);
    if (!chunks.length) return [];
    let qv;
    if (backend.startsWith('ollama:')) {
      try {
        [qv] = await ollamaEmbedBatch([query], fetchImpl);
      } catch {
        qv = hashEmbed(query, vecs[0].length);
      }
    } else {
      qv = hashEmbed(query, vecs[0].length);
    }
    // Thử Qdrant trước (đã ingest), lỗi → memory
    if (!options.memoryOnly) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const hits = await qdrantSearch(qv, topK, (u, o) => fetchImpl(u, { ...o, signal: controller.signal }));
        clearTimeout(timer);
        if (hits.length) return hits;
      } catch { /* rơi xuống memory */ }
    }
    return memorySearch(chunks, vecs, qv, topK);
  } catch {
    return [];
  }
}

function formatContext(hits) {
  if (!hits.length) return '';
  const lines = ['KIẾN THỨC NỘI BỘ (trích runbook công ty, ưu tiên cao hơn kiến thức chung):'];
  hits.forEach((h, i) => lines.push(`[${i + 1}] (${h.source || '?'} | ${h.section || ''}) ${str(h.text).slice(0, 600)}`));
  return lines.join('\n');
}

async function ragStatus(options = {}) {
  try {
    const { chunks, backend } = await getIndex(options.fetchImpl);
    let qdrant = false;
    try {
      const res = await (options.fetchImpl || globalThis.fetch)(`${QDRANT_URL}/`, {});
      qdrant = res.ok;
    } catch { /* không có Qdrant */ }
    return { chunks: chunks.length, mode: qdrant ? 'qdrant' : 'memory', backend };
  } catch (err) {
    return { chunks: 0, mode: 'disabled', backend: 'none', error: err.message };
  }
}

module.exports = { retrieve, formatContext, ragStatus, loadChunks, hashEmbed };
