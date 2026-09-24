'use strict';

/**
 * Danh sách route REST thật sự được đăng ký trong src/app.js và
 * src/enterprise-routes.js (trích tĩnh bằng regex trên mã nguồn).
 *
 * CLI:  node test/list-routes.js        → in danh sách "METHOD /path"
 * API:  const { listSourceRoutes } = require('./list-routes');
 */

const fs = require('node:fs');
const path = require('node:path');

const APP_FILE = path.join(__dirname, '..', 'src', 'app.js');
const ENTERPRISE_FILE = path.join(__dirname, '..', 'src', 'enterprise-routes.js');
const SOURCE_FILES = [APP_FILE, ENTERPRISE_FILE];

function listSourceRoutes(appFile = SOURCE_FILES) {
  const files = Array.isArray(appFile) ? appFile : [appFile];
  const routes = [];
  const seen = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const re = /app\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(source)) !== null) {
      const method = m[1].toUpperCase();
      const routePath = m[2];
      const key = `${method} ${routePath}`;
      // app.js và enterprise-routes.js cố ý giữ một số compatibility route;
      // inventory chỉ tính một signature duy nhất.
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ method, path: routePath, file });
    }
  }
  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

if (require.main === module) {
  const routes = listSourceRoutes();
  for (const r of routes) console.log(`${r.method.padEnd(6)} ${r.path}`);
  console.log(`\n${routes.length} routes đăng ký trong src/app.js + src/enterprise-routes.js`);
}

module.exports = { listSourceRoutes, APP_FILE, ENTERPRISE_FILE, SOURCE_FILES };

