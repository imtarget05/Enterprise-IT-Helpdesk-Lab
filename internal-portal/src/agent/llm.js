'use strict';

/**
 * Agent factory — điểm vào duy nhất của tầng agent trong portal.
 *
 * `createAgent({ store, dataDir, ai })` trả về đối tượng có `run()` và
 * `approve()` cho route, kèm `describe()` cho GET status. Giữ đúng style
 * factory của `createStore` / `createAi` / `createAuth`: không phụ thuộc
 * module-level state, mỗi test tạo được instance riêng với dataDir riêng.
 *
 * LLM được nối theo đúng thứ tự ưu tiên của portal:
 *   OpenAI cloud (nếu có key) → LM Studio local → Ollama local → không LLM.
 * Khi không có tầng nào trả lời được, orchestrator tự rơi về rule-based:
 * endpoint luôn trả 200 với câu trả lời có căn cứ từ playbook.
 */

const { createToolRegistry } = require('./tools');
const { createMemory } = require('./memory');
const { createInputGuardrail, createApprovalGate, createOutputGuardrail } = require('./guardrails');
const { createOrchestrator, AGENT_SYSTEM_PROMPT, MAX_STEPS } = require('./orchestrator');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_LMSTUDIO_URL = 'http://192.168.1.8:1234/v1';
const DEFAULT_OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 15000;
const STATUS_TIMEOUT_MS = 1500;

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

/**
 * Gọi một endpoint chat OpenAI-compatible và trả về phần nội dung text.
 * Dùng chung cho cả OpenAI cloud và LM Studio vì hai bên cùng schema
 * `/v1/chat/completions`; chỉ khác URL, model và header.
 */
async function chatCompletion({ url, model, system, user, timeoutMs, fetchImpl, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1200,
        stream: false,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('Phản hồi rỗng');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dựng client LLM nhiều tầng. Trả về null khi không tầng nào cấu hình —
 * orchestrator khi đó chạy thuần rule-based.
 */
function createLlmClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const ollamaUrl = str(options.ollamaUrl || process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const lmstudioUrl = str(options.lmstudioUrl || process.env.LMSTUDIO_URL || DEFAULT_LMSTUDIO_URL).replace(/\/+$/, '');
  const ollamaModel = str(options.model || process.env.OLLAMA_MODEL || 'qwen2.5:3b');
  const lmstudioModel = str(options.lmstudioModel || process.env.LMSTUDIO_MODEL || 'qwen2.5-vl-3b-instruct');
  const openaiModel = str(options.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini');
  // Key chỉ đọc từ env/options; không log, không đưa vào bất kỳ response nào.
  const openaiKey = str(options.openaiKey || process.env.OPENAI_API_KEY);
  const preferLmStudio = ['lmstudio', 'local_openai', 'lms'].includes(str(options.llmProvider || process.env.LLM_PROVIDER || 'ollama').toLowerCase());
  const timeoutMs = Number(options.timeoutMs || process.env.OLLAMA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  const tiers = [];
  if (openaiKey) {
    tiers.push({
      name: 'openai',
      call: ({ system, user }) => chatCompletion({
        url: DEFAULT_OPENAI_CHAT_URL, model: openaiModel, system, user, timeoutMs, fetchImpl,
        headers: { Authorization: `Bearer ${openaiKey}` },
      }),
    });
  }
  if (preferLmStudio) {
    tiers.push({
      name: 'lmstudio',
      call: ({ system, user }) => chatCompletion({
        url: `${lmstudioUrl}/chat/completions`, model: lmstudioModel, system, user, timeoutMs, fetchImpl,
        headers: { 'X-Project': 'IT-Helpdesk-Lab' },
      }),
    });
  } else {
    tiers.push({
      name: 'ollama',
      call: async ({ system, user }) => {
        const content = await chatCompletion({
          url: `${ollamaUrl}/v1/chat/completions`, model: ollamaModel, system, user, timeoutMs, fetchImpl,
        });
        return content;
      },
    });
  }

  if (!tiers.length) return null;

  return {
    tiers: tiers.map((t) => t.name),
    /**
     * Thử từng tầng theo thứ tự; tầng nào parse được JSON thì dừng.
     * Trả về { content, engine } hoặc { error, engine } nếu tất cả thất bại —
     * orchestrator tự rơi về rule-based.
     */
    async complete({ system, user }) {
      const errors = [];
      for (const tier of tiers) {
        try {
          const content = await tier.call({ system, user });
          return { content, engine: tier.name };
        } catch (err) {
          // Không log nội dung response: có thể chứa dữ liệu người dùng.
          errors.push(`${tier.name}: ${err.message}`);
        }
      }
      return { error: errors.join('; ').slice(0, 300), engine: null };
    },
  };
}

module.exports = { createLlmClient, chatCompletion, AGENT_SYSTEM_PROMPT, MAX_STEPS, STATUS_TIMEOUT_MS };
