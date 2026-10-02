'use strict';

/**
 * Quality-gate mutation harness.
 *
 * A quality gate that cannot fail is worse than no gate: it reports confidence
 * nobody earned. Each mutation here breaks retrieval in a specific way and the
 * gate must notice.
 *
 * Two properties matter beyond "the numbers move":
 *
 *   1. The METRICS are mutated too, not only the retriever. If recall were
 *      computed wrongly — always 1, say — every quality number would look great
 *      and the suite would still pass. Mutating the ruler catches that.
 *   2. A retriever that returns NOTHING must fail the gate. That is the
 *      property which distinguishes a gate from a print statement.
 *
 * Run: node scripts/rag-quality-mutation-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RAG = path.resolve(ROOT, 'src', 'rag.js');
const EVAL = path.resolve(ROOT, 'src', 'rag-eval.js');
const GATE = path.resolve(ROOT, 'test', 'rag-quality.test.js');

const MUTATIONS = [
  {
    id: 'M-Q1',
    name: 'retriever returns nothing (the broken-retriever control)',
    file: RAG,
    find: '  return scored.sort((a, b) => b.score - a.score).slice(0, topK);',
    replace: '  return [];',
  },
  {
    id: 'M-Q2',
    name: 'scoring becomes random instead of by similarity',
    // NOT "reverse the sort": the document-level ranker in the test re-sorts by
    // score, so reversing `memorySearch`'s order is invisible to it. That
    // re-sort is deliberate robustness, not an oversight — but it means the
    // mutation has to corrupt the SCORE, which is what ranking actually depends
    // on. A constant score makes the ordering arbitrary.
    file: RAG,
    find: '  return scored.sort((a, b) => b.score - a.score).slice(0, topK);',
    replace: '  return scored.sort(() => 0).slice(0, topK);',
  },
  {
    id: 'M-Q3',
    name: 'retriever returns only the single best hit',
    file: RAG,
    find: '  return scored.sort((a, b) => b.score - a.score).slice(0, topK);',
    replace: '  return scored.sort((a, b) => b.score - a.score).slice(0, 1);',
  },
  {
    id: 'M-Q4',
    name: 'recall always returns 1 (the ruler is broken)',
    // The failure this exists to catch: a metric that cannot report failure
    // turns every quality number into a compliment.
    file: EVAL,
    find: '  if (!relevant.length) return 0;\n  const top = new Set(ranked.slice(0, k));\n  let hits = 0;\n  for (const id of relevant) if (top.has(id)) hits += 1;\n  return hits / relevant.length;',
    replace: '  return 1;',
  },
  {
    id: 'M-Q5',
    name: 'reciprocal rank always 1 (ranking quality no longer measured)',
    file: EVAL,
    find: '  const index = ranked.findIndex((id) => rel.has(id));\n  return index >= 0 ? 1 / (index + 1) : 0;',
    replace: '  return 1;',
  },
  {
    id: 'M-Q6',
    name: 'abstention fails open (a missing score answers anyway)',
    file: EVAL,
    find: "  if (score === null || score === undefined || score === '' || typeof score === 'boolean') {\n    return { abstain: true, reason: 'no_retrieval_score' };\n  }",
    replace: '  void score;',
  },
];

const originals = new Map();
for (const f of [RAG, EVAL]) originals.set(f, fs.readFileSync(f, 'utf8'));
const results = [];

function runGate() {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=60000', '--test-force-exit', GATE], {
    encoding: 'utf8',
    timeout: 180000,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0) return { failed: false };
  return { failed: true, status: r.status, assertionFailure: /AssertionError|ERR_ASSERTION/.test(output) };
}

try {
  for (const m of MUTATIONS) {
    const original = originals.get(m.file);
    if (!original.includes(m.find)) {
      results.push({ id: m.id, name: m.name, outcome: 'ERROR: anchor not found — mutation did not apply' });
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.find, m.replace));
    const { failed, status, assertionFailure } = runGate();
    // Restore immediately: the next mutation must not inherit this one.
    fs.writeFileSync(m.file, original);
    results.push({
      id: m.id,
      name: m.name,
      outcome: failed && assertionFailure
        ? 'CAUGHT (assertion failed)'
        : failed
          ? `UNCATCHED — gate exited ${status} with no assertion failure`
          : 'SURVIVED — the gate passed with this mutation applied',
      weak: failed && !assertionFailure,
    });
  }
} finally {
  for (const [f, original] of originals) fs.writeFileSync(f, original);
}

const restored = runGate();
const survived = results.filter((r) => r.outcome.startsWith('SURVIVED') || r.outcome.startsWith('ERROR'));
const weak = results.filter((r) => r.weak);
const caught = results.filter((r) => r.outcome.startsWith('CAUGHT'));

for (const r of results) console.log(`${r.id.padEnd(6)} ${r.outcome}\n       ${r.name}`);
console.log(`\nbaseline restored: ${restored.failed ? 'FAILING' : 'green'}`);
console.log(`${caught.length}/${results.length} mutations caught`);
process.exit(survived.length === 0 && weak.length === 0 && !restored.failed ? 0 : 1);