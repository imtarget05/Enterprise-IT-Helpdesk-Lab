'use strict';

/**
 * RAG retrieval quality metrics.
 *
 * Wave A proved retrieval is ISOLATED and CITABLE. It said nothing about whether
 * it is any GOOD. This file supplies the measurement.
 *
 * The metrics, and what each one actually catches:
 *
 *   Recall@K     — did the answer's supporting chunks make the cut at all?
 *                  Catches a retriever that is safe but useless. High recall
 *                  with terrible precision is a security-constrained system
 *                  that cannot do its job.
 *   Precision@K  — how much of what we returned was relevant? Catches padding:
 *                  noise wastes tokens and hands the model more untrusted text
 *                  to be influenced by.
 *   MRR          — how quickly did the FIRST useful chunk appear? A runbook cited
 *                  at position 9 is far less usable than at position 1, and
 *                  average recall treats those as equal.
 *   NDCG@K       — rank-sensitive precision: relevant at rank 1 counts more than
 *                  the same chunk at rank 8.
 *
 * Groundedness is deliberately NOT computed here. Whether an answer is faithful
 * to its citations is a property of a GENERATED ANSWER, and this repository's
 * default path is an offline rule-based engine with no model in the loop.
 * Measuring "faithfulness" against a template produces a number that means
 * nothing. It belongs with the LLM path and a human-labelled answer set.
 *
 * Pure functions over ranked lists. No I/O, no model, no thresholds baked in —
 * a test decides what counts as acceptable.
 */

/** Number of items in the ranking to score. */
const DEFAULT_K = 5;

/**
 * Recall@K: of the relevant items, what fraction appeared in the top K?
 *
 * Returns 0 when nothing is relevant — there is nothing to recall. Scoring that
 * as 1 would reward a retriever that returns nothing at all, which is the
 * opposite of useful.
 */
function recallAtK(ranked, relevant, k = DEFAULT_K) {
  if (!relevant.length) return 0;
  const top = new Set(ranked.slice(0, k));
  let hits = 0;
  for (const id of relevant) if (top.has(id)) hits += 1;
  return hits / relevant.length;
}

/** Precision@K: of the top K returned, what fraction was relevant? */
function precisionAtK(ranked, relevant, k = DEFAULT_K) {
  if (!ranked.length) return 0;
  const top = ranked.slice(0, k);
  const rel = new Set(relevant);
  let hits = 0;
  for (const id of top) if (rel.has(id)) hits += 1;
  return hits / top.length;
}

/** 1/rank of the first relevant item, or 0 when none appears. */
function reciprocalRank(ranked, relevant) {
  const rel = new Set(relevant);
  const index = ranked.findIndex((id) => rel.has(id));
  return index >= 0 ? 1 / (index + 1) : 0;
}

/**
 * Mean reciprocal rank, over queries that HAVE a relevant item.
 *
 * Queries with no gold item are EXCLUDED rather than scored 0: they measure
 * whether the query belongs in the dataset, not how the retriever performs.
 */
function meanReciprocalRank(rankedByQuery, relevantByQuery) {
  let total = 0;
  let counted = 0;
  for (const [query, relevant] of relevantByQuery) {
    if (!relevant.length) continue;
    const ranked = rankedByQuery.get(query) || [];
    const rel = new Set(relevant);
    const index = ranked.findIndex((id) => rel.has(id));
    if (index >= 0) {
      total += 1 / (index + 1);
      counted += 1;
    }
  }
  return counted ? total / counted : 0;
}

/** Discounted cumulative gain at K: relevant items weighted by 1/log2(rank+1). */
function dcgAtK(ranked, relevant, k = DEFAULT_K) {
  const rel = new Set(relevant);
  let gain = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    if (rel.has(ranked[i])) gain += 1 / Math.log2(i + 2);
  }
  return gain;
}

/**
 * NDCG@K — DCG normalised by the best achievable ordering, so 1.0 means "as good
 * as it is possible to be" rather than an arbitrary raw total. That makes the
 * number comparable across queries with different numbers of relevant chunks.
 */
