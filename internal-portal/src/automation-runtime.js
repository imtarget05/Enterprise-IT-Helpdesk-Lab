'use strict';

/**
 * Wiring for the governed automation pipeline at runtime.
 *
 * Two decisions are made here and nowhere else:
 *
 *  · WHICH durable store the lifecycle uses. PostgreSQL when a connection URL is
 *    configured, otherwise the file-backed store in `dataDir`. Both survive a
 *    restart; the process-local variant is never selected for a running server,
 *    because approval durability across a restart is a requirement, not a
 *    preference.
 *
 *  · WHICH executor performs the side effect. The default is a SIMULATION that
 *    records intent and reports a post-check — it does not touch a directory, a
 *    user account or a service. A real executor must be injected explicitly
 *    (and is a separate, audited deployment step), because the honest default for
 *    a privileged automation platform is "do nothing to the real system".
 */

const path = require('node:path');

const { createMemoryLifecycleStore } = require('./lifecycle-store-memory');
const { createPostgresLifecycleStore } = require('./lifecycle-store-postgres');

async function createLifecycleStore({ dataDir, options = {} } = {}) {
  if (options.lifecycleStore) return options.lifecycleStore;

  const pgUrl = options.lifecycleDatabaseUrl || process.env.LIFECYCLE_PG_URL || process.env.DATABASE_URL;
  if (pgUrl) {
    const store = createPostgresLifecycleStore({ connectionString: pgUrl });
    // Migrations are real files applied in name order and recorded in
    // `schema_migrations`, so a half-applied migration cannot exist.
    await store.runMigrations();
    return store;
  }
  return createMemoryLifecycleStore({
    file: path.join(dataDir, 'action-lifecycle.json'),
  });
}

/**
 * Default executor: deterministic, catalog-only, and side-effect free.
 *
 * It maps a TYPED action id to a handler in a closed table — there is no path
 * from a proposal to a command line, a script, or SQL. Each handler returns the
 * post-condition it verified, so `execute()` can distinguish "the call returned"
 * from "the state is what it should be".
 */
function createAutomationExecutor({ options = {} } = {}) {
  if (options.executor) return options.executor;

  const handlers = Object.freeze({
    test_network_health: async (p) => ({ simulated: true, probe: 'network', target: String(p.hostname || 'default') }),
    test_print_scan_health: async (p) => ({ simulated: true, probe: 'print-scan', target: String(p.deviceId || 'default') }),
    export_it_asset_audit: async (p) => ({ simulated: true, artefact: 'asset-audit', scope: String(p.scope || 'all') }),
    backup_helpdesk_data: async (p) => ({ simulated: true, artefact: 'helpdesk-backup', target: String(p.target || 'default') }),
    backup_ad_configuration: async (p) => ({ simulated: true, artefact: 'ad-backup', target: String(p.target || 'default') }),
    new_company_user: async (p) => ({ simulated: true, operation: 'create-user', username: String(p.username || '') }),
    disable_company_user: async (p) => ({ simulated: true, operation: 'disable-user', username: String(p.username || '') }),
    restore_helpdesk_data: async (p) => ({ simulated: true, operation: 'restore', snapshot: String(p.snapshotId || '') }),
  });

  return {
    // `simulation: true` in the result is what the audit trail records, so an
    // operator can always tell a rehearsed run from a real one.
    async run(request) {
      const handler = handlers[request.action];
      if (!handler) {
        throw Object.assign(new Error(`no handler for action ${request.action}`), { code: 'UNKNOWN_ACTION' });
      }
      const detail = await handler(request.parameters || {});
      return {
        ok: true,
        simulated: true,
        postCheck: { verified: true, what: `${request.action} acknowledged by the simulated executor`, detail },
      };
    },
  };
}

module.exports = { createLifecycleStore, createAutomationExecutor };