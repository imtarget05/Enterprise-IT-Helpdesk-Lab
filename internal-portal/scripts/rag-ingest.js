'use strict';

/**
 * Ingest tri thức runbook vào Qdrant (chạy 1 lần, chạy lại khi sửa runbook).
 *
 *   node scripts/rag-ingest.js              # QDRANT_URL mặc định 127.0.0.1:6333
 *   QDRANT_URL=http://qdrant:6333 node scripts/rag-ingest.js
 *
 * Không cần Ollama: embedding dùng nomic-embed-text nếu có,
 * fallback hash-TF offline (cùng backend với src/rag.js runtime).
 */
const { loadChunks, hashEmbed } = require('../src/rag');

const QDRANT_URL = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '');
const COLLECTION = process.env.QDRANT_COLLECTION || 'it_helpdesk_runbooks';

async function req(method, p, body) {
  const res = await fetch(`${QDRANT_URL}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function embedAll(texts) {
  const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  try {
    const out = [];
    for (const t of texts) {
      const res = await fetch(`${ollamaUrl}/api/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text', prompt: t.slice(0, 2000) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.embedding) throw new Error('empty');
      const v = data.embedding;
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      out.push(v.map((x) => x / n));
    }
    return { vecs: out, backend: 'ollama', dim: out[0].length };
  } catch {
    return { vecs: texts.map((t) => hashEmbed(t)), backend: 'hash-tf', dim: 384 };
  }
}

(async () => {
  const chunks = loadChunks();
  console.log(`chunks: ${chunks.length}`);
  const { vecs, backend, dim } = await embedAll(chunks.map((c) => c.text));
  console.log(`backend: ${backend}, dim: ${dim}`);

  await req('DELETE', `/collections/${COLLECTION}`).catch(() => {});
  await req('PUT', `/collections/${COLLECTION}`, { vectors: { size: dim, distance: 'Cosine' } });

  const crypto = require('node:crypto');
  const points = chunks.map((c, i) => ({
    id: parseInt(crypto.createHash('md5').update(`${c.source}#${i}`).digest('hex').slice(0, 8), 16),
    vector: vecs[i],
    payload: { text: c.text, source: c.source, section: c.section },
  }));
  for (let s = 0; s < points.length; s += 64) {
    await req('PUT', `/collections/${COLLECTION}/points?wait=true`, { points: points.slice(s, s + 64) });
    console.log(`upsert ${Math.min(s + 64, points.length)}/${points.length}`);
  }
  console.log('ingest xong.');
})().catch((err) => { console.error('ingest lỗi:', err.message); process.exit(1); });