function ndcgAtK(ranked, relevant, k = DEFAULT_K) {
  if (!relevant.length) return 0;
  const idcg = dcgAtK([...relevant].slice(0, k), relevant, k);
  if (!idcg) return 0;
  return dcgAtK(ranked, relevant, k) / idcg;
}

/** Mean of a per-query metric over the dataset. */
function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * Score one query.
 *
 * `ranked` is the retriever's output as ids, best first. `relevant` is the gold
 * set. Graded relevance is NOT modelled: the corpus does not carry it, and
 * inventing a three-level judgement while writing the evaluator would mean
 * grading our own homework.
 */
function scoreQuery(ranked, relevant, k = DEFAULT_K) {
  const rel = relevant || [];
  return {
    recall: recallAtK(ranked, rel, k),
    precision: precisionAtK(ranked, rel, k),
    reciprocalRank: reciprocalRank(ranked, rel),
    ndcg: ndcgAtK(ranked, rel, k),
    returnedCount: ranked.length,
    hitCount: ranked.filter((id) => rel.includes(id)).length,
  };
}

/**
 * Score a whole run: per-query detail plus dataset aggregates.
 *
 * `runQuery(query, k)` is INJECTED rather than imported, so the same evaluator
 * works against the real retriever, a stub, or a recorded transcript — and so a
 * test can prove the metrics themselves are wrong by feeding them a ranking whose
 * correct answer is known by hand.
 */
function evaluate(goldenSet, runQuery, options = {}) {
  const k = options.k || DEFAULT_K;
  const perQuery = [];
  const rankedByQuery = new Map();
  const relevantByQuery = new Map();

  for (const item of goldenSet) {
    const ranked = runQuery(item.query, k);
    rankedByQuery.set(item.query, ranked);
    relevantByQuery.set(item.query, item.relevant || []);
    perQuery.push({
      query: item.query,
      // Carried through so a report can explain itself. Without `relevant` in
      // the row, a reviewer looking at a weak query cannot tell what the
      // retriever SHOULD have returned — the most useful thing to know.
      relevant: item.relevant || [],
      ...scoreQuery(ranked, item.relevant || [], k),
    });
  }

  return {
    k,
    perQuery,
    aggregates: {
      recall: mean(perQuery.map((s) => s.recall)),
      precision: mean(perQuery.map((s) => s.precision)),
      mrr: meanReciprocalRank(rankedByQuery, relevantByQuery),
      ndcg: mean(perQuery.map((s) => s.ndcg)),
      queryCount: perQuery.length,
      // Queries whose top-1 hit was not relevant. The sharpest signal in the
      // set: a model reading these starts from the wrong document.
      top1Misses: perQuery.filter((s) => s.reciprocalRank === 0).length,
    },
  };
}

/**
 * Should the system answer at all?
 *
 * Abstention is a correctness property, not a politeness one. A retriever whose
 * best match is weak has NOT found an answer, and presenting its output as one
 * is how a helpdesk system invents a runbook. The threshold is a CALLER's
 * choice — how confident is confident enough differs per use — but the decision
 * must be made somewhere explicit rather than by a model deciding on its own
 * that it feels ready.
 *
 * Returns a reason so an abstention is explainable to the user rather than a
 * bare refusal.
 */
function shouldAbstain(score, threshold) {
  // `Number(null)` is 0 and `Number('')` is 0 — both would compare as a weak
  // score and abstain for the WRONG reason, reporting "below threshold" when the
  // truth is "there was no score at all". Those are different failures and an
  // operator needs to tell them apart: one means the retriever found nothing
  // weak, the other means it was never asked properly.
  if (score === null || score === undefined || score === '' || typeof score === 'boolean') {
    return { abstain: true, reason: 'no_retrieval_score' };
  }
  const s = Number(score);
  if (!Number.isFinite(s)) {
    return { abstain: true, reason: 'no_retrieval_score' };
  }
  if (s < threshold) {
    return { abstain: true, reason: 'below_confidence_threshold', score: s, threshold };
  }
  return { abstain: false, reason: null, score: s, threshold };
}

module.exports = {
  DEFAULT_K,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  meanReciprocalRank,
  dcgAtK,
  ndcgAtK,
  scoreQuery,
  evaluate,
  shouldAbstain,
  mean,
};