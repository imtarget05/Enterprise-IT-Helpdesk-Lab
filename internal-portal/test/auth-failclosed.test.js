'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createAuth, MODES } = require('../src/auth');

describe('auth modes — fail-closed enterprise', () => {
  test('enterprise mode without users throws at boot (no anonymous privileged path)', () => {
    assert.throws(
      () => createAuth({ authMode: 'enterprise', authUsers: {} }),
      /fail-closed/,
    );
  });

  test('enterprise mode with users boots and reports its mode', () => {
    const auth = createAuth({
      authMode: 'enterprise',
      authUsers: { admin: { password: 'x', role: 'IT_ADMIN' } },
    });
    assert.equal(auth.mode, 'enterprise');
  });

  test('unknown AUTH_MODE fails closed instead of falling back to open', () => {
    assert.throws(() => createAuth({ authMode: 'sso' }), /unknown AUTH_MODE/);
  });

  test('legacy mode is refused in production', () => {
    assert.throws(
      () => createAuth({ authMode: 'legacy', nodeEnv: 'production' }),
      /legacy auth is refused/,
    );
    // ...but stays available for the local lab/dev loop
    const dev = createAuth({ authMode: 'legacy', nodeEnv: 'development' });
    assert.equal(dev.mode, 'legacy');
  });

  test('enterprise mode still issues and enforces session tokens per role', async () => {
    const auth = createAuth({
      authMode: 'enterprise',
      authUsers: {
        viewer: { password: 'pw', role: 'VIEWER' },
        admin: { password: 'pw2', role: 'IT_ADMIN' },
      },
    });
    const bad = auth.login('viewer', 'wrong');
    assert.equal(bad, null, 'wrong password must not issue a token');
    const session = auth.login('viewer', 'pw');
    assert.ok(session && session.token, 'valid login must issue a token');
    const viewer = auth.authenticateRequest({ headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(viewer.role, 'VIEWER');
    assert.equal(auth.hasPermission(viewer, 'ticket:write'), false);
    assert.equal(auth.hasPermission({ role: 'IT_ADMIN' }, 'ticket:write'), true);
    assert.equal(MODES.ENTERPRISE, 'enterprise');
  });
});