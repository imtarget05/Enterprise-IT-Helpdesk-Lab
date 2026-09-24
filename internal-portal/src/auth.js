'use strict';

const crypto = require('node:crypto');

const ROLES = Object.freeze({
  IT_ADMIN: 'IT_ADMIN',
  HELPDESK_L1: 'HELPDESK_L1',
  HELPDESK_L2: 'HELPDESK_L2',
  AUDITOR: 'AUDITOR',
  VIEWER: 'VIEWER',
  INTEGRATION_MINIERP: 'INTEGRATION_MINIERP',
});

const PERMISSIONS = Object.freeze({
  READ: 'read',
  TICKET_WRITE: 'ticket:write',
  ASSET_WRITE: 'asset:write',
  ASSET_ASSIGN: 'asset:assign',
  PROBLEM_WRITE: 'problem:write',
  CHANGE_WRITE: 'change:write',
  CHANGE_APPROVE: 'change:approve',
  ACCESS_APPROVE: 'access:approve',
  MONITOR_WRITE: 'monitor:write',
  AUDIT_READ: 'audit:read',
  INTEGRATION_WRITE: 'integration:write',
});

const ROLE_PERMISSIONS = Object.freeze({
  IT_ADMIN: Object.freeze(Object.values(PERMISSIONS)),
  HELPDESK_L1: Object.freeze([PERMISSIONS.READ, PERMISSIONS.TICKET_WRITE, PERMISSIONS.ASSET_WRITE, PERMISSIONS.PROBLEM_WRITE]),
  HELPDESK_L2: Object.freeze([PERMISSIONS.READ, PERMISSIONS.TICKET_WRITE, PERMISSIONS.ASSET_WRITE, PERMISSIONS.ASSET_ASSIGN, PERMISSIONS.PROBLEM_WRITE, PERMISSIONS.CHANGE_WRITE, PERMISSIONS.MONITOR_WRITE, PERMISSIONS.AUDIT_READ]),
  AUDITOR: Object.freeze([PERMISSIONS.READ, PERMISSIONS.AUDIT_READ]),
  VIEWER: Object.freeze([PERMISSIONS.READ]),
  INTEGRATION_MINIERP: Object.freeze([PERMISSIONS.READ, PERMISSIONS.INTEGRATION_WRITE]),
});

function parseUsers(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function rolePermissions(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createAuth(options = {}) {
  const mode = String(options.authMode || process.env.AUTH_MODE || 'legacy').toLowerCase();
  const users = parseUsers(options.authUsers || process.env.LAB_AUTH_USERS);
  const sessions = new Map();
  const ttlMs = Number(options.sessionTtlMs || 8 * 60 * 60 * 1000);
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function issue(username, role) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { username, role, expiresAt: now().getTime() + ttlMs });
    return token;
  }

  function authenticateRequest(req) {
    if (mode === 'legacy') return { username: 'legacy-demo', role: ROLES.IT_ADMIN, legacy: true };
    const header = String(req.headers.authorization || '');
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const session = sessions.get(match[1]);
    if (!session || session.expiresAt <= now().getTime()) {
      sessions.delete(match[1]);
      return null;
    }
    return { username: session.username, role: session.role };
  }

  function hasPermission(user, permission) {
    return Boolean(user && rolePermissions(user.role).includes(permission));
  }

  function middleware(req, _res, next) {
    req.user = authenticateRequest(req);
    next();
  }

  function requireAuth(permission) {
    return (req, res, next) => {
      if (mode === 'legacy') {
        req.user = req.user || { username: 'legacy-demo', role: ROLES.IT_ADMIN, legacy: true };
        return next();
      }
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required.', status: 401, path: req.originalUrl });
      }
      if (permission && !hasPermission(req.user, permission)) {
        return res.status(403).json({ error: 'Insufficient portal role.', requiredPermission: permission, status: 403, path: req.originalUrl });
      }
      return next();
    };
  }

  function login(username, password) {
    const user = users[String(username || '').toLowerCase()];
    if (!user || !safeEqual(user.password, password)) return null;
    const role = String(user.role || ROLES.VIEWER).toUpperCase();
    if (!ROLE_PERMISSIONS[role]) return null;
    return { token: issue(String(username), role), username: String(username), role, expiresInSeconds: Math.floor(ttlMs / 1000) };
  }

  function revoke(token) { sessions.delete(token); }

  return {
    mode,
    middleware,
    requireAuth,
    hasPermission,
    rolePermissions,
    login,
    revoke,
    usersConfigured: Object.keys(users).length,
  };
}

module.exports = { createAuth, ROLES, PERMISSIONS, ROLE_PERMISSIONS, rolePermissions };
