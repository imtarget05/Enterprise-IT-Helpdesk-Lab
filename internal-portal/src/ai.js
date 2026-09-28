'use strict';

/**
 * AI Assistant — 3 tầng engine (fail-soft, luôn HTTP 200 khi input hợp lệ):
 *   1. OpenAI cloud (OPENAI_API_KEY) — gpt-4o-mini mặc định, response JSON.
 *   1b. LM Studio local LAN (LMSTUDIO_URL, OpenAI-compatible /v1/chat/completions)
 *       — dùng khi LLM_PROVIDER=lmstudio; local nên không tốn phí.
 *   2. LLM LOCAL qua Ollama (Qwen nhỏ) — không tốn phí, chạy offline.
 *   3. Playbook rule-based offline (keyword → runbook ITIL trong repo).
 *
 * RAG (src/rag.js) ghép top-3 đoạn runbook công ty vào prompt ở cả 3 tầng LLM.
 * KEY BẢO MẬT: OPENAI_API_KEY chỉ đọc từ biến môi trường, KHÔNG bao giờ
 * log/commit vào git (.env đã có trong .gitignore).
 *
 *   GET  /api/ai/status   → engine khả dụng, model nào, RAG mode
 *   POST /api/ai/analyze  → tóm tắt → bước chẩn đoán → RCA → phòng ngừa
 *
 * Thiết kế fail-soft (giống notify.js): nếu Ollama chưa cài/chưa chạy/hết
 * timeout → FALLBACK sang playbook rule-based offline (keyword → runbook ITIL
 * từ các kịch bản sự cố trong repo) nên endpoint luôn trả 200 được — demo
 * không phụ thuộc mạng, CI không cần cài Ollama.
 *
 * Biến môi trường:
 *   OPENAI_API_KEY    — để trống = tắt tầng cloud (khuyên dùng file .env, không commit)
 *   OPENAI_MODEL      — gpt-4o-mini (mặc định, rẻ + đủ cho ticket IT)
 *   OLLAMA_URL        — http://127.0.0.1:11434 (mặc định)
 *   OLLAMA_MODEL      — qwen2.5:3b (mặc định; tương thích llama3.2:3b, …)
 *   OLLAMA_TIMEOUT_MS — 15000 (timeout mỗi lần gọi model)
 *   LLM_PROVIDER      — "ollama" (mặc định) hoặc "lmstudio"
 *   LMSTUDIO_URL      — http://192.168.1.8:1234/v1 (mặc định khi LLM_PROVIDER=lmstudio)
 *   LMSTUDIO_MODEL    — qwen2.5-vl-3b-instruct
 */

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:3b';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_LMSTUDIO_URL = 'http://192.168.1.8:1234/v1';
const DEFAULT_LMSTUDIO_MODEL = 'qwen2.5-vl-3b-instruct';
const STATUS_TIMEOUT_MS = 1500; // status phải trả lời nhanh dù Ollama không chạy

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

