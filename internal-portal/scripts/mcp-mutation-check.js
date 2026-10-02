'use strict';

/**
 * MCP mutation harness.
 *
 * Purpose: prove the boundary tests FAIL when the guard they claim to pin is
 * removed. The Wave A harness taught the lesson that matters — a mutation is
 * only evidence about itself when it is the ONLY difference from baseline, so
 * every mutation here restores its file before the next one runs, and a
 * non-zero exit is never treated as a catch on its own (only an assertion
 * failure counts).
 *
 * Every gate here is a real assertion in mcp-boundary.test.js. If a mutation
 * SURVIVES, that test does not pin what it claims to.
 *
 * Run: node scripts/mcp-mutation-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = path.resolve(ROOT, 'src', 'mcp', 'registry.js');
const CONTEXT = path.resolve(ROOT, 'src', 'mcp', 'context.js');
const READ_TOOLS = path.resolve(ROOT, 'src', 'mcp', 'read-tools.js');
const PROPOSE = path.resolve(ROOT, 'src', 'mcp', 'propose.js');
const GATE = path.resolve(ROOT, 'test', 'mcp-boundary.test.js');

const MUTATIONS = [
  {
    id: 'M-MCP1',
    name: 'read tools fall back to an unscoped tenant',
    file: READ_TOOLS,
    // The confused-deputy shape: a read tool dropping the session tenant and
    // degrading to whatever retrieval does with nothing. Without a test for
    // this, "tenant comes from the session" is only a comment.
    find: 'const rows = rowsVisibleTo(ctx.store.data.tickets, ctx.user);\n      const hit = findVisible(rows, ctx.user, a.ticketId);',
    replace: 'const rows = ctx.store.data.tickets;\n      const hit = findVisible(rows, { tenant: "tenant-alpha" }, a.ticketId);',
  },
  {
    id: 'M-MCP2',
    name: 'tenant accepted as a tool argument (confused deputy)',
    file: CONTEXT,
    find: "  'tenant',\n  'tenant_id',\n  'tenantid',",
    replace: "  'tenant_unused',",
  },
  {
    id: 'M-MCP3',
    name: 'knowledge.search bypasses tenant-scoped retrieval',
    file: READ_TOOLS,
    find: 'const hits = await retrieve(a.query, topK, {\n        tenantId: ctx.tenant,',
    replace: 'const hits = await retrieve(a.query, topK, {\n        tenantId: options.__trusted || undefined,',
  },
  {
    id: 'M-MCP4',
    name: 'registry no longer asserts the absence of an execution surface',
    file: REGISTRY,
    find: 'assertNoExecutionSurface(tools);',
    replace: 'void tools;',
  },
  {
    id: 'M-MCP5',
    name: 'raw command field accepted (shell-shaped payload)',
    file: CONTEXT,
    find: "  'command',\n  'cmd',",
    replace: "  'command_unused',",
  },
  {
    id: 'M-MCP6',
    name: 'RBAC check removed from automation.propose',
    file: PROPOSE,
    find: 'if (!AUTOMATION_ROLES.includes(ctx.role)) {',
    replace: 'if (false) {',
  },
  {
    id: 'M-MCP7',
    name: 'HIGH_RISK no longer reports that approval is required',
    file: PROPOSE,
    find: 'requiresApproval: risk === RISK.HIGH_RISK || risk === RISK.UNKNOWN,',
    replace: 'requiresApproval: false,',
  },
  {
    id: 'M-MCP8',
    name: 'unauthenticated context accepted (no tenant required)',
    file: CONTEXT,
    find: "  if (!user || !actor || !rawTenant) {",
    replace: "  if (false) {",
  },
];

const originals = new Map();
for (const f of [REGISTRY, CONTEXT, READ_TOOLS, PROPOSE]) originals.set(f, fs.readFileSync(f, 'utf8'));

const results = [];

function runGate() {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=60000', '--test-force-exit', GATE], {
    encoding: 'utf8',
    timeout: 180000,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0) return { failed: false };
  return {
    failed: true,
    status: r.status,
    assertionFailure: /AssertionError|ERR_ASSERTION/.test(output),
    output,
  };
}

try {
  for (const m of MUTATIONS) {
    const original = originals.get(m.file);
    if (!original.includes(m.find)) {
      results.push({ id: m.id, name: m.name, outcome: 'ERROR: anchor not found — mutation did not apply' });
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.find, m.replace));
    const { failed, status, assertionFailure } = runGate();
    // Restore immediately: the next mutation must not inherit this one.
    fs.writeFileSync(m.file, original);
    results.push({
      id: m.id,
      name: m.name,
      outcome: failed && assertionFailure
        ? 'CAUGHT (assertion failed)'
        : failed
          ? `UNCATCHED — gate exited ${status} with no assertion failure`
          : 'SURVIVED — the gate passed with this mutation applied',
      weak: failed && !assertionFailure,
    });
  }
} finally {
  for (const [f, original] of originals) fs.writeFileSync(f, original);
}

const restored = runGate();
const survived = results.filter((r) => r.outcome.startsWith('SURVIVED') || r.outcome.startsWith('ERROR'));
const weak = results.filter((r) => r.weak);
const caught = results.filter((r) => r.outcome.startsWith('CAUGHT'));

for (const r of results) console.log(`${r.id.padEnd(8)} ${r.outcome}\n         ${r.name}`);
console.log(`\nbaseline restored: ${restored.failed ? 'FAILING' : 'green'}`);
console.log(`${caught.length}/${results.length} mutations caught`);
if (weak.length) console.log(`WARNING: ${weak.length} ended in a crash/hang rather than an assertion failure`);
process.exit(survived.length === 0 && weak.length === 0 && !restored.failed ? 0 : 1);