'use strict';

/**
 * Agent runtime budgets — bounded agency.
 *
 * `maxSteps` alone does not bound an agent. A loop that alternates between two
 * read tools stays under any step ceiling while still burning latency, tokens
 * and cost, and a single slow tool call can hold a request open indefinitely.
 * This module supplies the limits that make the loop itself accountable:
 *
 *   · `maxToolCalls`  — total tool invocations, independent of steps;
 *   · `wallClockMs`   — real elapsed time, checked before each step;
 *   · `maxTokens` / `maxCostUsd` — spend ceilings derived from usage;
 *   · `loopGuard`     — detects the same (tool, args) repeating, which a step
 *                       count cannot distinguish from genuine progress.
 *
 * Every limit is FAIL-CLOSED and every breach is recorded with a stable reason
 * code, so a caller can tell "the agent finished" from "the agent was stopped"
 * — a distinction that matters, because a stopped agent that answers anyway is
 * an agent that invented its way past the limit.
 */

const BUDGET_CODES = Object.freeze({
  STEPS: 'BUDGET_STEPS_EXHAUSTED',
  TOOL_CALLS: 'BUDGET_TOOL_CALLS_EXHAUSTED',
  WALL_CLOCK: 'BUDGET_WALL_CLOCK_EXCEEDED',
  TOKENS: 'BUDGET_TOKENS_EXHAUSTED',
  COST: 'BUDGET_COST_EXCEEDED',
  LOOP: 'BUDGET_LOOP_DETECTED',
});

const DEFAULT_BUDGET = Object.freeze({
  maxSteps: 8,
  maxToolCalls: 16,
  wallClockMs: 30_000,
  maxTokens: 32_000,
  maxCostUsd: 0.50,
  // How many times the identical (tool, args) may repeat before it is treated
  // as a loop rather than progress. 2 means "seen twice already".
  loopThreshold: 2,
});

/**
 * Token/cost accounting. Kept deliberately simple and deterministic: a real
 * deployment substitutes its provider's pricing, and the guard must not depend
 * on a network call to decide whether to stop.
 */
const USD_PER_1K_TOKENS = 0.003;

function createAgentBudget(options = {}) {
  const limits = { ...DEFAULT_BUDGET, ...options };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const startedAt = now();

  let steps = 0;
  let toolCalls = 0;
  let tokens = 0;
  const seenCalls = new Map();

  const usage = () => ({
    steps,
    toolCalls,
    tokens,
    costUsd: Number(((tokens / 1000) * USD_PER_1K_TOKENS).toFixed(6)),
    elapsedMs: Math.max(0, now() - startedAt),
    limits: { ...limits },
  });

  /** Why the budget refuses more work, or null when there is headroom. */
  function breachReason() {
    if (steps >= limits.maxSteps) return { code: BUDGET_CODES.STEPS, detail: `${steps}/${limits.maxSteps}` };
    if (toolCalls >= limits.maxToolCalls) return { code: BUDGET_CODES.TOOL_CALLS, detail: `${toolCalls}/${limits.maxToolCalls}` };
    const elapsed = Math.max(0, now() - startedAt);
    if (elapsed >= limits.wallClockMs) return { code: BUDGET_CODES.WALL_CLOCK, detail: `${elapsed}/${limits.wallClockMs}ms` };
    if (tokens >= limits.maxTokens) return { code: BUDGET_CODES.TOKENS, detail: `${tokens}/${limits.maxTokens}` };
    if ((tokens / 1000) * USD_PER_1K_TOKENS >= limits.maxCostUsd) {
      return { code: BUDGET_CODES.COST, detail: `${((tokens / 1000) * USD_PER_1K_TOKENS).toFixed(4)}/${limits.maxCostUsd}usd` };
    }
    return null;
  }

  const canContinue = () => breachReason() === null;

  /** Consume one step. Returns the breach that now applies, or null. */
  function consumeStep() {
    steps += 1;
    return breachReason();
  }

  /**
   * Consume one tool call and run the loop guard.
   *
   * The guard fingerprints the call rather than the step: a loop that repeats
   * `search_tickets` with identical arguments makes no progress no matter how
   * many steps it consumes, and without this it would run to the step ceiling
   * instead of being stopped early.
   */
  function consumeToolCall(toolName, args) {
    toolCalls += 1;
    const fingerprint = `${toolName}:${stableArgs(args)}`;
    const seen = (seenCalls.get(fingerprint) || 0) + 1;
    seenCalls.set(fingerprint, seen);
    if (seen > limits.loopThreshold) {
      return { code: BUDGET_CODES.LOOP, detail: `${toolName} repeated ${seen}x` };
    }
    return breachReason();
  }

  function consumeTokens(count) {
    tokens += Math.max(0, Number(count) || 0);
    return breachReason();
  }

  return {
    limits,
    usage,
    canContinue,
    breachReason,
    consumeStep,
    consumeToolCall,
    consumeTokens,
    /** A single summary an operator can read without reconstructing the loop. */
    describe: () => ({ ...usage(), stoppedBy: (breachReason() || {}).code || null }),
  };
}

/** Order-independent JSON, so `{a,b}` and `{b,a}` count as the same call. */
function stableArgs(args) {
  if (args === null || args === undefined) return 'null';
  if (typeof args !== 'object') return JSON.stringify(args);
  if (Array.isArray(args)) return `[${args.map(stableArgs).join(',')}]`;
  return `{${Object.keys(args).sort().map((k) => `${JSON.stringify(k)}:${stableArgs(args[k])}`).join(',')}}`;
}

module.exports = { createAgentBudget, stableArgs, BUDGET_CODES, DEFAULT_BUDGET };