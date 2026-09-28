'use strict';

/**
 * Agent memory — hai tầng, đúng vai trò trong kiến trúc agent:
 *
 *   Session memory (ngắn hạn) — lịch sử hội thoại của một phiên làm việc,
 *     giữ "đang nói về cái gì" qua các lượt. Lưu trong RAM với TTL, không
 *     ghi đĩa: dữ liệu phiên demo không cần sống lâu và không nên tồn tại
 *     vô thời hạn.
 *
 *   Long-term memory (dài hạn) — sở thích và thông tin ổn định của người
 *     dùng ("tôi ở phòng Accounting", "ưu tiên trả lời tiếng Việt"). Ghi
 *     xuống JSON trong dataDir, scope theo (user, tenant) để không rò
 *     chéo người dùng. Chỉ ghi nhận những gì người dùng CHỦ ĐỘNG nói về
 *     bản thân, không tự động nhặt từ nội dung ticket.
 *
 * Zero-dependency: chỉ `node:fs`. Cùng style với `src/store.js` (atomic
 * write qua file tạm + rename) để không hỏng db khi bị kill giữa lúc ghi.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_SESSIONS = 200;
const MAX_TURNS_PER_SESSION = 20;
const MAX_MEMORIES_PER_USER = 100;
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const nowIso = () => new Date().toISOString();

/**
 * Trích xuất (type, content) từ một câu tự nhiên.
 *
 * Cố ý thận trọng: chỉ nhận câu tự khai rõ ràng ("tôi tên là", "tôi ở
 * phòng"). Không suy diễn từ nội dung sự cố — nếu không, mọi ticket người
 * dùng nhắc sẽ biến thành ký ức dài hạn và LTM nhiễm dữ liệu vụn vặt.
 * Thứ tự quan trọng: mẫu "tôi tên là" phải thắng mẫu "hãy" tổng quát.
 */
const EXTRACTORS = [
  ['fact', /(?:tôi tên là|hãy gọi tôi là|my name is|call me)\s+([^,.;!?]{2,60})/i],
  ['fact', /(?:tôi ở phòng|tôi làm việc ở phòng|thuộc phòng)\s+([^,.;!?]{2,60})/i],
  ['preference', /(?:tôi thích|tôi ưu tiên|hãy trả lời|prefer|i prefer|i like)\s+([^,.;!?]{2,80})/i],
];

/** Rút ký ức từ một lượt hội thoại; trả về mảng { type, content }. */
function extractMemories(text) {
  const source = str(text);
  if (!source) return [];
  const out = [];
  for (const [type, pattern] of EXTRACTORS) {
    const match = source.match(pattern);
    if (match && match[1] && match[1].trim().split(/\s+/).length >= 1) {
      out.push({ type, content: match[0].trim().slice(0, 200) });
    }
  }
  return out;
}

/**
 * Bộ nhớ hai tầng cho agent.
 *
 * @param {object} options
 * @param {string} [options.dataDir]  thư mục ghi LTM; bỏ trống → LTM chỉ ở RAM.
 * @param {number} [options.sessionTtlMs]
 * @param {boolean} [options.ltmEnabled] tắt → mọi helper LTM là no-op.
 */
