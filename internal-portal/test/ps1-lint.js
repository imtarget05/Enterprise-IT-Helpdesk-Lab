'use strict';

/**
 * PowerShell static checker — dùng khi môi trường test không có pwsh/Docker.
 * Bắt các lỗi làm script fail ngay trên Windows:
 *   1. Chuỗi đơn/kép/here-string chưa đóng.   2. Comment <# ... #> chưa đóng.
 *   3. Ngoặc {} () [] lệch.                   4. Dấu câu Unicode (‘’ “ ”).
 *   5. `$var:` không bọc ${} → "Variable reference is not valid"
 *      (đúng lỗi thật từng có ở New-CompanyUser.ps1 dòng 100).
 *   6. cmdlet Verb-Noun không tồn tại nhưng gần cmdlet thật (gõ nhầm).
 * Không phải parser đầy đủ. Kết luận tuyệt đối: bash scripts/verify-ps1-syntax.sh
 */

const KNOWN_CMDLETS = new Set(
  `Add-ADGroupMember Add-Content Add-Member Add-Type Clear-Item Compare-Object ConvertFrom-Csv
   ConvertFrom-Json ConvertTo-Csv ConvertTo-Json ConvertTo-SecureString Copy-Item ForEach-Object
   Get-ADGroup Get-ADUser Get-ChildItem Get-CimInstance Get-Content Get-Date Get-HotFix Get-Item
   Get-Member Get-NetIPAddress Get-NetAdapter Get-NetRoute Get-Random Get-Service Get-SmbShare
   Get-TimeZone Get-WmiObject Import-Csv Import-Module Invoke-Command Invoke-RestMethod
   Invoke-WebRequest Join-Path Measure-Object Move-Item New-ADUser New-Item New-Object Out-File
   Out-Host Out-Null Read-Host Remove-Item Remove-Variable Select-Object Set-Content Set-Variable
   Sort-Object Start-Process Start-Sleep Test-Connection Test-NetConnection Test-Path Write-Error
   Write-Host Write-Output Write-Progress Write-Verbose Write-Warning`.split(/\s+/).filter(Boolean)
);

