'use strict';

/**
 * Tenant isolation for request-scoped collections.
 *
 * The invariant this file exists to hold:
 *
 *     cross_tenant_ticket_access = 0
 *     cross_tenant_asset_access  = 0
 *
 * Two rules make that true rather than decorative:
 *
 *  1. The caller's tenant is taken from `req.user.tenant`, which `auth.js` puts
 *     on the session at login from the configured user record. It is never read
 *     from a query parameter, header or body field — if it were, any
 *     authenticated caller could simply ask for someone else's rows.
 *
 *  2. A row with no tenant is treated as belonging to the DEFAULT tenant only.
 *     That is what keeps pre-tenancy seeded data visible instead of vanishing.
 *     It does NOT mean "unscoped": the comparison is still an equality check, so
 *     a tenant-A caller can never match a tenant-B row or a genuinely
 *     unowned row that some other code stamped.
 *
 * Fail-closed direction: when a row belongs to another tenant, the single-row
 * lookup answers 404 rather than 403. Telling a caller "this exists but is not
 * yours" is itself a cross-tenant disclosure, so absence is reported as
 * absence.
 */

const { DEFAULT_TENANT, normalizeTenant } = require('./auth');

/** Tenant of a stored row; legacy rows (no tenant field) fall back to default. */
function tenantOfRow(row) {
  return normalizeTenant(row && row.tenant);
}

/**
 * Rows visible to `user`. An unauthenticated user (no `user`) sees nothing —
 * an anonymous read path must never widen to "all rows".
 */
function rowsVisibleTo(rows, user) {
  if (!user || !user.tenant) return [];
  const tenant = normalizeTenant(user.tenant);
  return rows.filter((row) => tenantOfRow(row) === tenant);
}

/**
 * Single-row access with the 404 disclosure policy: a row that exists but
 * belongs to another tenant is reported exactly like a row that does not exist.
 */
function findVisible(rows, user, id, key = 'id') {
  const wanted = String(id);
  const row = rows.find((r) => String(r && r[key]) === wanted);
  if (!row) return { found: false, reason: 'absent' };
  if (!user || !user.tenant) return { found: false, reason: 'absent' };
  if (tenantOfRow(row) !== normalizeTenant(user.tenant)) return { found: false, reason: 'absent' };
  return { found: true, row };
}

/** Stamp a tenant on a newly created row from the authenticated session. */
function stampTenant(row, user) {
  return { ...row, tenant: normalizeTenant(user && user.tenant) };
}

module.exports = { tenantOfRow, rowsVisibleTo, findVisible, stampTenant, DEFAULT_TENANT };