const { PLAYBOOKS, DEFAULT_PLAYBOOK } = require('./ai-playbooks');
const { retrieve, formatContext, ragStatus } = require('./rag');

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
  const llmProvider = str(options.llmProvider || process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  const useLmStudio = ['lmstudio', 'local_openai', 'lms'].includes(llmProvider);
  const ollamaUrl = str(options.ollamaUrl || process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const lmstudioUrl = str(options.lmstudioUrl || process.env.LMSTUDIO_URL || DEFAULT_LMSTUDIO_URL).replace(/\/+$/, '');
  const model = str(
    options.model ||
    (useLmStudio ? process.env.LMSTUDIO_MODEL || DEFAULT_LMSTUDIO_MODEL : process.env.OLLAMA_MODEL || DEFAULT_MODEL),
  );
  const timeoutMs = Number(options.timeoutMs || process.env.OLLAMA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  // Key chỉ đọc từ env/options, không log, không trả về client.
  const openaiKey = str(options.openaiKey || process.env.OPENAI_API_KEY);
  const openaiModel = str(options.openaiModel || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL);

  /** RAG: top-3 đoạn runbook công ty ghép vào prompt để LLM
   *  trả lời đúng quy trình nội bộ thay vì bịa kiến thức chung. */
  async function getRag(ticket) {
    try {
      const q = [ticket.title, ticket.category, ticket.description].map(str).filter(Boolean).join(' ');
      const ragHits = await retrieve(q, 3, { fetchImpl });
      return { ragHits, ragCtx: formatContext(ragHits) };
    } catch {
      return { ragHits: [], ragCtx: '' };
    }
  }

  function buildUserContent(ticket, ragCtx) {
    return [
      `Ticket #${ticket.id ?? 'n/a'}: ${str(ticket.title)}`,
      `Phòng ban: ${str(ticket.dept) || 'N/A'} — Người báo: ${str(ticket.requester) || 'N/A'}`,
      `Priority: ${str(ticket.priority) || 'Medium'} — Category: ${str(ticket.category) || 'General'}`,
      ticket.description ? `Mô tả chi tiết: ${str(ticket.description)}` : '',
      ragCtx ? `\n${ragCtx}` : '',
    ].filter(Boolean).join('\n');
  }

  /** Gọi OpenAI cloud (response_format JSON); throw → caller thử tầng tiếp theo. */
  async function openaiChat(userContent, timeout = timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchImpl(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: openaiModel,
          temperature: 0.2,
          max_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${SYSTEM_PROMPT} Trả lời bằng tiếng Việt.` },
            { role: 'user', content: userContent },
          ],
        }),
        signal: controller.signal,
      });
      if (res.status === 401) throw new Error('OpenAI key không hợp lệ (401) — kiểm tra OPENAI_API_KEY');
      if (res.status === 429) throw new Error('OpenAI hết quota/rate-limit (429)');
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
      const data = await res.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message &&
        data.choices[0].message.content;
      if (!content) throw new Error('OpenAI trả về message rỗng');
      return parseAnalysisJson(content);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Gọi Ollama; throw nếu không reachable / sai định dạng → caller fallback. */
  async function ollamaChat(ticket, ragCtx, ragHits, timeout = timeoutMs) {
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
            { role: 'user', content: buildUserContent(ticket, ragCtx) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = await res.json();
      const content = data && data.message && data.message.content;
      if (!content) throw new Error('Ollama trả về message rỗng');
      return { analysis: parseAnalysisJson(content), ragHits };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Gọi LM Studio / bất kỳ endpoint OpenAI-compatible local nào (LAN).
   *  Cùng shape kết quả với ollamaChat; throw → caller fallback tầng tiếp theo. */
  async function lmstudioChat(ticket, ragCtx, ragHits, timeout = timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchImpl(`${lmstudioUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Project': 'IT-Helpdesk-Lab' },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 800,
          stream: false,
          messages: [
            { role: 'system', content: `${SYSTEM_PROMPT} Trả lời bằng JSON hợp lệ tiếng Việt.` },
            { role: 'user', content: buildUserContent(ticket, ragCtx) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}`);
      const data = await res.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message &&
        data.choices[0].message.content;
      if (!content) throw new Error('LM Studio trả về message rỗng');
      return { analysis: parseAnalysisJson(content), ragHits };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ollamaUrl,
    lmstudioUrl,
    llmProvider,
    model,
    timeoutMs,

    /** GET /api/ai/status — probe nhanh LLM local (timeout 1.5s nếu không chạy). */
    async status() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
      let reachable = false;
      let models = [];
      let error = null;
      const probeUrl = useLmStudio ? `${lmstudioUrl}/models` : `${ollamaUrl}/api/tags`;
      try {
        const res = await fetchImpl(probeUrl, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        models = useLmStudio
          ? (Array.isArray(data.data) ? data.data.map((m) => str(m.id)).filter(Boolean) : [])
          : (Array.isArray(data.models) ? data.models.map((m) => str(m.name)).filter(Boolean) : []);
        reachable = true;
      } catch (err) {
        error = err.name === 'AbortError' ? `timeout>${STATUS_TIMEOUT_MS}ms` : err.message;
      } finally {
        clearTimeout(timer);
      }
      const localEngine = useLmStudio ? 'lmstudio' : 'ollama';
      return {
        engine: openaiKey ? (reachable ? localEngine : 'openai') : (reachable ? localEngine : 'rule-based'),
        reachable,
        url: useLmStudio ? lmstudioUrl : ollamaUrl,
        provider: useLmStudio ? 'lmstudio' : 'ollama',
        model,
        models,
        error,
        openai: { configured: Boolean(openaiKey), model: openaiModel },
        rag: await ragStatus({ fetchImpl }),
        checkedAt: stamp(),
      };
    },

    /**
     * POST /api/ai/analyze — OpenAI cloud → LM Studio/Ollama local + RAG →
     * playbook rule-based kèm nguồn RAG. Luôn 200 khi input hợp lệ.
     */    async analyze(ticket) {
      const ragOf = (hits) => ({ hits: hits.length, sources: hits.map((h) => h.source).filter(Boolean) });
      const { ragHits, ragCtx } = await getRag(ticket);
      // Tầng local: LM Studio (OpenAI-compat) khi LLM_PROVIDER=lmstudio, còn lại Ollama.
      const localEngine = useLmStudio ? 'lmstudio' : 'ollama';
      const localChat = () => (useLmStudio
        ? lmstudioChat(ticket, ragCtx, ragHits)
        : ollamaChat(ticket, ragCtx, ragHits));
      // Tầng 1: OpenAI cloud (nếu có key).
      if (openaiKey) {
        try {
          const analysis = await openaiChat(buildUserContent(ticket, ragCtx));
          return { engine: 'openai', model: openaiModel, playbook: null, rag: ragOf(ragHits), ...analysis, generatedAt: stamp() };
        } catch (err) {
          // Rớt xuống LLM local, giữ lý do để debug (không lộ key).
          try {
            const { analysis } = await localChat();
            return { engine: localEngine, model, playbook: null, rag: ragOf(ragHits), ...analysis, generatedAt: stamp(), fallbackReason: `OpenAI lỗi (${err.message}) → dùng ${localEngine} local` };
          } catch (err2) {
            const out = { ...ruleBasedAnalyze(ticket), rag: ragOf(ragHits), fallbackReason: `OpenAI: ${err.message}; ${localEngine}: ${err2.message}`.slice(0, 300) };
            if (ragHits.length) out.summary = `(RAG: ${ragHits[0].source}) ${out.summary}`;
            return out;
          }
        }
      }
      try {
        const { analysis } = await localChat();
        return { engine: localEngine, model, playbook: null, rag: ragOf(ragHits), ...analysis, generatedAt: stamp() };
      } catch (err) {
        // Fallback giữ engine 'rule-based' (hợp đồng test) + đính kèm nguồn RAG.
        const out = { ...ruleBasedAnalyze(ticket), rag: ragOf(ragHits), fallbackReason: err.message };
        if (ragHits.length) out.summary = `(RAG: ${ragHits[0].source}) ${out.summary}`;
        return out;
      }
    },

    /**
     * POST /api/ai/log-analysis — FPT AI Camera evidence (LLM root-cause từ log thật).
     * Offline-first: parse rule-based thật (đếm ERROR/WARN, gom nhóm, mask PII VN),
     * rồi mới thử enrich bằng LLM local nếu reachable; LLM fail → vẫn trả rule result.
     * Input: { logs: string[] (≤200 dòng), service?: string, metrics?: object }
     */
    async analyzeLogs({ logs, service = 'unknown', metrics = null }) {
      const lines = (Array.isArray(logs) ? logs : []).map((l) => String(l).slice(0, 2000)).slice(0, 200);
      const maskPii = (s) => String(s)
        .replace(/(0\d{9})/g, '[PHONE]')
        .replace(/(\d{9}|\d{12})/g, '[ID]');
      // Mask PII TRƯỚC khi phân loại: số điện thoại như 0912345678 chứa "567"
      // sẽ false-positive với pattern HTTP 5xx nếu classify trên raw log.
      const clean = lines.map(maskPii);
      const errors = clean.filter((l) => /error|fail|exception|timeout|\b5\d\d\b|panic/i.test(l));
      const warns = clean.filter((l) => /warn|degraded|retry|slow/i.test(l));
      // Gom nhóm theo 80 ký tự đầu sau khi bỏ timestamp/số
      const norm = (l) => maskPii(l).replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d:.Z+-]*/g, '').replace(/\d+/g, '#').slice(0, 80);
      const groups = {};
      for (const e of errors) {
        const k = norm(e);
        groups[k] = groups[k] || { pattern: k, count: 0, sample: String(e).slice(0, 300) };
        groups[k].count += 1;
      }
      const top = Object.values(groups).sort((a, b) => b.count - a.count).slice(0, 5);
      const severity = errors.length >= 10 ? 'critical' : errors.length >= 3 ? 'high' : errors.length >= 1 ? 'medium' : 'low';
      const runbook = severity === 'critical'
        ? 'Dừng deploy, rollback bản cuối tốt, kiểm tra /health/ready + /metrics, xem incident-runbook.'
        : severity === 'high'
          ? 'Kiểm tra dependency (DB/Qdrant/LLM upstream), xem metrics p95, restart service lỗi.'
          : 'Theo dõi thêm 15 phút, kiểm tra dashboard golden-signals.';
      const base = {
        engine: 'log-rule',
        service: str(service) || 'unknown',
        totalLines: lines.length,
        errorCount: errors.length,
        warnCount: warns.length,
        severity,
        topPatterns: top,
        evidenceLines: errors.slice(0, 5),
        suggestedRunbook: runbook,
        metricsSnapshot: metrics && typeof metrics === 'object' ? metrics : null,
        generatedAt: stamp(),
      };
      // Thử enrich bằng LLM local (best-effort, timeout ngắn, không bao giờ throw).
      try {
        const prompt = `Bạn là SRE. Tóm tắt root-cause từ ${errors.length} dòng lỗi của service ${base.service}. Top pattern: ${top.map((t) => `${t.pattern} x${t.count}`).join(' | ').slice(0, 600)}. Trả JSON {"root_cause": "...", "next_action": "..."}.`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
          const url = useLmStudio ? `${lmstudioUrl}/chat/completions` : `${ollamaUrl}/api/chat`;
          const isLms = useLmStudio;
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Project': 'IT-Helpdesk-Lab' },
            body: isLms
              ? JSON.stringify({ model, temperature: 0.1, max_tokens: 300, stream: false, messages: [{ role: 'user', content: prompt }] })
              : JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }),
            signal: controller.signal,
          });
          if (res.ok) {
            const data = await res.json();
            const text = isLms
              ? (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
              : (data.message && data.message.content) || '';
            if (text) {
              base.engine = isLms ? 'lmstudio-log' : 'ollama-log';
              base.llmSummary = String(text).slice(0, 800);
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (_) { /* giữ rule result */ }
      return base;
    },
  };
}

module.exports = { createAi, ruleBasedAnalyze, parseAnalysisJson };