const SMART_CHARS = /[\u2018\u2019\u201C\u201D\u2013\u2014]/;

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function lintPowerShell(source) {
  const errors = [];
  const warnings = [];
  const lines = source.split('\n');
  const stack = [];
  const closing = { '}': '{', ')': '(', ']': '[' };
  const cmdlets = new Set();
  const functions = new Set();
  let inSq = false;
  let inDq = false;
  let hereEnd = null;
  const add = (bucket, line, rule, message) => bucket.push({ line, rule, message });

  for (let li = 0; li < lines.length; li += 1) {
    const lineNo = li + 1;
    let original = lines[li];

    // Here-string đang mở: nội dung là data thô, chỉ tìm dòng đóng
    // (delimiter phải đứng đầu dòng sau khi bỏ indent; cho phép nối pipeline phía sau,
    //  ví dụ: "@ | Out-File -FilePath x)
    if (hereEnd) {
      const trimmed = original.trimStart();
      if (trimmed.startsWith(hereEnd)) {
        original = trimmed.slice(hereEnd.length);
        hereEnd = null;
      } else {
        continue;
      }
    } else {
      const hereStart = original.match(/@(["'])\s*$/);
      if (hereStart && !inSq && !inDq) {
        hereEnd = hereStart[1] === '"' ? '"@' : "'@";
        continue;
      }
    }

    // Smart quotes CHỈ nguy hiểm ngoài comment (trong comment là text tự do)
    const isCommentLine = /^\s*#/.test(original);
    if (!isCommentLine && SMART_CHARS.test(original)) add(errors, lineNo, 'smart-quotes', 'Chứa dấu câu Unicode — PowerShell sẽ báo lỗi parse.');

    const badVar = original.match(/(^|[^\\A-Za-z0-9_$])\$([A-Za-z_][A-Za-z0-9_]*):(?![\\/])/);
    if (badVar && !original.includes('${' + badVar[2] + '}')) {
      add(errors, lineNo, 'var-colon', `Tham chiếu "$${badVar[2]}:" phải viết "$\{${badVar[2]}\}" (PowerShell coi "name:" là scope/drive).`);
    }

    if (original.includes('<#') && !original.includes('#>')) {
      let closedAt = -1;
      for (let k = li + 1; k < lines.length; k += 1) if (lines[k].includes('#>')) { closedAt = k; break; }
      if (closedAt === -1) add(errors, lineNo, 'comment', 'Khối comment <# ... #> chưa được đóng.');
      else li = closedAt;
      continue;
    }

    const fnDecl = original.match(/^\s*function\s+([A-Za-z][\w-]*)/i);
    if (fnDecl) functions.add(fnDecl[1]);

    let i = 0;
    while (i < original.length) {
      const c = original[i];
      const next = original[i + 1];
      if (inSq) { if (c === "'") { if (next === "'") i += 2; else { inSq = false; i += 1; } } else i += 1; continue; }
      if (inDq) { if (c === '`') i += 2; else if (c === '"') { if (next === '"') i += 2; else { inDq = false; i += 1; } } else i += 1; continue; }
      if (c === '#') break;
      if (c === "'") { inSq = true; i += 1; continue; }
      if (c === '"') { inDq = true; i += 1; continue; }
      if (c === '{' || c === '(' || c === '[') { stack.push({ ch: c, line: lineNo }); i += 1; continue; }
      if (closing[c]) {
        const top = stack.pop();
        if (!top) add(errors, lineNo, 'brackets', `Đóng "${c}" thừa, không có ngoặc mở.`);
        else if (top.ch !== closing[c]) add(errors, lineNo, 'brackets', `Ngoặc "${c}" không khớp "${top.ch}" mở ở dòng ${top.line}.`);
        i += 1;
        continue;
      }
      if (/[A-Za-z]/.test(c) && (i === 0 || /[\s;|&({@$]/.test(original[i - 1]))) {
        const m = original.slice(i).match(/^[A-Z][A-Za-z]+-[A-Z][A-Za-z]+/);
        if (m) { cmdlets.add(m[0]); i += m[0].length; continue; }
      }
      i += 1;
    }

    if (inSq) { inSq = false; if (!original.endsWith('`')) add(errors, lineNo, 'unterminated-string', 'Chuỗi single-quote chưa đóng trước khi hết dòng.'); }
    if (inDq) { inDq = false; if (!original.endsWith('`')) add(errors, lineNo, 'unterminated-string', 'Chuỗi double-quote chưa đóng trước khi hết dòng.'); }
  }

  if (hereEnd) add(errors, lines.length, 'unterminated-string', `Here-string chưa đóng (cần dòng chỉ chứa ${hereEnd}).`);
  for (const open of stack) add(warnings, open.line, 'brackets', `Ngoặc "${open.ch}" mở ở dòng ${open.line} chưa đóng.`);

  for (const token of cmdlets) {
    if (KNOWN_CMDLETS.has(token) || functions.has(token)) continue;
    let best = null;
    for (const known of KNOWN_CMDLETS) {
      const d = levenshtein(token.toLowerCase(), known.toLowerCase());
      if (d > 0 && d <= 2 && (!best || d < best.d)) best = { known, d };
    }
    if (best) add(errors, 0, 'cmdlet-typo', `cmdlet "${token}" không tồn tại — ý bạn là "${best.known}"? (lệch ${best.d} ký tự)`);
    else add(warnings, 0, 'cmdlet-unknown', `cmdlet "${token}" ngoài danh sách chuẩn (module phụ trợ, ví dụ ActiveDirectory).`);
  }

  return { errors, warnings, stats: { lines: lines.length, cmdlets: [...cmdlets].sort(), functions: [...functions].sort() } };
}

module.exports = { lintPowerShell, KNOWN_CMDLETS, levenshtein };