function createMemory(options = {}) {
  const ltmEnabled = options.ltmEnabled !== false;
  const ltmFile = options.dataDir ? path.join(options.dataDir, 'agent-memory.json') : null;
  const sessionTtlMs = Number(options.sessionTtlMs || DEFAULT_SESSION_TTL_MS);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** sessionId -> { turns: [{role, content, at}], updatedAt, context: {} } */
  const sessions = new Map();
  /** userKey -> [{ id, type, content, createdAt }] — nguồn sự thật trong RAM. */
  const longTerm = new Map();
  let ltmLoaded = false;
  let writeChain = Promise.resolve();

  /** Dọn phiên hết hạn và cắt bớt khi vượt trần. */
  function sweep() {
    const cutoff = now() - sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.updatedAt < cutoff) sessions.delete(id);
    }
    // Chặn tăng trưởng vô hạn khi không ai hỏi lại phiên cũ: xoá phiên lâu
    // không được đụng nhất.
    while (sessions.size > MAX_SESSIONS) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [id, session] of sessions) {
        if (session.updatedAt < oldestAt) { oldestAt = session.updatedAt; oldestKey = id; }
      }
      if (oldestKey === null) break;
      sessions.delete(oldestKey);
    }
  }

  const api = {
    /** Ghi một lượt vào lịch sử phiên (giữ tối đa MAX_TURNS_PER_SESSION lượt). */
    appendTurn(sessionId, role, content) {
      const id = str(sessionId) || 'default';
      sweep();
      let session = sessions.get(id);
      if (!session) {
        session = { turns: [], updatedAt: now(), context: {} };
        sessions.set(id, session);
      }
      session.turns.push({ role: str(role), content: str(content).slice(0, 2000), at: nowIso() });
      if (session.turns.length > MAX_TURNS_PER_SESSION) {
        session.turns = session.turns.slice(-MAX_TURNS_PER_SESSION);
      }
      session.updatedAt = now();
      return session.turns.length;
    },

    /** Lịch sử phiên dạng mảng (rỗng nếu phiên không tồn tại/hết hạn). */
    history(sessionId) {
      const session = sessions.get(str(sessionId) || 'default');
      return session ? session.turns.slice() : [];
    },

    /**
     * Lịch sử đã rút gọn để đưa vào prompt. Giới hạn theo ký tự chứ không
     * theo số lượt: một lượt dài 2k ký tự × 20 lượt vẫn vượt ngân sách context.
     */
    contextFor(sessionId, maxChars = 1500) {
      const turns = api.history(sessionId);
      const lines = [];
      let used = 0;
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const line = `${turns[i].role}: ${turns[i].content}`;
        if (used + line.length > maxChars) break;
        lines.unshift(line);
        used += line.length;
      }
      return lines.join('\n');
    },

    /** Ghi nhớ trạng thái tạm của phiên (ví dụ: ticket đang xử lý). */
    setContext(sessionId, key, value) {
      const session = sessions.get(str(sessionId) || 'default');
      if (session) session.context[str(key)] = value;
      return api.getContext(sessionId, key);
    },

    getContext(sessionId, key) {
      const session = sessions.get(str(sessionId) || 'default');
      return session ? session.context[str(key)] : undefined;
    },

    get sessionCount() {
      sweep();
      return sessions.size;
    },

    // ------------------------------------------------------- long-term memory
    userKey(user, tenant) {
      return `${str(tenant) || 'default'}:${str(user) || 'anonymous'}`;
    },

    /**
     * Nạp LTM từ đĩa (idempotent, bỏ qua lỗi — LTM hỏng không được làm sập
     * API, chỉ mất ghi nhớ).
     */
    async load() {
      if (ltmLoaded || !ltmEnabled) return api;
      ltmLoaded = true;
      if (!ltmFile) return api;
      try {
        const raw = await fsp.readFile(ltmFile, 'utf8');
        const parsed = JSON.parse(raw);
        for (const [key, rows] of Object.entries(parsed || {})) {
          longTerm.set(key, Array.isArray(rows) ? rows : []);
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          console.warn(`[agent-memory] không đọc được LTM (${err.message}) → khởi đầu rỗng.`);
        }
      }
      return api;
    },

    /**
     * Ghi LTM xuống đĩa nguyên tử (tmp + rename) — tránh file hỏng khi tiến
     * trình bị kill giữa lúc ghi. Ghi tuần tự qua writeChain để hai lượt
     * song song không ghi đè lên nhau.
     */
    persist() {
      if (!ltmFile) return Promise.resolve();
      const payload = JSON.stringify(Object.fromEntries(longTerm), null, 2);
      const tmp = `${ltmFile}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      writeChain = writeChain.then(async () => {
        try {
          await fsp.mkdir(path.dirname(ltmFile), { recursive: true });
          await fsp.writeFile(tmp, `${payload}\n`, 'utf8');
          await fsp.rename(tmp, ltmFile);
        } catch (err) {
          console.warn(`[agent-memory] không ghi được LTM (${err.message}).`);
        }
      });
      return writeChain;
    },

    /**
     * Ghi một ký ức dài hạn. Trùng nội dung → trả về ký ức cũ (dedupe), nên
     * gọi lại cùng một câu không làm phình LTM.
     */
    async remember(user, tenant, type, content) {
      if (!ltmEnabled) return null;
      const text = str(content).slice(0, 200);
      if (!text) return null;
      const key = api.userKey(user, tenant);
      const rows = longTerm.get(key) || [];
      const existing = rows.find((r) => r.content === text);
      if (existing) return existing;
      const entry = { id: crypto.randomUUID(), type: str(type) || 'fact', content: text, createdAt: nowIso() };
      rows.push(entry);
      // Giữ ký ức mới nhất — thông tin mới thay thế thông tin cũ.
      longTerm.set(key, rows.slice(-MAX_MEMORIES_PER_USER));
      await api.persist();
      return entry;
    },

    /**
     * Gọi sau mỗi lượt người dùng: tự động trích ký ức nếu câu có tự khai.
     * Ghi bổ sung — lỗi đã bị nuốt trong persist() nên không được phép làm
     * hỏng lượt trả lời đang chạy.
     */
    async absorb(user, tenant, text) {
      if (!ltmEnabled) return [];
      const found = extractMemories(text);
      const saved = [];
      for (const item of found) {
        const entry = await api.remember(user, tenant, item.type, item.content);
        if (entry) saved.push(entry);
      }
      return saved;
    },

    /** Ký ức của một người dùng (mới nhất trước). */
    recall(user, tenant, k = 5) {
      if (!ltmEnabled) return [];
      const rows = longTerm.get(api.userKey(user, tenant)) || [];
      return rows.slice(-k).reverse();
    },

    /** LTM dạng chữ để nhét vào prompt; chỉ dùng thông tin của chính user này. */
    recallText(user, tenant, k = 5) {
      const rows = api.recall(user, tenant, k);
      if (!rows.length) return '';
      return ['ĐÃ GHI NHỚ VỀ NGƯỜI DÙNG NÀY (chỉ áp dụng cho họ):', ...rows.map((r) => `- ${r.content}`)].join('\n');
    },

    get ltmCount() {
      let total = 0;
      for (const rows of longTerm.values()) total += rows.length;
      return total;
    },
  };

  return api;
}

module.exports = { createMemory, extractMemories };
