'use strict';

/**
 * Agent budgets: bounded agency.
 *
 * `maxSteps` alone does not bound an agent. These tests pin the limits that
 * actually matter — total tool calls, wall clock, spend, and the loop guard —
 * and, critically, that a STOPPED agent says so instead of answering anyway.
 * A budget that stops the loop but still lets the agent produce a conclusion is
 * not a budget.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createAgentBudget, stableArgs, BUDGET_CODES, DEFAULT_BUDGET } = require('../src/agent/budget');

describe('budget accounting', () => {
  test('a fresh budget starts with headroom', () => {
    const budget = createAgentBudget({ maxSteps: 3 });
    assert.equal(budget.canContinue(), true);
    assert.equal(budget.breachReason(), null);
    const usage = budget.usage();
    assert.equal(usage.steps, 0);
    assert.equal(usage.toolCalls, 0);
  });

  test('steps are counted and stop at the ceiling', () => {
    const budget = createAgentBudget({ maxSteps: 2 });
    // The breach is reported on the step that REACHES the ceiling, not one past
    // it: the orchestrator checks before doing work, so a run is cut off before
    // it starts step 3 rather than part-way through.
    assert.equal(budget.consumeStep(), null, 'step 1 must have headroom');
    assert.ok(budget.consumeStep(), 'reaching the ceiling must report a breach');
    assert.equal(budget.usage().steps, 2);
    assert.equal(budget.canContinue(), false);
    // Every subsequent check keeps reporting the same breach rather than
    // resetting, so a caller cannot accidentally get headroom back.
    assert.equal(budget.breachReason().code, BUDGET_CODES.STEPS);
  });

  test('maxToolCalls is a SEPARATE axis from steps', () => {
    // The step ceiling is set high so only the tool limit can fire, which is the
    // point: an agent making many tool calls per step must hit the TOOL ceiling
    // rather than the step ceiling. Same accounting as steps — the breach is
    // reported on the call that reaches the limit.
    const budget = createAgentBudget({ maxSteps: 100, maxToolCalls: 2 });
    assert.equal(budget.consumeStep(), null);
    assert.equal(budget.consumeToolCall('search_tickets', { q: 'a' }), null);
    assert.equal(budget.consumeStep(), null);

    const breach = budget.consumeToolCall('search_assets', { who: 'b' });
    assert.equal(breach.code, BUDGET_CODES.TOOL_CALLS, 'the tool ceiling did not fire');
    assert.equal(breach.detail, '2/2');

    // The step budget is untouched by the tool breach.
    assert.equal(budget.usage().steps, 2);
    assert.equal(budget.usage().toolCalls, 2);
  });

  test('the wall clock stops a run that is slow rather than long', () => {
    let t = 0;
    const budget = createAgentBudget({ maxSteps: 1000, wallClockMs: 1000, now: () => t });
    assert.equal(budget.consumeStep(), null);
    t = 999;
    assert.equal(budget.breachReason(), null, 'the clock stopped the run early');
    t = 1001;
    const breach = budget.breachReason();
    assert.equal(breach.code, BUDGET_CODES.WALL_CLOCK);
  });

  test('token and cost ceilings stop a spending run', () => {
    const budget = createAgentBudget({ maxSteps: 1000, maxTokens: 1000, maxCostUsd: 100 });
    assert.equal(budget.consumeTokens(900), null);
    const breach = budget.consumeTokens(200);
    assert.equal(breach.code, BUDGET_CODES.TOKENS);

    // Cost is a separate ceiling. At $0.003 per 1K tokens, a $0.001 budget is
    // exhausted at roughly 334 tokens - a small number here precisely so the
    // cost limit fires LONG before any token limit could.
    const priced = createAgentBudget({ maxSteps: 1000, maxTokens: 10_000_000, maxCostUsd: 0.001 });
    priced.consumeTokens(1);
    assert.equal(priced.breachReason(), null, 'one token should not exhaust a $0.001 budget');
    const costBreach = priced.consumeTokens(1000);
    assert.ok(costBreach, 'the cost ceiling was not enforced');
    assert.equal(costBreach.code, BUDGET_CODES.COST);
    assert.ok(priced.usage().costUsd >= 0.001);
  });

  test('usage reports a real cost figure', () => {
    const budget = createAgentBudget({ maxSteps: 10 });
    budget.consumeTokens(1000);
    assert.ok(budget.usage().costUsd > 0);
  });

  test('describe() names the limit that stopped the run', () => {
    const budget = createAgentBudget({ maxSteps: 1 });
    budget.consumeStep();
    const described = budget.describe();
    assert.equal(described.stoppedBy, BUDGET_CODES.STEPS);
  });

  test('limits are reported so a caller can see the contract it ran under', () => {
    const budget = createAgentBudget({ maxSteps: 3 });
    assert.equal(budget.usage().limits.maxSteps, 3);
    assert.equal(budget.usage().limits.maxToolCalls, DEFAULT_BUDGET.maxToolCalls);
  });
});

describe('the budget stops a RUNNING agent, not just a counter', () => {
  /**
   * These build a real orchestrator with a scripted LLM, so they exercise the
   * actual loop rather than the budget object in isolation. The property that
   * matters: a stopped agent says it was stopped, and does not present a
   * conclusion it never reached.
   */

  async function runWithBudget(options) {
    const { createOrchestrator } = require('../src/agent/orchestrator');
    const { createToolRegistry } = require('../src/agent/tools');
    const { createMemory } = require('../src/agent/memory');
    const { createApprovalGate } = require('../src/agent/guardrails');
    const { createInputGuardrail, createOutputGuardrail } = require('../src/agent/guardrails');
    const { createStore } = require('../src/store');

    const dataDir = require('node:fs').mkdtempSync(
      require('node:path').join(require('node:os').tmpdir(), 'helpdesk-budget-'),
    );
    const store = await createStore({ dataDir, seed: false });
    const calls = { llm: 0, tools: 0 };

    const registry = createToolRegistry({ store });
    const realInvoke = registry.invoke.bind(registry);
    registry.invoke = async (...args) => {
      calls.tools += 1;
      return realInvoke(...args);
    };

    const llm = async () => {
      calls.llm += 1;
      // Always asks for the SAME tool with the SAME arguments: a loop that a
      // step counter alone would let run to its ceiling.
      return JSON.stringify({ thought: 'tra cứu', nextTool: 'search_tickets', args: { q: 'loop' }, answer: null });
    };

    const orch = createOrchestrator({
      store,
      tools: registry,
      memory: createMemory({}),
      gate: createApprovalGate(),
      inputGuard: createInputGuardrail(),
      outputGuard: createOutputGuardrail(),
      llm,
      ...options,
    });

    const result = await orch.run({ question: 'ticket nào đang mở?', sessionId: 's', user: 'u', tenant: 't' });
    return { result, calls, store };
  }

  test('a looping agent is stopped by the loop guard, not by the step ceiling', async () => {
    const { result, calls } = await runWithBudget({
      maxSteps: 100, maxToolCalls: 100, agentLoopThreshold: 2,
    });

    assert.equal(result.stoppedBy, BUDGET_CODES.LOOP, 'the loop was not detected');
    assert.ok(calls.tools <= 3, `the loop guard let ${calls.tools} tool calls through`);
    assert.ok(
      result.trace.some((t) => t.phase === 'budget' && t.error === BUDGET_CODES.LOOP),
      'the trace records no budget stop',
    );
  });

  test('a stopped agent does NOT present a conclusion it never reached', async () => {
    const { result } = await runWithBudget({
      maxSteps: 100, maxToolCalls: 100, agentLoopThreshold: 2,
    });

    // The loop never reached a plan with an answer, so the result must say it
    // was stopped rather than synthesising a diagnosis.
    assert.match(result.answer, /giới hạn an toàn|BUDGET/);
    assert.ok(result.budget, 'the result carries no budget accounting');
    assert.equal(result.budget.stoppedBy, BUDGET_CODES.LOOP);
    assert.ok(result.budget.toolCalls <= 3);
  });

  test('maxToolCalls stops an agent that varies its calls', async () => {
    // Different arguments every time: the loop guard cannot catch this, so the
    // tool ceiling is the only thing standing between it and an unbounded run.
    const { createOrchestrator } = require('../src/agent/orchestrator');
    const { createToolRegistry } = require('../src/agent/tools');
    const { createMemory } = require('../src/agent/memory');
    const { createApprovalGate, createInputGuardrail, createOutputGuardrail } = require('../src/agent/guardrails');
    const { createStore } = require('../src/store');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-budget-tools-'));
    const store = await createStore({ dataDir, seed: false });
    const registry = createToolRegistry({ store });
    let llmCalls = 0;

    const orch = createOrchestrator({
      store,
      tools: registry,
      memory: createMemory({}),
      gate: createApprovalGate(),
      inputGuard: createInputGuardrail(),
      outputGuard: createOutputGuardrail(),
      maxSteps: 100,
      maxToolCalls: 3,
      agentLoopThreshold: 100,
      llm: async () => {
        llmCalls += 1;
        return JSON.stringify({
          thought: 'tra cứu', nextTool: 'search_tickets', args: { q: `unique ${llmCalls}` }, answer: null,
        });
      },
    });

    const result = await orch.run({ question: 'ticket nào đang mở?', sessionId: 's', user: 'u', tenant: 't' });
    assert.equal(result.stoppedBy, BUDGET_CODES.TOOL_CALLS);
    assert.ok(llmCalls <= 4, `the agent planned ${llmCalls} times despite a 3-call budget`);
    assert.ok(result.budget.toolCalls <= 3);
  });
});

