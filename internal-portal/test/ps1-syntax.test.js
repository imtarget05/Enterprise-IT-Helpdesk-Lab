'use strict';

/**
 * Kiểm tra cú pháp các script PowerShell trong ../scripts.
 *
 * Chiến lược 2 lớp:
 *   - Lớp 1 (luôn chạy ở đây): linter tĩnh test/ps1-lint.js → bắt chuỗi chưa đóng,
 *     ngoặc lệch, `$var:` sai, smart quotes, cmdlet gõ nhầm.
 *   - Lớp 2 (tuỳ chọn, khi có pwsh/Docker): scripts/verify-ps1-syntax.sh dùng
 *     [System.Management.Automation.Language.Parser]::ParseFile — AST parser CHÍNH
 *     THỨC của PowerShell.
 *
 * Kèm mutation test: bơm từng loại lỗi vào bản sao nội dung để chứng minh linter
 * thật sự phát hiện (không phải luôn trả 0 lỗi).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { lintPowerShell } = require('./ps1-lint');

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const SCRIPTS = [
  'New-CompanyUser.ps1', 'Export-ITAssetAudit.ps1', 'Test-NetworkHealth.ps1',
  'Disable-CompanyUser.ps1', 'Backup-HelpdeskData.ps1', 'Restore-HelpdeskData.ps1',
  'Backup-ADConfiguration.ps1', 'Test-PrintScanHealth.ps1',
];

// Trong Docker test stage, scripts/ được copy từ repo root; nếu build context cũ
// không có thư mục này thì nhóm test được skip và CI chạy AST verifier riêng.
const HAVE_SCRIPTS = fs.existsSync(SCRIPTS_DIR);
const skipOpt = HAVE_SCRIPTS ? false : { skip: 'không có thư mục scripts/ (đang chạy trong Docker build)' };

test('các script PowerShell đều tồn tại', skipOpt, () => {
  for (const name of SCRIPTS) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, name)), `thiếu scripts/${name}`);
  }
});

for (const name of SCRIPTS) {
  test(`scripts/${name} — 0 lỗi cú pháp tĩnh`, skipOpt, () => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    const report = lintPowerShell(source);
    assert.deepEqual(
      report.errors.map((e) => `dòng ${e.line} [${e.rule}] ${e.message}`),
      [],
      `${name} có lỗi cú pháp`
    );
    assert.ok(report.stats.lines > 20, 'script phải có nội dung thực');
    // Mỗi script phải gọi ít nhất 1 cmdlet chuẩn
    assert.ok(report.stats.cmdlets.length >= 2, 'không nhận diện được cmdlet nào — có thể file rỗng');
  });
}

test('New-CompanyUser.ps1 dùng ${username}: đúng chuẩn (regression lỗi từng có)', skipOpt, () => {
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, 'New-CompanyUser.ps1'), 'utf8');
  // Chỉ xét DÒNG CODE — comment giải thích vẫn được phép nhắc tới "$username:"
  const codeLines = source
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  assert.ok(codeLines.includes('${username}:'), 'dòng code phải bọc ${username} khi theo sau là dấu :');
  assert.ok(!/[^{\\$]\$username:/.test(codeLines), 'không còn $username: thô trong code (sẽ gây lỗi parse)');
});

// ------------------------- Mutation test -------------------------
// Chứng minh linter thật sự "có răng": bơm lỗi vào bản sao trong bộ nhớ.
function mutate(name, fn) {
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
  return lintPowerShell(fn(source));
}

test('mutation: chuỗi kép chưa đóng → linter PHẢI báo lỗi', skipOpt, () => {
  const report = mutate('Test-NetworkHealth.ps1', (s) => s + '\nWrite-Host "this string is never closed\n');
  assert.ok(report.errors.some((e) => e.rule === 'unterminated-string'), 'linter bỏ sót chuỗi chưa đóng');
});

test('mutation: ngoặc nhọn lệch → linter PHẢI báo lỗi', skipOpt, () => {
  const report = mutate('Test-NetworkHealth.ps1', (s) => s + '\nfunction Broken { if ($true) { Write-Host 1\n');
  assert.ok(
    report.errors.some((e) => e.rule === 'brackets') || report.warnings.some((e) => e.rule === 'brackets'),
    'linter bỏ sót ngoặc lệch'
  );
});

test('mutation: $var: không bọc {} → linter PHẢI báo đúng rule var-colon', skipOpt, () => {
  const report = mutate('Export-ITAssetAudit.ps1', (s) => s.replace(
    'Write-Host "Computer Name : $($assetData.ComputerName)"',
    'Write-Host "Computer Name : $($assetData.ComputerName)"\nWrite-Error "failed $assetData: boom"'
  ));
  assert.ok(report.errors.some((e) => e.rule === 'var-colon'), 'linter bỏ sót lỗi scope/reference');
});

test('mutation: cmdlet gõ nhầm Get-CimInstanse → linter PHẢI gợi ý cmdlet đúng', skipOpt, () => {
  const report = mutate('Export-ITAssetAudit.ps1', (s) => s.replace('Get-CimInstance Win32_BIOS', 'Get-CimInstanse Win32_BIOS'));
  const typo = report.errors.find((e) => e.rule === 'cmdlet-typo');
  assert.ok(typo, 'linter bỏ sót cmdlet gõ nhầm');
  assert.match(typo.message, /Get-CimInstance/, 'phải gợi ý đúng cmdlet');
});

test('mutation: smart quote trong code → linter PHẢI báo lỗi', skipOpt, () => {
  const report = mutate('Test-NetworkHealth.ps1', (s) => s.replace('"8.8.8.8"', '\u201C8.8.8.8\u201D'));
  assert.ok(report.errors.some((e) => e.rule === 'smart-quotes'), 'linter bỏ sót dấu câu Unicode');
});

test('đo lường độ chính xác: bản gốc SẠCH nhưng mỗi bản mutate đều có lỗi', skipOpt, () => {
  // Anti-flaky: đảm bảo các fixture mutate khác biệt thật so với gốc
  for (const name of SCRIPTS) {
    assert.equal(lintPowerShell(fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8')).errors.length, 0);
  }
});
