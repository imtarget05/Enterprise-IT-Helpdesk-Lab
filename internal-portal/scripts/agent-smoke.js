'use strict';
/* Script kiểm thử nhanh tầng agent qua createAgent (không nằm trong test suite). */
const { createStore } = require('../src/store');
const { createAgent } = require('../src/agent');

const kill = setTimeout(() => { console.log('TIMEOUT-25s'); process.exit(9); }, 25000);

(async () => {
  const store = createStore({ dataDir: `/tmp/agt-${Date.now()}` });
  await store.load();
  const agent = await createAgent({ store });
  const d = agent.describe();
  console.log('engine:', d.engine, '| tools:', d.tools.length);
  console.log('sideEffect tools:', d.tools.filter((t) => t.sideEffect).map((t) => t.name).join(', '));
  console.log('autoAllowed:', d.tools.filter((t) => t.autoAllowed).map((t) => t.name).join(', '));

  const r = await agent.run({ question: 'hãy tạo ticket máy in lỗi', sessionId: 's', user: 'u1', tenant: 't1' });
  console.log('run:', r.status, '| has token:', Boolean(r.proposedAction));

  const ap = await agent.approve({ token: r.proposedAction.token, user: 'u1', tenant: 't1' });
  console.log('approve:', ap.ok, ap.ok ? `ticket#${ap.result.ticket.id}` : ap.error);

  const bad = await agent.approve({ token: 'act_fake', user: 'u1' });
  console.log('bad token:', bad.status, bad.code);

  const r2 = await agent.run({ question: 'Máy in bị kẹt giấy, xử lý sao?', sessionId: 's', user: 'u1', tenant: 't1' });
  console.log('read-only run:', r2.status, '| evidence:', r2.evidenceCount);

  clearTimeout(kill);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.stack); clearTimeout(kill); process.exit(1); });
