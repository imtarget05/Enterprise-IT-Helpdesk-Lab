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

async function restorePortalData({ backupFile, targetFile, overwrite = false } = {}) {
  if (!backupFile || !targetFile) throw new Error('backupFile and targetFile are required.');
  const validation = await validatePortalData(backupFile);
  if (!validation.valid) throw new Error(`Backup validation failed: ${validation.error}`);
  if (!overwrite) {
    try { await fs.access(targetFile); throw new Error('Target already exists; pass overwrite=true explicitly.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(path.dirname(path.resolve(targetFile)), { recursive: true });
  const raw = await fs.readFile(backupFile);
  const temporary = `${targetFile}.restore-${process.pid}`;
  await fs.writeFile(temporary, raw, 'utf8');
  await fs.rename(temporary, targetFile);
  return { valid: true, file: targetFile, checksum: validation.checksum };
}

module.exports = { backupPortalData, restorePortalData, validatePortalData, checksum };
