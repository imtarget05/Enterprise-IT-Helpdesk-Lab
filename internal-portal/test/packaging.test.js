'use strict';

/**
 * Packaging / harness-safety test cho `test-api.sh` va bo script kiem thu UI.
 *
 * Vi sao la test tinh: `test-api.sh` la entry point HTTP smoke (curl) duoc ca
 * `npm run test:api` lan CI (`.github/workflows/ci.yml`) goi, nen rui ro lon
 * nhat cua no KHONG phai contract API ma la *tac dong ra ngoai`: ghi vao
 * `internal-portal/data/db.json` that, kill nham process cua may dev, giu lai
 * thu muc tam, hoac bo mat log server khi don dep. `npm test` phai bat duoc
 * nhung dac tinh do ma khong can boot server.
 *
 * Moi assertion ben duoi gan voi dieu kien cu the cua plan (Task 6.1) va
 * duoc viet de *fail dung ly do* tren ban script cu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const PORTAL = path.join(__dirname, '..');
const scriptPath = path.join(PORTAL, 'test-api.sh');
const script = fs.readFileSync(scriptPath, 'utf8');
const lines = script.split('\n');

/**
 * Docker stage `test` chay tren node:20-alpine: alpine khong co `bash` (chi co
 * busybox `ash`) va Dockerfile khong `apk add` gi. `npm test` trong image se
 * fail ENOENT neu test nao spawn `bash` ma khong guard. Vi vay moi assertion
 * co phan CHAY THUC deu tach rieng va skip khi thieu bash; phan TINH (doc source
 * cua test-api.sh) luon chay vi khong can binary nao.
 */
