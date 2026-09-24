'use strict';

/**
 * API tests cho AI Assistant (LLM LOCAL qua Ollama — không OpenAI):
 *   1. Engine 'rule-based' (Ollama không khả dụng) — status/analyze/400/404.
 *   2. Engine 'ollama' — inject fetchImpl giả lập, không cần cài Ollama.
 *   3. Fail-soft: JSON hỏng từ model → fallback rule-based, không 500.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestClient } = require('./helpers');

// URL trỏ port 1 → connection refused tức thì → deterministic fallback
// (không phụ thuộc máy dev có cài Ollama hay không).
const UNREACHABLE = { ollamaUrl: 'http://127.0.0.1:1', timeoutMs: 500 };

/** Fetch giả lập Ollama: /api/tags → list model; /api/chat → JSON analysis. */
function fakeOllamaFetch(chatContent) {
  return async (url) => {
    if (url.endsWith('/api/tags')) {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen2.5:3b' }, { name: 'llama3.2:3b' }] }) };
    }
    if (url.endsWith('/api/chat')) {
      return { ok: true, status: 200, json: async () => ({ message: { content: chatContent } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const VALID_ANALYSIS = JSON.stringify({
  summary: 'Máy trạm mất mạng do nhận IP APIPA từ DHCP server bị dừng.',
  diagnosis: ['ipconfig /all kiểm tra APIPA', 'ipconfig /renew', 'kiểm tra DHCP service'],
  rca: 'Dịch vụ DHCP Server trên DC01 bị dừng sau reboot.',
  prevention: ['Đặt DHCP failover', 'theo dõi scope usage'],
});

test('GET /api/ai/status — Ollama không chạy → engine rule-based, không 500', async () => {
  const c = await createTestClient({ ai: UNREACHABLE });
  await c.start();
  try {
    const { status, data } = await c.json('GET', '/api/ai/status');
    assert.equal(status, 200);
    assert.equal(data.engine, 'rule-based');
    assert.equal(data.reachable, false);
    assert.ok(data.error, 'phải có lý do không reachable');
    assert.equal(data.url, 'http://127.0.0.1:1');
    assert.ok(data.checkedAt);
  } finally {
    await c.cleanup();
  }
});

test('GET /api/ai/status — Ollama chạy (fake) → engine ollama + list model', async () => {
  const c = await createTestClient({ ai: { ollamaUrl: 'http://ollama.local:11434', fetchImpl: fakeOllamaFetch(VALID_ANALYSIS) } });
  await c.start();
  try {
    const { status, data } = await c.json('GET', '/api/ai/status');
    assert.equal(status, 200);
    assert.equal(data.engine, 'ollama');
    assert.equal(data.reachable, true);
    assert.deepEqual(data.models, ['qwen2.5:3b', 'llama3.2:3b']);
  } finally {
    await c.cleanup();
  }
});

test('POST /api/ai/analyze {ticketId} — Ollama không chạy → fallback playbook theo keyword', async () => {
  const c = await createTestClient({ ai: UNREACHABLE });
  await c.start();
  try {
    const created = await c.json('POST', '/api/tickets', {
      title: 'Máy không có Internet, ipconfig báo IP APIPA 169.254',
      requester: 'Nguyen Thi Mai',
      dept: 'Accounting',
      priority: 'High',
      category: 'Network',
    });
    assert.equal(created.status, 201);

    const { status, data } = await c.json('POST', '/api/ai/analyze', { ticketId: created.data.id });
    assert.equal(status, 200);
    assert.equal(data.ticketId, created.data.id);
    assert.equal(data.engine, 'rule-based');
    assert.equal(data.playbook, 'Network — APIPA / DHCP');
    assert.ok(data.summary);
    assert.ok(Array.isArray(data.diagnosis) && data.diagnosis.length >= 4);
    assert.ok(data.rca);
    assert.ok(Array.isArray(data.prevention) && data.prevention.length >= 3);
    assert.ok(data.fallbackReason, 'phải ghi rõ lý do fallback');
    assert.ok(data.generatedAt);
  } finally {
    await c.cleanup();
  }
});

test('POST /api/ai/analyze {title} — input tự do, không cần ticket trong DB', async () => {
  const c = await createTestClient({ ai: UNREACHABLE });
  await c.start();
  try {
    const { status, data } = await c.json('POST', '/api/ai/analyze', {
      title: 'Không đăng nhập được, tài khoản bị khóa',
      requester: 'Le Hoang Nam',
      dept: 'Sales',
      priority: 'Medium',
      category: 'Active Directory',
    });
    assert.equal(status, 200);
    assert.equal(data.ticketId, null);
    assert.equal(data.engine, 'rule-based');
    assert.equal(data.playbook, 'Active Directory — mật khẩu / lockout');
  } finally {
    await c.cleanup();
  }
});

test('POST /api/ai/analyze — thiếu ticketId lẫn title → 400', async () => {
  const c = await createTestClient({ ai: UNREACHABLE });
  await c.start();
  try {
    const { status, data } = await c.json('POST', '/api/ai/analyze', {});
    assert.equal(status, 400);
    assert.ok(data.details && data.details.length, 'phải có chi tiết lỗi 400');
  } finally {
    await c.cleanup();
  }
});

test('POST /api/ai/analyze — ticketId không tồn tại → 404', async () => {
  const c = await createTestClient({ ai: UNREACHABLE });
  await c.start();
  try {
    const { status } = await c.json('POST', '/api/ai/analyze', { ticketId: 999999999 });
    assert.equal(status, 404);
  } finally {
    await c.cleanup();
  }
});

test('POST /api/ai/analyze — Ollama chạy (fake) → engine ollama, parse JSON analysis', async () => {
  const c = await createTestClient({ ai: { ollamaUrl: 'http://ollama.local:11434', fetchImpl: fakeOllamaFetch(VALID_ANALYSIS) } });
  await c.start();
  try {
    const { status, data } = await c.json('POST', '/api/ai/analyze', { title: 'Test ticket', category: 'General' });
    assert.equal(status, 200);
    assert.equal(data.engine, 'ollama');
    assert.equal(data.model, 'qwen2.5:3b');
    assert.equal(data.summary, 'Máy trạm mất mạng do nhận IP APIPA từ DHCP server bị dừng.');
    assert.equal(data.diagnosis.length, 3);
    assert.equal(data.playbook, null);
    assert.equal(data.fallbackReason, undefined);
  } finally {
    await c.cleanup();
  }
});

test('POST /api/ai/analyze — model trả JSON bọc lẫn lộn → vẫn parse được', async () => {
  const wrapped = '```json\n' + VALID_ANALYSIS + '\n```';
  const c = await createTestClient({ ai: { ollamaUrl: 'http://ollama.local:11434', fetchImpl: fakeOllamaFetch(wrapped) } });
  await c.start();
  try {
    const { status, data } = await c.json('POST', '/api/ai/analyze', { title: 'Test' });
    assert.equal(status, 200);
    assert.equal(data.engine, 'ollama');
    assert.ok(data.summary.includes('APIPA'));
  } finally {
    await c.cleanup();
  }
});

test('POST /api/ai/analyze — model trả JSON hỏng → fail-soft về rule-based, không 500', async () => {
  const c = await createTestClient({ ai: { ollamaUrl: 'http://ollama.local:11434', fetchImpl: fakeOllamaFetch('xin lỗi, tôi không thể') } });
  await c.start();
  try {
    const { status, data } = await c.json('POST', '/api/ai/analyze', { title: 'Máy in offline không in được' });
    assert.equal(status, 200);
    assert.equal(data.engine, 'rule-based');
    assert.equal(data.playbook, 'Hardware — máy in / thiết bị ngoại vi');
    assert.ok(data.fallbackReason);
  } finally {
    await c.cleanup();
  }
});

/** Fetch giả lập OpenAI chat completions (không tốn quota, không cần key thật). */
function fakeOpenAiFetch(chatContent) {
  return async (url, opts) => {
    if (String(url).includes('api.openai.com')) {
      const auth = (opts && opts.headers && opts.headers.Authorization) || '';
      assert.ok(auth.startsWith('Bearer '), 'phải gửi Authorization Bearer');
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: chatContent } }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('POST /api/ai/analyze — có OPENAI_API_KEY (fake) → engine openai, không lộ key', async () => {
  const c = await createTestClient({
    ai: { ollamaUrl: 'http://127.0.0.1:1', timeoutMs: 500, openaiKey: 'sk-test-fake', fetchImpl: fakeOpenAiFetch(VALID_ANALYSIS) },
  });
  await c.start();
  try {
    const { status, data } = await c.json('POST', '/api/ai/analyze', { title: 'Máy in offline', category: 'Hardware' });
    assert.equal(status, 200);
    assert.equal(data.engine, 'openai');
    assert.equal(data.model, 'gpt-4o-mini');
    assert.ok(data.summary.includes('APIPA'));
    assert.ok(Array.isArray((data.rag || {}).sources), 'phải có nguồn RAG');
    assert.equal(JSON.stringify(data).includes('sk-test-fake'), false, 'key không được xuất hiện trong response');
  } finally {
    await c.cleanup();
  }
});

test('POST /api/ai/analyze — OpenAI 401 → rớt về rule-based, báo rõ lý do', async () => {
  const badKey = async (url) => (String(url).includes('api.openai.com')
    ? { ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key' } }) }
    : { ok: false, status: 404, json: async () => ({}) });
  const c = await createTestClient({
    ai: { ollamaUrl: 'http://127.0.0.1:1', timeoutMs: 500, openaiKey: 'sk-bad', fetchImpl: badKey },
  });
  await c.start();
  try {
    const { status, data } = await c.json('POST', '/api/ai/analyze', { title: 'Máy in offline không in được' });
    assert.equal(status, 200);
    assert.equal(data.engine, 'rule-based');
    assert.ok(data.fallbackReason.includes('401'), 'phải báo rõ key không hợp lệ');
  } finally {
    await c.cleanup();
  }
});