describe('loop guard (unit)', () => {
  test('the same tool with the same args is stopped as a loop', () => {
    const budget = createAgentBudget({ maxSteps: 100, maxToolCalls: 100, loopThreshold: 2 });
    assert.equal(budget.consumeToolCall('search_tickets', { q: 'vpn' }), null);
    assert.equal(budget.consumeToolCall('search_tickets', { q: 'vpn' }), null);
    const breach = budget.consumeToolCall('search_tickets', { q: 'vpn' });
    assert.equal(breach.code, BUDGET_CODES.LOOP);
  });

  test('genuinely different calls are NOT treated as a loop', () => {
    const budget = createAgentBudget({ maxSteps: 100, maxToolCalls: 100, loopThreshold: 2 });
    for (let i = 0; i < 5; i += 1) {
      assert.equal(budget.consumeToolCall('search_tickets', { q: `query ${i}` }), null);
    }
  });

  test('argument order does not disguise a repeated call', () => {
    const budget = createAgentBudget({ maxSteps: 100, maxToolCalls: 100, loopThreshold: 2 });
    budget.consumeToolCall('search_tickets', { a: 1, b: 2 });
    budget.consumeToolCall('search_tickets', { b: 2, a: 1 });
    const breach = budget.consumeToolCall('search_tickets', { a: 1, b: 2 });
    assert.equal(breach.code, BUDGET_CODES.LOOP, 'key reordering evaded the loop guard');
  });

  test('the guard fingerprints nested structures too', () => {
    const budget = createAgentBudget({ maxSteps: 100, maxToolCalls: 100, loopThreshold: 2 });
    budget.consumeToolCall('t', { list: [1, 2, { z: 1, y: 2 }] });
    budget.consumeToolCall('t', { list: [1, 2, { y: 2, z: 1 }] });
    assert.equal(budget.consumeToolCall('t', { list: [1, 2, { z: 1, y: 2 }] }).code, BUDGET_CODES.LOOP);
  });

  test('stableArgs handles the awkward inputs without throwing', () => {
    for (const input of [null, undefined, 0, '', false, [], {}, [1, 'a', null]]) {
      assert.doesNotThrow(() => stableArgs(input), `stableArgs threw on ${JSON.stringify(input)}`);
    }
  });
});