const HAS_BASH = (() => {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Chi giu dong thuc thi (bo comment) de assertion khong bi "dung nham" trong tai lieu. */
const code = lines.filter((l) => !/^\s*#/.test(l)).join('\n');

/** Trich nguyen van mot ham bash `name() { ... }` bang cach can bang ngoac. */
function bashFunction(name) {
  const start = code.search(new RegExp(`^${name}\\(\\)\\s*\\{`, 'm'));
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------- test-api.sh

test('test-api.sh: MANAGEMENT phai lay tu env, khong hard-code', () => {
  // Regression: `MANAGEMENT=0` gan cung khien `MANAGEMENT=1 npm run test:api`
  // (lenh trong plan Task 6.2) tro thanh vo hieu.
  assert.match(code, /^MANAGEMENT="\$\{MANAGEMENT:-(0|1)\}"/m, 'MANAGEMENT phai doc tu bien moi truong');
  const hardCoded = lines.filter((l) => /^MANAGEMENT=[01]\s*$/.test(l));
  assert.deepEqual(hardCoded, [], `con gan cung MANAGEMENT: ${hardCoded.join(' | ')}`);
});

test('test-api.sh: chi duoc kill dung PID do chinh script tao (khong pkill theo ten)', () => {
  for (const forbidden of ['pkill', 'killall', 'kill -9 -f', 'pkill -f']) {
    assert.ok(!code.includes(forbidden), `test-api.sh khong duoc dung ${forbidden} (de giet process cua may dev)`);
  }
  const killLines = code.split('\n').filter((l) => /(^|[\s;(])kill\s/.test(l));
  assert.ok(killLines.length > 0, 'phai co it nhat mot lenh kill cho server do script boot');
  const foreign = killLines.filter((l) => !l.includes('$SERVER_PID'));
  assert.deepEqual(foreign, [], `lenh kill phai nham $SERVER_PID: ${foreign.join(' | ')}`);
});

test('test-api.sh: trap INT/TERM phai thoat de EXIT cleanup thuc su chay', () => {
  // Regression: `trap cleanup EXIT INT TERM` chay cleanup roi *tiep tuc* chay
  // script sau khi da xoa RUN_DIR.
  assert.match(code, /^trap cleanup EXIT$/m, 'EXIT phai goi cleanup');
  const intTrap = code.match(/^trap\s+.*\bINT\b.*$/m);
  const termTrap = code.match(/^trap\s+.*\bTERM\b.*$/m);
  assert.ok(intTrap, 'phai co trap rieng cho INT');
  assert.ok(termTrap, 'phai co trap rieng cho TERM');
  assert.match(intTrap[0], /exit\s+\d+/, `trap INT phai exit (thoat de cleanup chay): ${intTrap[0]}`);
  assert.match(termTrap[0], /exit\s+\d+/, `trap TERM phai exit: ${termTrap[0]}`);
  assert.ok(!/^trap cleanup EXIT INT TERM$/m.test(code), 'khong duoc gop EXIT/INT/TERM vao mot trap');
});

test('test-api.sh: RUN_DIR tam nam ngoai repo va DATA_DIR la thu muc con cua no', () => {
  // Regression: `mktemp -d` khong neo vao TMPDIR + DATA_DIR mac dinh tro thang
  // vao internal-portal/data -> smoke ghi de du lieu may dev.
  assert.match(code, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/helpdesk-api\./, 'RUN_DIR phai mktemp -d neo vao ${TMPDIR:-/tmp}');
  assert.match(code, /^RUN_DIR="\$\{RUN_DIR:-/m, 'phai dat RUN_DIR (co the override)');
  assert.match(code, /^\s*DATA_DIR="\$RUN_DIR\/data"$/m, 'DATA_DIR phai la $RUN_DIR/data');
  assert.match(code, /^CSV_FILE="\$OUT_DIR\/asset-audit\.csv"$/m, 'CSV fixture phai nam trong thu muc tam');
  assert.match(code, /"\$RUN_DIR\/server\.log"/, 'server.log phai nam trong RUN_DIR');
});

test('test-api.sh: che do BASE_URL khong duoc mac dinh DATA_DIR ve data that cua repo', () => {
  assert.ok(!code.includes('$SCRIPT_DIR/data'), 'khong duoc fallback DATA_DIR="$SCRIPT_DIR/data" (ghi de data that)');
  assert.match(code, /if \[ -n "\$DATA_DIR" \]; then/, 'kiem tra data phai duoc gate theo DATA_DIR co duoc cap hay khong');
  const persistenceAt = code.indexOf('vững qua restart');
  assert.ok(persistenceAt !== -1, 'phai con section kiem tra persistence');
  const persistence = code.slice(persistenceAt);
  assert.ok(
    persistence.slice(0, 400).includes('if [ -n "$DATA_DIR" ]; then'),
    'section persistence phai bo qua (kem thong bao) khi BASE_URL mode khong co DATA_DIR explicit',
  );
  assert.match(code, /kh.ng c. DATA_DIR/i, 'can thong bao ro ly do bo qua kiem tra data');
});

test('test-api.sh: port lay tu env hoac do OS cap, khong danh sach port du phong (tinh)', () => {
  assert.ok(!/PORT="\$\{PORT:-\d/.test(code), 'PORT khong duoc co gia tri mac dinh dang so');
  assert.match(code, /^PORT="\$\{PORT:-\}"/m, 'PORT phai doc tu env, rong thi de script tu chon');
  // Vòng lặp số bình thường (đếm số lần retry) vẫn được phép; chỉ cấm vòng lặp
  // *sinh ra danh sách port* — mọi port phải đến từ env hoặc từ OS.
  const numericLoops = [...code.matchAll(/for\s+(\w+)\s+in\s+[\d\s]+;/g)];
  const portPickers = numericLoops.filter((m) => {
    const body = code.slice(m.index).split('\n').slice(0, 6).join('\n');
    return [...body.matchAll(/PORT=(.+)/g)].some((a) => !/pick_free_port/.test(a[1]));
  });
  assert.deepEqual(portPickers.map((m) => m[0]), [], `port trong vong lap phai do OS cap, khong hard-code: ${portPickers.map((m) => m[0]).join(' | ')}`);
  assert.ok(bashFunction('pick_free_port'), 'phai co ham pick_free_port() lay port trong tu he dieu hanh');
});

test('test-api.sh: pick_free_port() thuc su tra ve mot port trong (can bash)', (t) => {
  if (!HAS_BASH) return t.skip('image nay khong co bash (node:20-alpine) — phan TINH van chay o test truoc');
  // Ham chon port phai that su tu cap port trong (OS-assigned) chu khong chon
  // trong danh sach hang so — chay that ham do de chung minh.
  const fn = bashFunction('pick_free_port');
  const picked = execFileSync('bash', ['-c', `${fn}\nprintf '%s' "$(pick_free_port)"`], {
    encoding: 'utf8',
    cwd: PORTAL,
  }).trim();
  const cleanPicked = picked.replace(/\x1B\[[0-9;]*m/g, '');
  assert.match(cleanPicked, /^\d+$/, `pick_free_port phai tra ve port so, nhan "${picked}"`);
  const port = Number(cleanPicked);
  assert.ok(port > 1024 && port < 65536, `port ${port} khong hop le`);
});

test('test-api.sh: QA_LOG_DIR nhan log server + CSV + summary TRUOC khi xoa RUN_DIR', () => {
  assert.match(code, /^QA_LOG_DIR="\$\{QA_LOG_DIR:-\$RUN_DIR\}"$/m, 'QA_LOG_DIR mac dinh = $RUN_DIR');
  assert.match(code, /^SUMMARY_FILE="\$\{ARTIFACT_PREFIX\}summary\.txt"$/m, 'phai co file summary rieng');

  const cleanup = bashFunction('cleanup');
  assert.ok(cleanup, 'phai co ham cleanup()');
  const publishAt = cleanup.search(/publish_artifacts/);
  const removeAt = cleanup.search(/rm -rf "\$RUN_DIR"/);
  assert.ok(publishAt !== -1, 'cleanup phai goi publish_artifacts (luu artifact ra QA_LOG_DIR)');
  assert.ok(removeAt !== -1, 'cleanup phai xoa RUN_DIR');
  assert.ok(publishAt < removeAt, 'phai publish artifact TRUOC khi rm -rf RUN_DIR');
  assert.ok(/KEEP_DATA/.test(cleanup), 'KEEP_DATA=1 phai giu RUN_DIR de debug duoc');

  const publish = bashFunction('publish_artifacts');
  assert.ok(publish, 'phai co ham publish_artifacts()');
  assert.match(publish, /QA_LOG_DIR/, 'publish phai ghi vao QA_LOG_DIR');
  assert.match(publish, /server\.log/, 'phai copy server.log');
  assert.match(publish, /asset-audit\.csv/, 'phai copy CSV fixture');
  assert.match(publish, /SUMMARY_FILE/, 'phai copy summary');
  assert.ok(/mkdir -p "\$QA_LOG_DIR"/.test(publish), 'QA_LOG_DIR phai duoc tao neu chua co');
});

test('test-api.sh: van in bang PASS/FAIL + exit code chuan (tinh)', () => {
  assert.match(code, /^PASS=0$/m);
  assert.match(code, /^FAIL=0$/m);
  assert.match(code, /^TOTAL=0$/m);
  assert.match(script, /exit 0/, 'ket qua PASS phai exit 0');
  assert.match(script, /exit 1/, 'ket qua FAIL phai exit 1');
});

test('test-api.sh: bash -n parse duoc script (can bash)', (t) => {
  if (!HAS_BASH) return t.skip('image nay khong co bash (node:20-alpine) — phan TINH van chay o test truoc');
  execFileSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
});

test('test-api.sh: cleanup phai fail-safe — stop_server TRUOC, write_summary || true, xoa RUN_DIR sau cung', () => {
  // Regression (review Critical 2): `write_summary` tham chieu $CSV_FILE truoc khi
  // bien nay duoc gan (chi gan o section 3). `set -u` lam that la fatal NGAY TRONG
  // EXIT trap → stop_server/publish/rm khong chay → con node server.js mo coi va
  // con nguyen thu muc tam tren dia.
  assert.match(code, /^CSV_FILE=""/m, 'CSV_FILE phai duoc khoi tao o top-level truoc khi cleanup co the chay');

  // Tinh chat can bao ve: moi bien duoc DOC trong chuoi cleanup (cleanup ->
  // stop_server -> write_summary -> publish) deu phai duoc GAN truoc khi trap
  // co the chay. Mot bien doc ma chua gan = `set -u` fatal giua EXIT trap = stop
  // server + xoa RUN_DIR khong chay.
  const CHAIN = ['cleanup', 'stop_server', 'write_summary', 'publish_artifacts', 'percent_value', 'csv_fixture_name', 'csv_fixture_published'];
  const expanded = new Set();
  for (const name of CHAIN) {
    const fn = bashFunction(name);
    assert.ok(fn, `phai con ham ${name}()`);
    for (const m of fn.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) expanded.add(m[1]);
  }
  const assigned = new Set();
  // Gán có thể nằm giữa dòng (`C_G='..'; C_D='..'`) nên bắt cả dấu `;`.
  for (const m of code.matchAll(/(?:^|[;\n])\s*([A-Za-z_][A-Za-z0-9_]*)=/gm)) assigned.add(m[1]);
  for (const m of code.matchAll(/\blocal\s+([A-Za-z_][A-Za-z0-9_]*)/g)) assigned.add(m[1]);
  for (const m of code.matchAll(/\bfor\s+\{?([A-Za-z_][A-Za-z0-9_]*)\}?\s+in\b/g)) assigned.add(m[1]);
  const SHELL_BUILTINS = new Set(['TMPDIR', 'PATH', 'PWD', 'IFS']);
  const unassigned = [...expanded].filter((v) => !assigned.has(v) && !SHELL_BUILTINS.has(v));
  assert.deepEqual(unassigned, [], `bien doc trong chuoi cleanup nhung chua duoc gan (se la fatal duoi set -u): ${unassigned.join(', ')}`);

  const cleanup = bashFunction('cleanup');
  assert.ok(cleanup, 'phai co ham cleanup()');
  const stopAt = cleanup.search(/stop_server/);
  const summaryAt = cleanup.search(/write_summary/);
  const publishAt = cleanup.search(/publish_artifacts/);
  const removeAt = cleanup.search(/rm -rf "\$RUN_DIR"/);
  for (const [label, at] of [['stop_server', stopAt], ['write_summary', summaryAt], ['publish_artifacts', publishAt], ['rm -rf RUN_DIR', removeAt]]) {
    assert.ok(at !== -1, `cleanup() phai co buoc ${label}`);
  }
  assert.ok(stopAt < summaryAt, `stop_server phai chay TRUOC write_summary (hien thu tu: stop=${stopAt} summary=${summaryAt})`);
  assert.ok(summaryAt < publishAt, 'write_summary phai chay truoc publish_artifacts');
  assert.ok(publishAt < removeAt, 'publish_artifacts phai chay truoc khi xoa RUN_DIR');
  assert.match(cleanup, /write_summary\s*\|\|\s*true/, 'write_summary phai fail-safe (|| true) de con cac buoc sau van chay');
});

test('test-api.sh: failure path — server khong bao gio healthy thi khong con gi sot lai', (t) => {
  if (!HAS_BASH) return t.skip('can bash de chay test-api.sh that');
  const runId = `w3r1.${process.pid}.${Date.now()}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `helpdesk-packaging.${runId}.`));
  const qaLogDir = path.join(work, 'qa-logs');
  const pidFile = path.join(work, 'child.pid');
  const shimDir = path.join(work, 'bin');
  fs.mkdirSync(shimDir);
  // Shim `node`: khoi dong server.js thi ghi PID roi exec sleep (KHONG bao gio
  // healthy) — mo phong dung "da boot child nhung server khong len duoc".
  // Moi lenh node khac (pick_free_port, json_count, percent) van chay that.
  fs.writeFileSync(
    path.join(shimDir, 'node'),
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = "server.js" ]; then',
      '    echo $$ > "$PROBE_PID_FILE"',
      '    exec sleep 300',
      '  fi',
      'done',
      `exec ${JSON.stringify(process.execPath)} "$@"`,
      '',
    ].join('\n')
  );
  fs.chmodSync(path.join(shimDir, 'node'), 0o755);

  const problems = [];
  let childPid = null;
  let result;
  try {
    result = spawnSync('bash', [scriptPath], {
      cwd: PORTAL,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
        PROBE_PID_FILE: pidFile,
        RUN_ID: runId,
        QA_LOG_DIR: qaLogDir,
        HOST: '127.0.0.1',
        PORT: '',
        BASE_URL: '',
        DATA_DIR: '',
        MANAGEMENT: '0',
      },
    });
  } catch (err) {
    problems.push(`spawnSync that loi: ${err.message}`);
  }

  // 1) exit code phai khac 0
  if (!result || result.status === 0) problems.push(`script phai exit != 0, nhan status=${result && result.status}`);

  // 2) khong con child process nao cua script
  let childAlive = false;
  if (fs.existsSync(pidFile)) {
    childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    try {
      process.kill(childPid, 0);
      childAlive = true;
    } catch (err) {
      childAlive = err.code !== 'ESRCH';
    }
  } else {
    problems.push('khong tim thay PID child de kiem tra — shim co chay khong?');
  }
  if (childAlive) {
    problems.push(`child process ${childPid} van song sau khi script thoat`);
    try { process.kill(childPid, 'SIGKILL'); } catch { /* da chet */ }
  }

  // 3) khong con thu muc tam nao cua run nay
  const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`helpdesk-api.${runId}.`));
  for (const name of leftovers) {
    problems.push(`con thu muc tam bi ro: ${name}`);
    fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }

  // 4) van ghi duoc summary + server.log ra QA_LOG_DIR de canh chong
  const summaryPath = path.join(qaLogDir, 'helpdesk-api-summary.txt');
  if (!fs.existsSync(summaryPath)) {
    problems.push(`khong co summary trong QA_LOG_DIR (cleanup chua chay toi publish)`);
  } else {
    const summary = fs.readFileSync(summaryPath, 'utf8');
    if (!/^total=\d+$/m.test(summary)) problems.push('summary thieu total=');
    if (!/^percent=(\d+(\.\d+)?|0)$/m.test(summary)) problems.push(`summary co percent khong phai so: ${summary.match(/^percent=.*$/m)}`);
  }
  if (!fs.existsSync(path.join(qaLogDir, 'helpdesk-api-server.log'))) {
    problems.push('khong copy server.log ra QA_LOG_DIR');
  }

  const stdout = (result && result.stdout) || '';
  if (!stdout.includes('không lên được')) problems.push('stdout phai bao loi server khong len duoc');

  fs.rmSync(work, { recursive: true, force: true });
  assert.deepEqual(problems, [], problems.join('\n       '));
  assert.equal(childAlive, false);
});

// ------------------------------------------------- UI e2e harness (Task 6.4/6.5)
// Docker stage `test` chi COPY test/ + test-api.sh, KHONG COPY internal-portal/scripts
// (Playwright khong co trong image). Vi vay cac assertion duoi phai tu guard bang
// existsSync de `npm test` van xanh khi chay trong container.
const e2eScript = path.join(PORTAL, 'scripts', 'test-ui-e2e.sh');
const e2eTest = path.join(PORTAL, 'test', 'e2e', 'helpdesk-ui.e2e.py');

test('UI e2e: script + journey test ton tai trong repo (guard khi chay ngoai container)', (t) => {
  if (!fs.existsSync(e2eScript)) return t.skip('scripts/test-ui-e2e.sh khong co trong image Docker stage test');
  const shell = fs.readFileSync(e2eScript, 'utf8');
  const shellCode = shell.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(shellCode, /\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}/, 'RUN_DIR phai duoc tao boi chinh harness');
  assert.match(shellCode, /^\s*DATA_DIR="\$RUN_DIR\/data"$/m, 'DATA_DIR phai la thu muc tam');
  assert.match(shellCode, /pick_free_port|get_free_port|find_free_port/, 'phai tu chon port trong');
  assert.ok(!shellCode.includes('pkill'), 'khong duoc pkill theo ten');
  const killLines = shellCode.split('\n').filter((l) => /(^|[\s;(])kill\s/.test(l));
  assert.deepEqual(killLines.filter((l) => !l.includes('$SERVER_PID')), [], 'chi duoc kill $SERVER_PID');
  assert.match(shellCode, /api\/health/, 'phai cho HTTP readiness qua /api/health');
  assert.match(shellCode, /^\s*trap .*INT/m, 'phai co trap INT');
  assert.match(shellCode, /^\s*trap .*TERM/m, 'phai co trap TERM');
  assert.match(shellCode, /QA_LOG_DIR/, 'phai ghi artifact vao QA_LOG_DIR');
});

test('UI e2e: journey Playwright chi chup screenshot trong QA_ROOT va chan network ngoai', (t) => {
  if (!fs.existsSync(e2eTest)) return t.skip('test/e2e/helpdesk-ui.e2e.py khong co trong image Docker stage test');
  const py = fs.readFileSync(e2eTest, 'utf8');
  assert.match(py, /os\.environ(?:\.get\(|\[)["']QA_ROOT["']/, 'screenshot path phai lay tu QA_ROOT');
  assert.ok(!/\/var\/folders\//.test(py), 'khong hard-code duong dan tam ngoai QA_ROOT');
  assert.match(py, /route\(/, 'phai chan request qua route() (Google Fonts + network ngoai)');
  // Chặn Google Fonts: chấp nhận chặn theo danh sách tên miền HOẶC chặn
  // tổng quát mọi origin khác loopback (mạnh hơn). Việc thật sự không phát sinh
  // request ngoài được chứng minh bằng journey, không phải bằng regex.
  assert.ok(
    /fonts\.(googleapis|gstatic)\.com/.test(py) || /url\.startswith\(BASE_URL\)/.test(py),
    'phai chan Google Fonts (theo danh sách hoặc chặn mọi origin ngoài loopback)',
  );
  assert.match(py, /pageerror/, 'phai thu pageerror');
  assert.match(py, /requestfailed/, 'phai thu requestfailed');
  assert.match(py, /sessionStorage/, 'phai kiem tra token chi nam trong sessionStorage');
  assert.match(py, /localStorage/, 'phai kiem tra token KHONG nam trong localStorage');
});
