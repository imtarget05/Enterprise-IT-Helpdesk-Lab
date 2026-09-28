'use strict';

/**
 * Automated operational report (FPT AI Camera evidence: JD yêu cầu
 * "automated operational reports" bên cạnh monitoring/alerting).
 *
 * Nguyên tắc:
 *  - Offline-first: chỉ tổng hợp dữ liệu CÓ SẴN trong store (checks, history,
 *    tickets, auditEvents) — không gọi LLM, không network → chạy được ở mọi
 *    môi trường và trong test.
 *  - Aggregate-only: report chỉ chứa count/rollup, KHÔNG chứa ticket title,
 *    requester hay log body → an toàn cho mọi vai trò đã đăng nhập (global
 *    /api auth middleware vẫn áp dụng).
 *  - Pure function: window do route truyền vào → test deterministic.
 */

/** "YYYY-MM-DD HH:mm" (legacy) hoặc ISO đều parse được. */
function parseWhen(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  const normalized = raw.includes('T') ? raw : raw.includes(' ') ? raw.replace(' ', 'T') : raw;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildOpsReport({
  windowStart,
  windowEnd,
  checks = [],
  history = [],
  tickets = [],
  auditEvents = [],
} = {}) {
  const start = windowStart instanceof Date ? windowStart : new Date(windowStart);
  const end = windowEnd instanceof Date ? windowEnd : new Date(windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new TypeError('buildOpsReport: windowStart/windowEnd phải là thời điểm hợp lệ');
  }
  const inWindow = (value) => {
    const t = parseWhen(value);
    return Boolean(t && t >= start && t <= end);
  };

  // ---- Monitoring ---------------------------------------------------------
  const statusRollup = { UP: 0, DOWN: 0, DEGRADED: 0, OTHER: 0 };
  for (const check of checks) {
    const s = String(check.status || 'UNKNOWN').toUpperCase();
    if (s in statusRollup) statusRollup[s] += 1;
    else statusRollup.OTHER += 1;
  }
  const windowHistory = history.filter((row) => inWindow(row.at));
  const transitionsByStatus = { UP: 0, DOWN: 0, DEGRADED: 0, OTHER: 0 };
  for (const row of windowHistory) {
    const s = String(row.status || '').toUpperCase();
    if (s in transitionsByStatus) transitionsByStatus[s] += 1;
    else transitionsByStatus.OTHER += 1;
  }
  const failingChecks = checks
    .filter((c) => ['DOWN', 'DEGRADED'].includes(String(c.status || '').toUpperCase()))
    .map((c) => ({
      name: c.name || c.target || `check-${c.id}`,
      businessService: c.businessService || null,
      status: c.status,
      consecutiveFailures: Number(c.consecutiveFailures || 0),
      failureThreshold: Number(c.failureThreshold || 3),
    }));

  // ---- Tickets / SLA ------------------------------------------------------
  const isResolved = (t) => {
    const s = String(t.state || t.status || '').toUpperCase().replace(/\s+/g, '_');
    return ['RESOLVED', 'CLOSED', 'CANCELLED'].includes(s);
  };
  const countBy = (rows, keyFn) => {
    const out = {};
    for (const row of rows) {
      const k = keyFn(row) || 'UNKNOWN';
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  };

  const openedInWindow = tickets.filter((t) => inWindow(t.createdAt || t.openedAt));
  const backlog = tickets.filter((t) => !isResolved(t));
  const monitoringIncidents = tickets.filter(
    (t) => String(t.source || '').toUpperCase() === 'MONITORING' && inWindow(t.createdAt || t.openedAt),
  );
  const slaBreaches = tickets.filter((t) => inWindow(t.slaBreachedAt));

  const ticketsSection = {
    opened: openedInWindow.length,
    resolved: tickets.filter((t) => inWindow(t.resolvedAt)).length,
    closed: tickets.filter((t) => inWindow(t.closedAt)).length,
    slaBreached: slaBreaches.length,
    monitoringIncidentsOpened: monitoringIncidents.length,
    backlogTotal: backlog.length,
    backlogByPriority: countBy(backlog, (t) => String(t.priority || t.priorityCode || '').toUpperCase()),
    openedBySource: countBy(openedInWindow, (t) => String(t.source || '').toUpperCase()),
    openedByStatus: countBy(openedInWindow, (t) => String(t.status || t.state || '').toUpperCase()),
  };

  // ---- AI / automation activity -----------------------------------------
  const aiSection = {
    logAnalyses: auditEvents.filter((e) => e.action === 'log-analysis' && inWindow(e.at)).length,
  };

  const hours = Math.max(1, Math.round((end.getTime() - start.getTime()) / 3600000));
  const overallStatus =
    statusRollup.DOWN > 0 || ticketsSection.slaBreached > 0
      ? 'ATTENTION'
      : statusRollup.DEGRADED > 0
        ? 'DEGRADED'
        : 'HEALTHY';

  const summary = [
    `Monitoring: ${statusRollup.UP} up / ${statusRollup.DEGRADED} degraded / ${statusRollup.DOWN} down (${checks.length} checks).`,
    `Tickets: ${ticketsSection.opened} opened, ${ticketsSection.resolved} resolved, ${ticketsSection.slaBreached} SLA breach trong ${hours}h.`,
    `Backlog: ${ticketsSection.backlogTotal} ticket chưa resolve/closed.`,
    aiSection.logAnalyses > 0
      ? `AI: ${aiSection.logAnalyses} lần chạy log-analysis.`
      : 'AI: chưa có lần log-analysis nào trong cửa sổ này.',
  ];

  return {
    generatedAt: end.toISOString(),
    window: { from: start.toISOString(), to: end.toISOString(), hours },
    overallStatus,
    monitoring: { statusRollup, transitions: transitionsByStatus, historySamples: windowHistory.length, failingChecks },
    tickets: ticketsSection,
    ai: aiSection,
    summary,
  };
}

function renderMarkdown(report) {
  const lines = [];
  const w = report.window;
  lines.push('# Operational Report');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Window: ${w.from} → ${w.to} (${w.hours}h)`);
  lines.push(`- Overall: **${report.overallStatus}**`);
  lines.push('');
  lines.push('## Summary');
  for (const s of report.summary) lines.push(`- ${s}`);
  lines.push('');
  lines.push('## Monitoring');
  const r = report.monitoring.statusRollup;
  lines.push('| UP | DEGRADED | DOWN | OTHER |');
  lines.push('|---:|---:|---:|---:|');
  lines.push(`| ${r.UP} | ${r.DEGRADED} | ${r.DOWN} | ${r.OTHER} |`);
  lines.push('');
  if (report.monitoring.failingChecks.length) {
    lines.push('### Failing checks');
    for (const c of report.monitoring.failingChecks) {
      const svc = c.businessService ? ` — ${c.businessService}` : '';
      lines.push(`- **${c.name}** (${c.status}) — ${c.consecutiveFailures}/${c.failureThreshold} lần fail${svc}`);
    }
  } else {
    lines.push('Không có check DOWN/DEGRADED.');
  }
  lines.push('');
  lines.push('## Tickets & SLA');
  const t = report.tickets;
  lines.push(`- Opened: ${t.opened} | Resolved: ${t.resolved} | Closed: ${t.closed}`);
  lines.push(`- SLA breached: **${t.slaBreached}** | Monitoring incidents mở: ${t.monitoringIncidentsOpened}`);
  const prio = Object.entries(t.backlogByPriority).map(([k, v]) => `${k}:${v}`).join(', ');
  lines.push(`- Backlog: ${t.backlogTotal} (${prio || 'không có'})`);
  lines.push('');
  lines.push('## AI activity');
  lines.push(`- Log-analysis runs: ${report.ai.logAnalyses}`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { buildOpsReport, renderMarkdown, parseWhen };
