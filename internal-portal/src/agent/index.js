'use strict';

/**
 * Agent runtime — điểm vào duy nhất của tầng agent trong portal.
 *
 * `createAgent({ store, dataDir, ... })` trả về `{ run, approve, describe }`
 * cho route, giữ đúng style factory của `createStore` / `createAi` / `createAuth`:
 * không module-level state, mỗi test tạo được instance riêng với dataDir riêng.
 *
 * LLM nối theo đúng thứ tự ưu tiên của portal:
 *   OpenAI cloud (nếu có key) → LM Studio local → Ollama local → không LLM.
 * Khi không tầng nào trả lời được, orchestrator tự rơi về rule-based, nên
 * endpoint luôn trả 200 với câu trả lời có căn cứ từ playbook — đúng
 * triết lý fail-soft mà cả portal đang theo.
 */

const { createToolRegistry } = require('./tools');
const { createMemory } = require('./memory');
const { createInputGuardrail, createApprovalGate, createOutputGuardrail, MAX_INPUT } = require('./guardrails');
const { createOrchestrator, AGENT_SYSTEM_PROMPT, MAX_STEPS } = require('./orchestrator');
const { createLlmClient } = require('./llm');

/**
 * @param {object} options
 * @param {object} options.store     store từ createStore() (bắt buộc).
 * @param {string} [options.dataDir] nơi lưu long-term memory; mặc định dataDir của store.
 * @param {function} [options.llm]    inject LLM cho test (thay cho createLlmClient).
 * @param {function} [options.fetchImpl] fetch cho RAG + LLM (test dùng fake).
 */
async function createAgent(options = {}) {
  const store = options.store;
  if (!store) throw new Error('createAgent cần options.store.');

  const dataDir = options.dataDir || store.dataDir;
  const tools = createToolRegistry({ store });
  const memory = createMemory({
    dataDir,
    ltmEnabled: options.ltmEnabled !== false,
    sessionTtlMs: options.sessionTtlMs,
  });
  await memory.load();

  const gate = createApprovalGate({ ttlMs: options.approvalTtlMs, now: options.now });
  const inputGuard = createInputGuardrail({ maxLength: options.maxInputLength || MAX_INPUT });
  const outputGuard = createOutputGuardrail();

  // `llm` inject sẵn (test) thì dùng luôn; ngược lại dựng client nhiều tầng.
  // Client nhiều tầng trả {content}|{error}; bọc lại thành hàm trả string|null
  // đúng hợp đồng orchestrator mong đợi (throw → orchestrator fallback).
  const client = options.llm ? null : createLlmClient(options);
  const llm = typeof options.llm === 'function'
    ? options.llm
    : client
      ? async ({ system, user }) => {
        const out = await client.complete({ system, user });
        if (out.error) throw new Error(out.error);
        return out.content;
      }
      : null;

  const orchestrator = createOrchestrator({
    store, tools, memory, gate, inputGuard, outputGuard,
    llm,
    fetchImpl: options.fetchImpl || null,
    maxSteps: options.maxSteps || MAX_STEPS,
  });

  return {
    /** POST /api/ai/agent — chạy vòng lặp agent. */
    run(input) {
      return orchestrator.run(input);
    },

    /** POST /api/ai/agent/approve — thực thi hành động đã được duyệt. */
    approve(input) {
      return orchestrator.approve(input);
    },

    /** Từ chối một hành động đang chờ duyệt. */
    reject(token) {
      return gate.reject(token);
    },

    /** GET /api/ai/agent/status — mô tả năng lực agent cho dashboard/demo. */
    describe() {
      const tiers = client ? client.tiers : [];
      return {
        // `engine` là engine đang dùng; `tiers` là chuỗi dự phòng theo thứ tự
        // ưu tiên. Khi không có LLM nào cấu hình → 'rule-based'.
        engine: llm ? (tiers[0] || 'injected') : 'rule-based',
        tiers,
        maxSteps: orchestrator.maxSteps,
        tools: orchestrator.toolManifest().map((t) => ({ name: t.name, sideEffect: t.sideEffect, autoAllowed: t.autoAllowed })),
        sideEffectPolicy: 'side-effect tools require explicit human approval; agent can only propose',
        memory: { sessions: memory.sessionCount, longTerm: memory.ltmCount, ltmEnabled: options.ltmEnabled !== false },
        pendingApprovals: gate.size,
      };
    },

    // Nội bộ — dùng cho test, không dùng trong route.
    _internals: { store, tools, memory, gate, orchestrator },
  };
}

module.exports = { createAgent, AGENT_SYSTEM_PROMPT, MAX_STEPS };
