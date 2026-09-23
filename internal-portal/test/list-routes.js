'use strict';

/**
 * Danh sách route REST thật sự được đăng ký trong src/app.js (trích tĩnh bằng regex
 * trên mã nguồn — chính xác hơn việc nội suy regexp nội bộ của Express).
 *
 * CLI:  node test/list-routes.js        → in danh sách "METHOD /path"
 * API:  const { listSourceRoutes } = require('./list-routes');
 */

const fs = require('node:fs');
const path = require('node:path');

const APP_FILE = path.join(__dirname, '..', 'src', 'app.js');

function listSourceRoutes(appFile = APP_FILE) {
  const source = fs.readFileSync(appFile, 'utf8');
  const re = /app\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g;
  const routes = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

if (require.main === module) {
  const routes = listSourceRoutes();
  for (const r of routes) console.log(`${r.method.padEnd(6)} ${r.path}`);
  console.log(`\n${routes.length} routes đăng ký trong src/app.js`);
}

module.exports = { listSourceRoutes, APP_FILE };

