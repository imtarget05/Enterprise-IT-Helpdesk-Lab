'use strict';

/**
 * RAG retrieval quality: measured, gated, and honest about what it cannot see.
 *
 * Wave A proved retrieval is isolated and citabale. It said nothing about
 * whether it is any good. This suite supplies the measurement and, more
 * importantly, the META-tests: a quality gate that would still pass if the
 * metrics themselves were broken is worse than no gate, because it reports
 * confidence it has not earned.
 *
 * Order matters here. The metric tests come FIRST and use hand-checkable
 * rankings, so when the golden-set numbers move we know whether the retriever
 * changed or the ruler did.
 *
 * What is NOT measured, stated up front:
 *   · groundedness / faithfulness — needs a GENERATED ANSWER set. This repo's
 *     default path is an offline rule-based engine with no model in the loop, so
 *     scoring a template's faithfulness produces a number that means nothing.
 *   · tenant-private corpus — every real document is `__shared__` today.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  recallAtK, precisionAtK, reciprocalRank, meanReciprocalRank,
  dcgAtK, ndcgAtK, scoreQuery, evaluate, shouldAbstain, DEFAULT_K,
} = require('../src/rag-eval');
const { loadChunks, hashEmbed, memorySearch, DEFAULT_TENANT } = require('../src/rag');
const { GOLDEN_SET, ANSWERABLE_QUERIES, ABSTENTION_QUERIES } = require('./fixtures/rag-golden');

// ---------------------------------------------------------------------------
// The ruler, before the thing being measured.
//
// Every case below has an answer that can be checked by hand. If these fail,
// no golden-set number means anything.
// ---------------------------------------------------------------------------

describe('retrieval metrics are correct', () => {
  test('recall counts how many gold items reached the top K', () => {
    const ranked = ['a', 'x', 'b', 'y', 'c'];
    // Gold {a, b}: both in top 3 -> 1.0. Top 1 -> only a -> 0.5.
    assert.equal(recallAtK(ranked, ['a', 'b'], 3), 1);
    assert.equal(recallAtK(ranked, ['a', 'b'], 1), 0.5);
  });

  test('recall is 0 when the gold item is absent entirely', () => {
    assert.equal(recallAtK(['a', 'b'], ['zzz'], 5), 0);
  });

  test('a query with no gold item scores 0, not 1', () => {
    // Scoring "nothing relevant" as perfect would reward returning nothing at
    // all — the opposite of a working retriever.
    assert.equal(recallAtK([], [], 5), 0);
    assert.equal(recallAtK(['a'], [], 5), 0);
  });

  test('precision measures the returned list, recall the gold list', () => {
    const ranked = ['a', 'x', 'y'];
    // 1 of 3 returned is relevant.
    assert.equal(precisionAtK(ranked, ['a'], 3), 1 / 3);
    // Recall asks a different question: 1 of 1 gold item was found.
    assert.equal(recallAtK(ranked, ['a'], 3), 1);
  });

  test('reciprocal rank rewards early hits and scores a miss as 0', () => {
    assert.equal(reciprocalRank(['a', 'b'], ['a']), 1);
    assert.equal(reciprocalRank(['x', 'a'], ['a']), 0.5);
    assert.equal(reciprocalRank(['x', 'y', 'a'], ['a']), 1 / 3);
    assert.equal(reciprocalRank(['x', 'y'], ['a']), 0);
  });

  test('DCG discounts later positions', () => {
    assert.ok(dcgAtK(['a'], ['a'], 3) > dcgAtK(['x', 'a'], ['a'], 3));
  });

  test('NDCG is 1.0 for a perfect ranking and below 1 otherwise', () => {
    assert.equal(ndcgAtK(['a', 'b', 'c'], ['a', 'b'], 5), 1);
    const imperfect = ndcgAtK(['x', 'y', 'a'], ['a'], 5);
    assert.ok(imperfect < 1, `NDCG of a visibly wrong ranking was ${imperfect}`);
    assert.ok(imperfect > 0);
  });

  test('MRR averages over queries that have a gold item', () => {
    const ranked = new Map([['q1', ['a']], ['q2', ['x', 'a']]]);
    const relevant = new Map([['q1', ['a']], ['q2', ['a']]]);
    // (1 + 0.5) / 2
    assert.equal(meanReciprocalRank(ranked, relevant), 0.75);
  });

  test('MRR excludes queries with no gold item rather than scoring them 0', () => {
    const ranked = new Map([['q1', ['a']], ['q-none', ['x']]]);
    const relevant = new Map([['q1', ['a']], ['q-none', []]]);
    assert.equal(meanReciprocalRank(ranked, relevant), 1, 'an unanswerable query dragged MRR down');
  });

  test('a retriever returning nothing scores zero across the board', () => {
    // The property that matters most: a broken retriever must not look good.
    const s = scoreQuery([], ['a', 'b'], 5);
    assert.equal(s.recall, 0);
    assert.equal(s.precision, 0);
    assert.equal(s.reciprocalRank, 0);
    assert.equal(s.ndcg, 0);
  });

  test('a perfect retriever scores 1.0 across the board', () => {
    const s = scoreQuery(['a', 'b'], ['a', 'b'], 5);
    assert.equal(s.recall, 1);
    assert.equal(s.precision, 1);
    assert.equal(s.reciprocalRank, 1);
    assert.equal(s.ndcg, 1);
  });
});

describe('evaluate aggregates without hiding per-query detail', () => {
  test('aggregates are computed and per-query rows are retained', () => {
    const golden = [
      { query: 'q1', relevant: ['a'] },
      { query: 'q2', relevant: ['b'] },
      { query: 'q3', relevant: ['c'] },
    ];
    // q1 hits at rank 1, q2 at rank 2, q3 never. One top-1 miss.
    const rankings = { q1: ['a', 'x'], q2: ['x', 'b'], q3: ['x', 'y'] };
    const result = evaluate(golden, (q) => rankings[q], { k: 2 });
    assert.equal(result.perQuery.length, 3);
    assert.equal(result.aggregates.queryCount, 3);
    assert.equal(result.aggregates.top1Misses, 1);
    // MRR averages over queries where a relevant item WAS returned: q1 (1),
    // q2 (0.5) -> 0.75. q3 returned nothing relevant, so it is excluded rather
    // than averaged in as a zero — a query the retriever could not answer is a
    // different failure from one it answered at rank 2.
    assert.ok(Math.abs(result.aggregates.mrr - 0.75) < 1e-9, `mrr was ${result.aggregates.mrr}`);
    // Recall, unlike MRR, counts the miss.
    assert.ok(Math.abs(result.aggregates.recall - 2 / 3) < 1e-9);
  });

  test('each row carries the gold set so a report can explain itself', () => {
    const result = evaluate([{ query: 'q', relevant: ['a'] }], () => ['z'], { k: 2 });
    assert.deepEqual(result.perQuery[0].relevant, ['a']);
  });
});

// ---------------------------------------------------------------------------
// The golden set itself. A gate over numbers derived from a dataset that is
// wrong measures nothing, so the dataset is validated before it is trusted.
// ---------------------------------------------------------------------------

describe('the golden set references the real corpus', () => {
  const sources = new Set(loadChunks().map((c) => c.source));

  test('every gold document actually exists', () => {
    const missing = [];
    for (const item of GOLDEN_SET) {
      for (const ref of item.relevant) {
        if (!sources.has(ref)) missing.push(`${ref} (query: ${item.query})`);
      }
    }
    assert.deepEqual(missing, [], `golden set cites documents not in the corpus:\n${missing.join('\n')}`);
  });

  test('every answerable query names at least one gold document', () => {
    for (const item of ANSWERABLE_QUERIES) {
      assert.ok(item.relevant.length > 0, `"${item.query}" has no gold document`);
    }
  });

  test('abstention queries name no gold document, by construction', () => {
    for (const item of GOLDEN_SET.filter((q) => q.abstain)) {
      assert.deepEqual(item.relevant, [], `"${item.query}" is marked abstainable but names a document`);
    }
  });

  test('the dataset covers both ranking and abstention', () => {
    // A set of only answerable queries cannot test the refusal path; one of
    // only unanswerable queries cannot test ranking.
    assert.ok(ANSWERABLE_QUERIES.length >= 20, 'too few answerable queries to be meaningful');
    assert.ok(ABSTENTION_QUERIES.length >= 4, 'too few abstention queries to be meaningful');
  });

  test('queries are distinct', () => {
    const seen = new Set();
    for (const item of GOLDEN_SET) {
      assert.equal(seen.has(item.query), false, `duplicate query: ${item.query}`);
      seen.add(item.query);
    }
  });
});

// ---------------------------------------------------------------------------
// Retrieval quality against the real corpus.
//
// Thresholds sit BELOW the measured values, with headroom, so they catch real
// regressions rather than normal drift. They are a floor, not a target — the
// report script prints the actual numbers.
// ---------------------------------------------------------------------------

describe('retrieval quality against the real corpus', () => {
  const K = 5;

  /**
   * Rank source FILES using the PRODUCTION search path.
   *
   * Two properties this must keep, both learned the hard way:
   *
   * 1. It calls `memorySearch`, not a locally-written cosine loop. The first
   *    version of this file scored its own implementation, and M-Q1 made
   *    `memorySearch` return nothing while the gate still passed — the gate was
   *    measuring code the product does not run.
   *
   * 2. It preserves `memorySearch`'s ORDER rather than re-sorting by score. That
   *    sounds redundant, but the reverse-sort mutation (M-Q2) survived a
   *    re-sorting ranker, because collapsing chunks to documents and sorting
   *    again by score silently undid the break. Trusting the production order is
   *    what makes a regression in that order visible.
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
  const a = result.aggregates;

  test('measured aggregates are reported for review', () => {
    // Always prints. A quality suite whose numbers nobody sees is one nobody
    // acts on.
    console.log(`    RAG@${K}: recall=${a.recall.toFixed(3)} precision=${a.precision.toFixed(3)} `
      + `mrr=${a.mrr.toFixed(3)} ndcg=${a.ndcg.toFixed(3)} top1Misses=${a.top1Misses}/${a.queryCount}`);
  });

  test('recall@5 clears the floor', () => {
    // Measured 0.839. Below 0.75 is a real regression: the retriever has stopped
    // finding documents that exist in the corpus.
    assert.ok(a.recall >= 0.75, `recall@${K} fell to ${a.recall.toFixed(3)}`);
  });

  test('MRR clears the floor', () => {
    // Measured 0.633. This is the metric that notices the right document being
    // pushed down the list, which recall alone would not.
    assert.ok(a.mrr >= 0.55, `MRR fell to ${a.mrr.toFixed(3)}`);
  });

  test('NDCG@5 clears the floor', () => {
    assert.ok(a.ndcg >= 0.5, `NDCG@${K} fell to ${a.ndcg.toFixed(3)}`);
  });

  test('precision is low by construction — reported, not gated', () => {
    // Measured 0.207, and deliberately NOT gated. K=5 over a 36-document corpus
    // where most queries have ONE gold document means precision is bounded near
    // 0.2 by arithmetic, not by retriever quality. Gating a high value here
    // would be asserting the metric is wrong.
    //
    // The honest reading: recall and MRR say the right document is found, and
    // found early; precision says four neighbours come back with it. Whether
    // that is acceptable depends on how much context the caller can afford.
    console.log(`    precision@${K}=${a.precision.toFixed(3)} — reported, not gated (see comment)`);
  });

  test('the top hit is right for the large majority of queries', () => {
    const missRate = a.top1Misses / a.queryCount;
    assert.ok(missRate <= 0.15, `${a.top1Misses} of ${a.queryCount} queries missed at rank 1`);
  });
});

// ---------------------------------------------------------------------------
// Abstention: the system must decline when the corpus cannot answer.
// ---------------------------------------------------------------------------

describe('abstention is a decision, not an accident', () => {
  test('a weak match abstains and says why', () => {
    const r = shouldAbstain(0.12, 0.3);
    assert.equal(r.abstain, true);
    assert.equal(r.reason, 'below_confidence_threshold');
  });

  test('a strong match answers', () => {
    assert.equal(shouldAbstain(0.62, 0.3).abstain, false);
  });

  test('a missing score abstains rather than defaulting to answering', () => {
    // The fail-open case: no score means no evidence, and treating that as
    // "probably fine" is how a helpdesk system invents a runbook.
    for (const bad of [undefined, null, NaN, 'not-a-number']) {
      const r = shouldAbstain(bad, 0.3);
      assert.equal(r.abstain, true, `score ${String(bad)} did not abstain`);
      assert.equal(r.reason, 'no_retrieval_score');
    }
  });

  test('an abstention is never silent — it always carries a reason', () => {
    // A bare refusal is indistinguishable from a crash to the user.
    for (const score of [0, 0.1, NaN, undefined]) {
      const r = shouldAbstain(score, 0.3);
      assert.equal(r.abstain, true);
      assert.ok(r.reason && typeof r.reason === 'string', 'abstention had no reason');
    }
  });

  test('the abstention set exists and is non-empty', () => {
    assert.ok(ABSTENTION_QUERIES.length > 0);
    // These four topics — compensation, expansion planning, KPI formulas,
    // holiday calendars — have no document in the corpus. If a future document
    // changes that, the golden fixture must move the query out of this set.
  });
});