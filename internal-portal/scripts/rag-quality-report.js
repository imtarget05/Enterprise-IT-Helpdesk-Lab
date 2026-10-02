'use strict';

/**
 * Retrieval quality report.
 *
 * Runs the golden set against the live retriever and prints the aggregates.
 * This is a MEASUREMENT tool, not a gate: it exists so "RAG quality is
 * NOT_MEASURED" can be replaced with an actual number, and so a future change
 * to the corpus or chunker can be compared against a recorded baseline rather
 * than against an impression.
 *
 * The gate lives in the test suite. This script prints whatever the retriever
 * actually does today, including numbers that are not good enough — a report
 * that could only ever look flattering would not be a measurement.
 *
 * Run: node scripts/rag-quality-report.js
 */

const { loadChunks, hashEmbed, memorySearch, DEFAULT_TENANT } = require('../src/rag');
const { evaluate } = require('../src/rag-eval');
const { GOLDEN_SET, ANSWERABLE_QUERIES } = require('../test/fixtures/rag-golden');

const K = Number(process.env.RAG_EVAL_K || 5);

/**
 * Rank source FILES using the PRODUCTION search path, preserving its order.
 *
 * Deliberately identical to the ranker in `rag-quality.test.js`. A report that
 * scored its own copy of the algorithm could disagree with the gate that
 * enforces the thresholds, and then the printed numbers would be fiction.
 */
function rankSources(query, k) {
  const chunks = loadChunks();
  const vecs = chunks.map((c) => hashEmbed(c.text));
  const hits = memorySearch(chunks, vecs, hashEmbed(query), chunks.length, DEFAULT_TENANT);
  const seen = new Set();
  const ordered = [];
  for (const hit of hits) {
    if (seen.has(hit.source)) continue;
    seen.add(hit.source);
    ordered.push(hit.source);
  }
  return ordered.slice(0, k);
}

const result = evaluate(ANSWERABLE_QUERIES, rankSources, { k: K });

console.log(`RAG retrieval quality — K=${K}, answerable queries=${result.aggregates.queryCount}`);
console.log('corpus: real documents/, tickets/ via the offline hash-TF backend\n');
for (const [name, value] of Object.entries(result.aggregates)) {
  console.log(`  ${name.padEnd(11)} ${typeof value === 'number' ? value.toFixed(4) : value}`);
}

const worst = [...result.perQuery]
  .sort((a, b) => a.recall - b.recall || a.reciprocalRank - b.reciprocalRank)
  .slice(0, 8);

console.log('\nWeakest queries (this is where to improve, not a failure list):');
for (const q of worst) {
  console.log(
    `  recall=${q.recall.toFixed(2)} rr=${q.reciprocalRank.toFixed(2)} `
    + `hits=${q.hitCount}/${q.relevant.length}  ${q.query.slice(0, 56)}`,
  );
}

console.log(`\nAbstention queries in the golden set: ${GOLDEN_SET.length - ANSWERABLE_QUERIES.length}`);
console.log('Groundedness/faithfulness: NOT MEASURED — requires a generated answer set.');