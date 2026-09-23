'use strict';

/**
 * AI Assistant — phân tích ticket bằng LLM chạy LOCAL qua Ollama.
 * KHÔNG dùng OpenAI hay bất kỳ cloud API nào: mọi inference chạy trên máy
 * (Ollama server mặc định tại http://127.0.0.1:11434).
 *
 *   GET  /api/ai/status   → Ollama có đang chạy không, model nào, list model
 *   POST /api/ai/analyze  → tóm tắt → bước chẩn đoán → RCA → phòng ngừa
 *
 * Thiết kế fail-soft (giống notify.js): nếu Ollama chưa cài/chưa chạy/hết
 * timeout → FALLBACK sang playbook rule-based offline (keyword → runbook ITIL
 * từ các kịch bản sự cố trong repo) nên endpoint luôn trả 200 được — demo
 * không phụ thuộc mạng, CI không cần cài Ollama.
 *
 * Biến môi trường:
 *   OLLAMA_URL        — http://127.0.0.1:11434 (mặc định)
 *   OLLAMA_MODEL      — qwen2.5:3b (mặc định; tương thích llama3.2:3b, …)
 *   OLLAMA_TIMEOUT_MS — 15000 (timeout mỗi lần gọi model)
 */

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:3b';
const DEFAULT_TIMEOUT_MS = 15000;
const STATUS_TIMEOUT_MS = 1500; // status phải trả lời nhanh dù Ollama không chạy

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

const { PLAYBOOKS, DEFAULT_PLAYBOOK } = require('./ai-playbooks');

function pickPlaybook(ticket) {
  const haystack = [ticket.title, ticket.category, ticket.description].map(str).join(' ');
  return PLAYBOOKS.find((p) => p.match && p.match.test(haystack)) || DEFAULT_PLAYBOOK;
}

/** Phân tích offline — luôn thành công, không cần mạng. */
function ruleBasedAnalyze(ticket) {
  const pb = pickPlaybook(ticket);
  return {
    engine: 'rule-based',
    model: null,
    playbook: pb.name,
    summary: pb.summary,
    diagnosis: [...pb.diagnosis],
    rca: pb.rca,
    prevention: [...pb.prevention],
    generatedAt: stamp(),
  };
}

// ---------------------------------------------------------------------------
// Gọi Ollama — POST /api/chat (stream:false, format:json) rồi parse JSON
// tolerant (model hay bọc thêm ```json / text quanh JSON).
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = [
  'Bạn là kỹ thuật viên Helpdesk level 2 của phòng IT (chuẩn ITIL).',
  'Phân tích ticket sự cố sau và TRẢ VỀ DUY NHẤT một object JSON hợp lệ, không giải thích thêm, không markdown, gồm các khóa:',
  '"summary" (string, 1-2 câu tiếng Việt tóm tắt sự cố),',
  '"diagnosis" (mảng 4-5 string tiếng Việt, các bước chẩn đoán CỤ THỂ có lệnh/kiểm tra cụ thể, thứ tự từ tổng quát đến chi tiết),',
  '"rca" (string tiếng Việt, nguyên nhân gốc có thể nhất),',
  '"prevention" (mảng 3-4 string tiếng Việt, biện pháp phòng ngừa để sự cố không lặp lại).',
].join(' ');

function parseAnalysisJson(content) {
  let obj = null;
  try {
    obj = JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(content.slice(start, end + 1));
      } catch {
        /* rơi xuống throw bên dưới */
      }
    }
  }
  if (!obj || typeof obj !== 'object') throw new Error('Ollama không trả về JSON hợp lệ');

  const asArray = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : []);
  const analysis = {
    summary: str(obj.summary),
    diagnosis: asArray(obj.diagnosis),
    rca: str(obj.rca),
    prevention: asArray(obj.prevention),
  };
  if (!analysis.summary) throw new Error('JSON từ Ollama thiếu trường summary');
  return analysis;
}

function createAi(options = {}) {
  const ollamaUrl = str(options.ollamaUrl || process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const model = str(options.model || process.env.OLLAMA_MODEL || DEFAULT_MODEL);
  const timeoutMs = Number(options.timeoutMs || process.env.OLLAMA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  /** Gọi Ollama; throw nếu không reachable / sai định dạng → caller fallback. */
  async function ollamaChat(ticket, timeout = timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchImpl(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          options: { temperature: 0.2 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                `Ticket #${ticket.id ?? 'n/a'}: ${str(ticket.title)}`,
                `Phòng ban: ${str(ticket.dept) || 'N/A'} — Người báo: ${str(ticket.requester) || 'N/A'}`,
                `Priority: ${str(ticket.priority) || 'Medium'} — Category: ${str(ticket.category) || 'General'}`,
                ticket.description ? `Mô tả chi tiết: ${str(ticket.description)}` : '',
              ].filter(Boolean).join('\n'),
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = await res.json();
      const content = data && data.message && data.message.content;
      if (!content) throw new Error('Ollama trả về message rỗng');
      return parseAnalysisJson(content);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ollamaUrl,
    model,
    timeoutMs,

    /** GET /api/ai/status — probe nhanh Ollama (timeout 1.5s nếu không chạy). */
    async status() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
      let reachable = false;
      let models = [];
      let error = null;
      try {
        const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        models = Array.isArray(data.models) ? data.models.map((m) => str(m.name)).filter(Boolean) : [];
        reachable = true;
      } catch (err) {
        error = err.name === 'AbortError' ? `timeout>${STATUS_TIMEOUT_MS}ms` : err.message;
      } finally {
        clearTimeout(timer);
      }
      return {
        engine: reachable ? 'ollama' : 'rule-based',
        reachable,
        url: ollamaUrl,
        model,
        models,
        error,
        checkedAt: stamp(),
      };
    },

    /**
     * POST /api/ai/analyze — thử Ollama trước, mọi lỗi (chưa chạy/timeout/
     * JSON hỏng) đều fallback playbook rule-based → luôn trả kết quả.
     */
    async analyze(ticket) {
      try {
        const analysis = await ollamaChat(ticket);
        return { engine: 'ollama', model, playbook: null, ...analysis, generatedAt: stamp() };
      } catch (err) {
        return { ...ruleBasedAnalyze(ticket), fallbackReason: err.message };
      }
    },
  };
}

module.exports = { createAi, ruleBasedAnalyze, parseAnalysisJson };
