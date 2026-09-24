'use strict';

const crypto = require('node:crypto');
const PRIORITY_BY_CODE = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' };
const CODE_BY_PRIORITY = { CRITICAL: 'P1', P1: 'P1', HIGH: 'P2', P2: 'P2', MEDIUM: 'P3', P3: 'P3', LOW: 'P4', P4: 'P4' };
const SLA_POLICIES = { P1: { acknowledge: 'P1', ackMinutes: 15, resolveMinutes: 240 }, P2: { acknowledge: 'P2', ackMinutes: 30, resolveMinutes: 480 }, P3: { acknowledge: 'P3', ackMinutes: 240, resolveMinutes: 2880 }, P4: { acknowledge: 'P4', ackMinutes: 1440, resolveMinutes: 7200 } };
const CANONICAL_STATES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED'];
const LEGACY_STATE_MAP = { Open: 'NEW', Assigned: 'ASSIGNED', 'In Progress': 'IN_PROGRESS', Pending: 'PENDING', Resolved: 'RESOLVED', Closed: 'CLOSED', Cancelled: 'CANCELLED' };
const STATE_TO_LEGACY = { NEW: 'Open', ASSIGNED: 'Assigned', IN_PROGRESS: 'In Progress', PENDING: 'Pending', RESOLVED: 'Resolved', CLOSED: 'Closed', CANCELLED: 'Cancelled' };
const TRANSITIONS = { NEW: ['ASSIGNED', 'IN_PROGRESS', 'PENDING', 'CANCELLED'], ASSIGNED: ['IN_PROGRESS', 'PENDING', 'CANCELLED'], IN_PROGRESS: ['PENDING', 'RESOLVED', 'CANCELLED'], PENDING: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'], RESOLVED: ['CLOSED', 'IN_PROGRESS'], CLOSED: [], CANCELLED: [] };
const CATEGORIES = ['NETWORK', 'ACCOUNT', 'HARDWARE', 'SOFTWARE', 'ERP', 'MES', 'WMS', 'PRINTER', 'SCANNER', 'SECURITY', 'OTHER'];
const ASSET_TYPES = ['LAPTOP', 'DESKTOP', 'SERVER', 'SWITCH', 'AP', 'PRINTER', 'LABEL_PRINTER', 'SCANNER', 'UPS', 'OTHER'];
const ASSET_STATUSES = ['IN_STOCK', 'ASSIGNED', 'REPAIR', 'RETIRED', 'LOST'];
const LEGACY_ASSET_STATUS_MAP = { Active: 'ASSIGNED', 'In Storage': 'IN_STOCK', Maintenance: 'REPAIR', Retired: 'RETIRED', Lost: 'LOST' };
const str = (v) => typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
const upper = (v) => str(v).toUpperCase();
const normEnum = (v, allowed, fallback) => { const n = upper(v); return allowed.includes(n) ? n : fallback; };
const priorityCodeFromLabel = (v) => CODE_BY_PRIORITY[upper(v)] || null;
const priorityLabel = (code) => PRIORITY_BY_CODE[code] || PRIORITY_BY_CODE.P3;
function derivePriorityCode(impact, urgency) { const rank = { LOW: 1, MEDIUM: 2, HIGH: 3 }; const score = rank[normEnum(impact, ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM')] + rank[normEnum(urgency, ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM')]; return score >= 6 ? 'P1' : score >= 5 ? 'P2' : score >= 3 ? 'P3' : 'P4'; }
function slaFor(codeOrLabel) { const code = priorityCodeFromLabel(codeOrLabel) || (SLA_POLICIES[codeOrLabel] ? codeOrLabel : 'P3'); return { ...SLA_POLICIES[code] }; }
function addMinutes(date, minutes) { return new Date(new Date(date).getTime() + Number(minutes) * 60000).toISOString(); }
function calculateSla(codeOrLabel, openedAt = new Date()) { const code = priorityCodeFromLabel(codeOrLabel) || (SLA_POLICIES[codeOrLabel] ? codeOrLabel : 'P3'); const p = slaFor(code); return { priorityCode: code, acknowledgeTargetAt: addMinutes(openedAt, p.ackMinutes), resolveTargetAt: addMinutes(openedAt, p.resolveMinutes) }; }
function canonicalState(value, fallback = 'NEW') { const raw = str(value); if (CANONICAL_STATES.includes(raw)) return raw; if (LEGACY_STATE_MAP[raw]) return LEGACY_STATE_MAP[raw]; const n = raw.toUpperCase().replace(/[ -]+/g, '_'); return CANONICAL_STATES.includes(n) ? n : fallback; }
const legacyStatus = (state) => STATE_TO_LEGACY[canonicalState(state)] || 'Open';
function canTransition(from, to) { const a = canonicalState(from); const b = canonicalState(to); return a === b || (TRANSITIONS[a] || []).includes(b); }
function assertTransition(from, to) { if (!canTransition(from, to)) { const e = new Error(`Transition không hợp lệ: ${from} → ${to}.`); e.status = 422; e.expose = true; throw e; } }
function isResolutionState(state) { return ['RESOLVED', 'CLOSED'].includes(canonicalState(state)); }
function mapLegacyAssetType(v) { const n = upper(v); if (n.includes('LABEL')) return 'LABEL_PRINTER'; if (n.includes('SCAN')) return 'SCANNER'; if (n.includes('PRINT')) return 'PRINTER'; if (n.includes('SWITCH') || n.includes('ROUTER')) return 'SWITCH'; if (n.includes('SERVER')) return 'SERVER'; if (n.includes('DESKTOP')) return 'DESKTOP'; if (n.includes('LAPTOP')) return 'LAPTOP'; return 'OTHER'; }
function normalizeVlan(v) { const n = upper(v); if (!n || n === '-') return null; const m = n.match(/^(?:VLAN)?(10|20|30|40|50|99)$/); return m ? `VLAN${m[1]}` : n; }
function normalizeIp(v) { const n = str(v); if (!n || n === '-') return '-'; const p = n.split('.'); return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255) ? p.join('.') : n; }

