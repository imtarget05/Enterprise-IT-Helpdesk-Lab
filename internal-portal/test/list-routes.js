'use strict';

/**
 * Danh sách route REST thật sự được đăng ký trong src/app.js và
 * src/enterprise-routes.js.
 *
 * Extraction is delegated to test/route-inventory.js, a character-level
 * JavaScript scanner. The previous implementation used a single regex and
 * silently missed double-quoted paths, backtick paths, `router.*`,
 * `app.route(...).get()` chains, array registrations, and any path held in a
 * variable. Because the same list fed duplicate detection, route coverage, and
 * the OpenAPI comparison, one missed registration could disappear from all
 * three gates at once.
 *
 *   listRawSourceRoutes()      → MỌI registration, giữ nguyên, kèm file + line.
 *   listSourceRoutes()         → compatibility set: đã dedupe theo METHOD+path.
 *   findDuplicateSignatures()  → signature đăng ký >1 lần.
 *   unresolvedRegistrations()  → registration scanner KHÔNG resolve được.
 *                                Callers must fail closed on this list.
 *
 * Normalise path: bỏ dấu `/` cuối (runtime coi `/x/` và `/x` là cùng route),
 * nhưng GIỮ `/api/tickets/export.csv` khác `/api/tickets/:id`.
 *
 * CLI:  node test/list-routes.js
 */

const { inventoryFor, normalisePath, keyOf, SOURCE_FILES, APP_FILE, ENTERPRISE_FILE, PORTAL_ROOT } = require('./route-inventory');

/** Mọi registration, giữ nguyên thứ tự file + thứ tự xuất hiện, kèm line. */
function listRawSourceRoutes(appFile = SOURCE_FILES) {
  return inventoryFor(appFile).routes.map((r) => ({
    method: r.method,
    path: r.path,
    file: r.file,
    line: r.line,
    key: keyOf(r),
  }));
}

/** Registration mà scanner không resolve được -> phải fail closed. */
function unresolvedRegistrations(appFile = SOURCE_FILES) {
  return inventoryFor(appFile).unresolved;
}

/** Compatibility set: mỗi METHOD+path (đã normalise) chỉ giữ 1 occurrence. */
function listSourceRoutes(appFile = SOURCE_FILES) {
  const seen = new Set();
  const routes = [];
  for (const r of listRawSourceRoutes(appFile)) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    routes.push({ method: r.method, path: r.path, file: r.file, line: r.line });
  }
  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

/** Signatures đăng ký >1 lần; không dedupe trước assertion. */
function findDuplicateSignatures(appFile = SOURCE_FILES) {
  const byKey = new Map();
  for (const r of listRawSourceRoutes(appFile)) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const dups = [];
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      const [method, ...rest] = key.split(' ');
      dups.push({ method, path: rest.join(' '), occurrences: list });
    }
  }
  return dups.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

if (require.main === module) {
  const routes = listSourceRoutes();
  for (const r of routes) console.log(`${r.method.padEnd(6)} ${r.path}`);
  const dups = findDuplicateSignatures();
  const unresolved = unresolvedRegistrations();
  console.log(`\n${routes.length} routes đăng ký trong src/app.js + src/enterprise-routes.js`);
  console.log(`${dups.length} duplicate signature`);
  for (const d of dups) {
    console.log(`  DUP ${d.method} ${d.path}`);
    for (const o of d.occurrences) console.log(`      ${o.file}:${o.line}`);
  }
  console.log(`${unresolved.length} registration chưa resolve được (fail-closed)`);
  for (const u of unresolved) console.log(`  UNRESOLVED ${u.file}:${u.line} ${u.reason} | ${u.snippet}`);
}

module.exports = {
  listSourceRoutes, listRawSourceRoutes, findDuplicateSignatures,
  unresolvedRegistrations, normalisePath, keyOf,
  APP_FILE, ENTERPRISE_FILE, SOURCE_FILES, PORTAL_ROOT,
};
