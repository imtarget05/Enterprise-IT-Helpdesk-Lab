'use strict';

/**
 * CSV Export utility — RFC 4180 compliant, UTF-8 BOM (mở trực tiếp bằng Excel
 * mà không bị lỗi font tiếng Việt), CRLF line ending.
 */

const BOM = '\uFEFF';

function stringifyCell(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function escapeCell(value) {
  const text = stringifyCell(value);
  // Luôn bọc nháy kép: an toàn tuyệt đối cho Excel/Sheets với dữ liệu IT
  // (IP, serial, ghi chú có dấu phẩy / nháy kép / xuống dòng).
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * @param {object[]} rows      Dữ liệu nguồn
 * @param {Array<{key:string,label:string,value?:function}>} columns
 * @returns {string} Nội dung CSV (đã gồm BOM)
 */
function toCsv(rows, columns) {
  const list = Array.isArray(rows) ? rows : [];
  const header = columns.map((col) => escapeCell(col.label)).join(',');
  const body = list.map((row) =>
    columns
      .map((col) => escapeCell(typeof col.value === 'function' ? col.value(row) : row[col.key]))
      .join(',')
  );
  return BOM + [header, ...body].join('\r\n') + '\r\n';
}

/** Cột chuẩn cho báo cáo kiểm kê tài sản CNTT. */
const ASSET_COLUMNS = [
  { key: 'tag', label: 'Asset Tag (Mã tài sản)' },
  { key: 'type', label: 'Loại thiết bị' },
  { key: 'brand', label: 'Thương hiệu' },
  { key: 'model', label: 'Model' },
  { key: 'serial', label: 'Serial Number' },
  { key: 'assignedTo', label: 'Người sử dụng' },
  { key: 'dept', label: 'Phòng ban' },
  { key: 'status', label: 'Trạng thái' },
  { key: 'ip', label: 'IP Address' },
  { key: 'id', label: 'Record ID' },
];

/** Tên file kiểm kê: IT-Asset-Audit_20260923_0145.csv (giờ địa phương server). */
function auditFilename(prefix = 'IT-Asset-Audit', date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
  return `${prefix}_${stamp}.csv`;
}

module.exports = { toCsv, escapeCell, auditFilename, ASSET_COLUMNS, BOM };