function normalizeAssetRecord(asset) {
  const r = { ...asset };
  r.assetTag = str(r.assetTag || r.tag); r.tag = r.tag || r.assetTag;
  r.assetType = normEnum(r.assetType || r.type, ASSET_TYPES, mapLegacyAssetType(r.type)); r.type = r.type || r.assetType;
  r.serialNumber = str(r.serialNumber || r.serial) || '-'; r.serial = r.serial || r.serialNumber;
  r.manufacturer = str(r.manufacturer || r.brand); r.brand = r.brand || r.manufacturer;
  r.lifecycleStatus = normEnum(r.lifecycleStatus || r.status, ASSET_STATUSES, LEGACY_ASSET_STATUS_MAP[r.status] || 'IN_STOCK'); r.status = r.status || r.lifecycleStatus;
  r.vlan = normalizeVlan(r.vlan); r.criticality = normEnum(r.criticality, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], 'MEDIUM'); r.assignedTo = r.assignedTo || 'Unassigned'; r.businessArea = r.businessArea || r.dept || 'General'; r.location = r.location || '-'; r.ipAddress = normalizeIp(r.ipAddress || r.ip); r.ip = r.ip || r.ipAddress;
  return r;
}
function normalizeTicketRecord(ticket, now = new Date()) {
  const r = { ...ticket }; const opened = r.openedAt || r.createdAt || new Date(now).toISOString(); const date = new Date(opened);
  r.priorityCode = priorityCodeFromLabel(r.priority || r.priorityCode) || derivePriorityCode(r.impact, r.urgency); r.priority = priorityLabel(r.priorityCode); r.type = normEnum(r.type, ['INCIDENT', 'SERVICE_REQUEST'], 'INCIDENT'); r.category = normEnum(r.category, CATEGORIES, 'OTHER'); r.impact = normEnum(r.impact, ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM'); r.urgency = normEnum(r.urgency, ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM'); r.state = canonicalState(r.status || r.state); r.status = legacyStatus(r.state); r.openedAt = Number.isNaN(date.getTime()) ? new Date(now).toISOString() : date.toISOString();
  const sla = calculateSla(r.priorityCode, r.openedAt); r.acknowledgeTargetAt = r.acknowledgeTargetAt || sla.acknowledgeTargetAt; r.slaTargetAt = r.slaTargetAt || sla.resolveTargetAt; r.slaPolicy = r.slaPolicy || slaFor(r.priorityCode); r.acknowledgedAt = r.acknowledgedAt || null; r.resolvedAt = r.resolvedAt || null; r.closedAt = r.closedAt || null; r.resolutionCode = r.resolutionCode || null; r.resolutionSummary = r.resolutionSummary || null; r.relatedAssetId = r.relatedAssetId ?? null; r.assignedGroup = r.assignedGroup || null; r.assignee = r.assignee || null; r.requester = r.requester || 'Unknown'; r.source = normEnum(r.source, ['USER', 'MONITORING', 'MINIERP', 'IT'], 'USER'); r.externalRef = r.externalRef || null;
  return r;
}
const sanitizeText = (v, max = 2000) => str(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[<>]/g, '').slice(0, max);
const stableHash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const isValidIp = (v) => v === '-' || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((x) => Number(x) <= 255);
const isValidVlan = (v) => v === null || ['VLAN10', 'VLAN20', 'VLAN30', 'VLAN40', 'VLAN50', 'VLAN99'].includes(v);
module.exports = { ASSET_STATUSES, ASSET_TYPES, CANONICAL_STATES, CATEGORIES, PRIORITY_BY_CODE, SLA_POLICIES, addMinutes, calculateSla, canonicalState, canTransition, derivePriorityCode, isResolutionState, isValidIp, isValidVlan, legacyStatus, normalizeAssetRecord, normEnum, normalizeTicketRecord, normalizeVlan, priorityCodeFromLabel, priorityLabel, sanitizeText, slaFor, stableHash, str, assertTransition };
