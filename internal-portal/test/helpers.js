'use strict';

/**
 * Test helpers: boot app thật trên ephemeral port + HTTP client tối giản.
 * Mỗi file test tạo 1 client riêng (dataDir riêng) → các test độc lập, không thứ tự.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/app');

async function createTestClient() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-test-'));
  let server;
  let baseUrl;
  let context;

  async function start() {
    context = await createApp({ dataDir });
    await new Promise((resolve) => {
      server = context.app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return context;
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }

  function api(method, urlPath, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(baseUrl + urlPath, init);
  }

  async function json(method, urlPath, body) {
    const res = await api(method, urlPath, body);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  /** Gửi raw body (dùng cho test payload JSON hỏng / sai content-type). */
  async function send(method, urlPath, rawBody, contentType = 'application/json') {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: { 'Content-Type': contentType },
      body: rawBody,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  async function cleanup() {
    await stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  return {
    dataDir,
    dbFile: path.join(dataDir, 'db.json'),
    start,
    stop,
    api,
    json,
    send,
    cleanup,
    get origin() {
      return baseUrl;
    },
    get context() {
      return context;
    },
  };
}

module.exports = { createTestClient };
