'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function checksum(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function timestamp(date = new Date()) { return date.toISOString().replace(/[:.]/g, '-'); }

async function validatePortalData(file) {
  try {
    const raw = await fs.readFile(file);
    const data = JSON.parse(raw.toString('utf8'));
    const collections = ['assets', 'tickets', 'licenses'];
    const valid = collections.every((key) => !data[key] || Array.isArray(data[key]));
    return { valid, data, checksum: checksum(raw), bytes: raw.length, error: valid ? null : 'Required collections must be arrays.' };
  } catch (error) {
    return { valid: false, data: null, checksum: null, bytes: 0, error: error.message };
  }
}

async function backupPortalData({ dataDir, retention = 14, now = new Date() } = {}) {
  const root = path.resolve(dataDir);
  const source = path.join(root, 'db.json');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const validation = await validatePortalData(source);
  if (!validation.valid) throw new Error(`Cannot back up invalid portal data: ${validation.error}`);
  const raw = await fs.readFile(source);
  const name = `db-${timestamp(now)}.json`;
  const file = path.join(backupDir, name);
  await fs.writeFile(file, raw, { flag: 'wx' });
  await fs.writeFile(`${file}.sha256`, `${checksum(raw)}  ${name}\n`, 'utf8');
  const files = (await fs.readdir(backupDir)).filter((entry) => /^db-.*\.json$/.test(entry)).sort().reverse();
  for (const old of files.slice(Math.max(1, Number(retention)))) await fs.rm(path.join(backupDir, old), { force: true });
  return { file, checksumFile: `${file}.sha256`, checksum: validation.checksum, retained: Math.min(files.length, Number(retention)) };
}

/**
 * Khôi phục dữ liệu từ file backup.
 *
 * VERIFY CHECKSUM: nếu file `.sha256` đi kèm tồn tại, checksum của file
 * backup được so với sidecar TRƯỚC khi ghi. Không có bước này thì checksum
 * chỉ là một tệp .sha256 nằm cho vui — file backup bị sửa tay hoặc hỏng bit
 * vẫn được khôi phục một cách âm thầm, và ta mất dữ liệu mà không biết.
 *
 * Thiếu sidecar KHÔNG phải lỗi: backup cũ hoặc backup do công cụ khác tạo
 * vẫn phải khôi phục được. Khi đó ta ghi cảnh báo vào kết quả trả về.
 */
async function restorePortalData({ backupFile, targetFile, overwrite = false, verifyChecksum = true } = {}) {
  if (!backupFile || !targetFile) throw new Error('backupFile and targetFile are required.');

  const validation = await validatePortalData(backupFile);
  if (!validation.valid) throw new Error(`Backup validation failed: ${validation.error}`);

  // So checksum với sidecar nếu có sidecar.
  let integrity = { verified: false, reason: 'no sidecar checksum file' };
  if (verifyChecksum) {
    const sidecar = `${backupFile}.sha256`;
    let sidecarRaw = null;
    try {
      sidecarRaw = await fs.readFile(sidecar, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (sidecarRaw) {
      // Sidecar có dạng "<hex>  <tên file>"; chỉ lấy phần hex đầu.
      const expected = sidecarRaw.trim().split(/\s+/)[0];
      if (expected && expected !== validation.checksum) {
        throw new Error(
          `Backup integrity check failed: file ${path.basename(backupFile)} does not ` +
          `match its .sha256 sidecar. Refusing to restore a tampered or corrupt backup.`);
      }
      integrity = { verified: true, checksum: expected };
    }
  }

  if (!overwrite) {
    try { await fs.access(targetFile); throw new Error('Target already exists; pass overwrite=true explicitly.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(path.dirname(path.resolve(targetFile)), { recursive: true });
  const raw = await fs.readFile(backupFile);
  const temporary = `${targetFile}.restore-${process.pid}`;
  await fs.writeFile(temporary, raw, 'utf8');
  await fs.rename(temporary, targetFile);
  return { valid: true, file: targetFile, checksum: validation.checksum, integrity };
}

module.exports = { backupPortalData, restorePortalData, validatePortalData, checksum };
