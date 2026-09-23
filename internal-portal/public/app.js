/* =====================================================================
   BMC IT PORTAL — Frontend controller (vanilla JS, no build step)
   Nguyên tắc UX:
     - Mọi lời gọi API đi qua api()/apiJson() → try/catch tập trung.
     - Mọi thao tác (thêm/sửa/xuất/đóng ticket) có phản hồi toast.
     - Bảng hiển thị skeleton khi chờ dữ liệu → không "trắng màn hình".
     - Tìm kiếm debounce 250ms; lọc + sort xử lý ngay trên cache.
   ===================================================================== */

'use strict';

const state = {
  assets: [],
  tickets: [],
  assetSort: { key: null, dir: 1 },
  ticketSort: { key: 'id', dir: -1 },
  loading: { assets: true, tickets: true, licenses: true },
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const STATUS_BADGE = {
  Active: 'badge-green', 'In Storage': 'badge-orange', Maintenance: 'badge-blue', Retired: 'badge-red',
  Open: 'badge-orange', 'In Progress': 'badge-blue', Resolved: 'badge-green', Closed: 'badge-green',
};
const PRIORITY_BADGE = { Low: 'badge-blue', Medium: 'badge-orange', High: 'badge-red', Critical: 'badge-red' };

// ------------------------------ Toast ------------------------------
function toast(message, type = 'info', ms = 3800) {
  const box = $('toast-container');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { success: '✅', error: '⛔', warn: '⚠️', info: 'ℹ️' };
  el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const remove = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  el.addEventListener('click', remove);
  setTimeout(remove, ms);
}

// --------------------------- API layer -----------------------------
function setOffline(offline) {
  const banner = $('offline-banner');
  if (banner) banner.hidden = !offline;
  const dot = document.querySelector('.status-indicator');
  if (dot) {
    dot.classList.toggle('live', !offline);
    dot.classList.toggle('down', Boolean(offline));
  }
  const clock = $('clock');
  if (clock && offline) clock.textContent = 'Offline';
}

/** fetch + chuẩn hoá lỗi: ném Error mang thông điệp tiếng Việt từ backend. */
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (networkErr) {
    setOffline(true);
    throw new Error('Không kết nối được máy chủ API (server chưa chạy hoặc mất mạng).');
  }
  setOffline(false);
  if (!res.ok) {
    let reason = `Lỗi HTTP ${res.status}`;
    let details = null;
    try {
      const body = await res.json();
      reason = body.error || body.message || reason;
      details = body.details || null;
    } catch (_) {
      /* body không phải JSON */
    }
    const err = new Error(details ? `${reason} — ${[].concat(details).join('; ')}` : reason);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function apiJson(path, options = {}) {
  const res = await api(path, options);
  return res.status === 204 ? null : res.json();
}

/** Tải file qua fetch để bắt được lỗi + lấy tên file server đặt (Content-Disposition). */
async function downloadFile(path, fallbackName) {
  const res = await api(path);
  const match = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/);
  const name = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
  return { name, count: Number(res.headers.get('x-total-records')) || null };
}

// --------------------------- Utilities -----------------------------
function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function skeletonRows(tbodyId, cols, rows = 5) {
  const tbody = $(tbodyId);
  if (tbody) tbody.innerHTML = Array.from({ length: rows }).map(() => `<tr>${'<td><span class="skeleton"></span></td>'.repeat(cols)}</tr>`).join('');
}

function emptyRow(tbodyId, cols, message) {
  const tbody = $(tbodyId);
  if (tbody) tbody.innerHTML = `<tr><td colspan="${cols}" class="empty-cell">${escapeHtml(message)}</td></tr>`;
}

function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

const ASSET_SEARCH_FIELDS = ['tag', 'type', 'brand', 'model', 'serial', 'assignedTo', 'dept', 'status', 'ip'];
const TICKET_SEARCH_FIELDS = ['title', 'requester', 'dept', 'category', 'status', 'priority'];

const assetFilters = () => ({ q: $('asset-search').value.trim(), type: $('asset-filter-type').value, status: $('asset-filter-status').value });
const ticketFilters = () => ({ q: $('ticket-search').value.trim(), status: $('ticket-filter-status').value, priority: $('ticket-filter-priority').value });

function applyFilters(rows, filters, fields) {
  const q = (filters.q || '').toLowerCase();
  return rows.filter((row) => {
    if (q && !fields.some((f) => String(row[f] ?? '').toLowerCase().includes(q))) return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.type && row.type !== filters.type) return false;
    if (filters.priority && row.priority !== filters.priority) return false;
    return true;
  });
}

function sortRows(rows, { key, dir }) {
  if (!key) return rows;
  const rank = { Critical: 4, High: 3, Medium: 2, Low: 1 };
  return [...rows].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (key === 'priority') {
      av = rank[av] || 0;
      bv = rank[bv] || 0;
    }
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av ?? '').localeCompare(String(bv ?? ''), 'vi') * dir;
  });
}

function syncSortCaret(tableId, sortState) {
  const table = $(tableId);
  if (!table) return;
  table.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortState.key) th.classList.add(sortState.dir === 1 ? 'sort-asc' : 'sort-desc');
  });
}

/** Đếm tăng dần cho KPI card để số liệu thay đổi không bị "giật". */
function countUp(el, target) {
  if (!el) return;
  const from = Number(el.textContent) || 0;
  if (from === target) {
    el.textContent = target;
    return;
  }
  const steps = 12;
  let i = 0;
  const tick = () => {
    i += 1;
    el.textContent = Math.round(from + ((target - from) * i) / steps);
    if (i < steps) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// --------------------------- Navigation ----------------------------
function setupNavigation() {
  const buttons = document.querySelectorAll('.nav-item');
  const titles = {
    'tab-dashboard': 'Hệ Thống Quản Lý Tài Sản & Hỗ Trợ Kỹ Thuật IT',
    'tab-assets': 'Quản Lý Thiết Bị CNTT (IT Asset Management)',
    'tab-tickets': 'Quản Lý Phiếu Hỗ Trợ Kỹ Thuật (Helpdesk Tickets)',
    'tab-licenses': 'Quản Lý Bản Quyền Phần Mềm (Software Licenses)',
  };

  const activate = (tabId) => {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === tabId));
    const title = $('page-title');
    if (title && titles[tabId]) title.textContent = titles[tabId];
    try {
      localStorage.setItem('bmc-portal-tab', tabId);
    } catch (_) {
      /* private mode: bỏ qua */
    }
  };

  buttons.forEach((btn) => btn.addEventListener('click', () => activate(btn.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((btn) => btn.addEventListener('click', () => activate(btn.dataset.goto)));
  window.showTab = activate;

  let saved = 'tab-dashboard';
  try {
    saved = localStorage.getItem('bmc-portal-tab') || saved;
  } catch (_) {
    /* ignore */
  }
  if ($(saved)) activate(saved);
}


// ------------------------ Modal + forms ----------------------------
function setupModals() {
  const assetModal = $('asset-modal');
  const ticketModal = $('ticket-modal');
  const open = (modal) => {
    modal.classList.add('show');
    const first = modal.querySelector('input, select');
    if (first) setTimeout(() => first.focus(), 50);
  };
  const close = (modal) => modal.classList.remove('show');

  $('btn-add-asset').onclick = () => open(assetModal);
  $('btn-close-asset-modal').onclick = () => close(assetModal);
  $('btn-add-ticket').onclick = () => open(ticketModal);
  $('btn-close-ticket-modal').onclick = () => close(ticketModal);

  const aiModal = $('ai-modal');
  $('btn-close-ai-modal').onclick = () => close(aiModal);

  [assetModal, ticketModal, aiModal].forEach((modal) =>
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close(modal);
    })
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close(assetModal);
      close(ticketModal);
      close(aiModal);
    }
  });

  /** Bọc submit: disable nút + đổi label khi đang gọi API, toast khi lỗi. */
  const busy = (form, text, work) => async (e) => {
    e.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    const original = submit.textContent;
    submit.disabled = true;
    submit.textContent = text;
    try {
      await work();
    } catch (err) {
      toast(err.message, 'error', 6500);
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  };

  $('asset-form').onsubmit = busy($('asset-form'), 'Đang lưu...', async () => {
    const payload = {
      tag: $('m-tag').value.trim(),
      type: $('m-type').value,
      brand: $('m-brand').value.trim(),
      model: $('m-model').value.trim(),
      serial: $('m-serial').value.trim(),
      assignedTo: $('m-user').value.trim() || 'Unassigned',
      dept: $('m-dept').value.trim() || 'General',
      status: $('m-status').value,
      ip: $('m-ip').value.trim() || '-',
    };
    const created = await apiJson('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    close(assetModal);
    $('asset-form').reset();
    toast(`Đã đăng ký ${created.tag} (ID ${created.id}) — lưu bền vững vào db.json.`, 'success');
    await Promise.all([fetchAssets(), fetchStats()]);
  });

  $('ticket-form').onsubmit = busy($('ticket-form'), 'Đang tạo...', async () => {
    const payload = {
      title: $('t-title').value.trim(),
      requester: $('t-requester').value.trim(),
      dept: $('t-dept').value.trim(),
      priority: $('t-priority').value,
      category: $('t-category').value,
    };
    const created = await apiJson('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    close(ticketModal);
    $('ticket-form').reset();
    toast(`Đã tạo ticket #${created.id} (${created.priority}).`, 'success');
    if (created.alerted) toast(`Cảnh báo ${created.priority} đã gửi tự động qua Telegram/Email (mock).`, 'warn', 6500);
    await Promise.all([fetchTickets(), fetchStats(), fetchAlerts()]);
  });
}


// ----------------------------- Data --------------------------------
async function fetchStats() {
  try {
    const data = await apiJson('/api/dashboard/stats');
    countUp($('stat-total-assets'), data.totalAssets);
    countUp($('stat-active-assets'), data.activeAssets);
    countUp($('stat-open-tickets'), data.openTickets);
    countUp($('stat-resolved-tickets'), data.resolvedTickets);
    if ($('stat-storage-assets')) $('stat-storage-assets').textContent = data.storageAssets;
    if ($('stat-critical-alerts')) $('stat-critical-alerts').textContent = data.criticalAlerts;
    if ($('stat-sla')) $('stat-sla').textContent = `${data.slaPercent}%`;
    renderAssetTypeChart(data.assetsByType || {});
    const licMeta = $('licenses-meta');
    if (licMeta && data.licenseTotal) {
      licMeta.textContent = `${data.licenseAssigned}/${data.licenseTotal} bản quyền đã cấp phát • ${data.licenseAlerts} sản phẩm đã hết chỗ cấp phát`;
    }
  } catch (err) {
    toast(`Không tải được số liệu tổng quan: ${err.message}`, 'error');
  }
}

function renderAssetTypeChart(byType) {
  const box = $('assets-by-type');
  if (!box) return;
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    box.innerHTML = '<p class="text-muted pad">Chưa có dữ liệu tài sản.</p>';
    return;
  }
  const max = Math.max(1, ...entries.map(([, n]) => n));
  box.innerHTML = entries
    .map(
      ([type, count]) => `
      <button class="bar-row" data-type="${escapeHtml(type)}" title="Lọc kho theo ${escapeHtml(type)}">
        <span class="bar-label">${escapeHtml(type)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round((count / max) * 100)}%"></span></span>
        <span class="bar-value">${count}</span>
      </button>`
    )
    .join('');
  box.querySelectorAll('.bar-row').forEach((btn) =>
    btn.addEventListener('click', () => {
      $('asset-filter-type').value = btn.dataset.type;
      renderAssetRows();
      syncClearFiltersButton();
      if (window.showTab) window.showTab('tab-assets');
    })
  );
}

async function fetchAssets() {
  state.loading.assets = true;
  skeletonRows('assets-tbody', 9);
  try {
    state.assets = await apiJson('/api/assets');
    renderAssetRows();
    renderStorageList();
  } catch (err) {
    emptyRow('assets-tbody', 9, `Lỗi tải dữ liệu: ${err.message}`);
    toast(`Không tải được danh sách thiết bị: ${err.message}`, 'error');
  } finally {
    state.loading.assets = false;
  }
}

function renderStorageList() {
  const list = $('storage-assets-list');
  if (!list) return;
  const pending = state.assets.filter((a) => a.status === 'In Storage' || a.status === 'Maintenance');
  if (!pending.length) {
    list.innerHTML = '<p class="text-muted pad">Không có thiết bị tồn kho / chờ bảo trì. 🎉</p>';
    return;
  }
  list.innerHTML = pending
    .slice(0, 5)
    .map(
      (a) => `
      <div class="ticket-item">
        <div>
          <strong>${escapeHtml(a.tag)} (${escapeHtml(a.brand)} ${escapeHtml(a.model)})</strong>
          <p class="item-sub">S/N: ${escapeHtml(a.serial)} • ${escapeHtml(a.dept)}</p>
        </div>
        <span class="badge ${STATUS_BADGE[a.status]}">${a.status === 'Maintenance' ? 'Bảo trì' : 'Chờ cấp phát'}</span>
      </div>`
    )
    .join('');
}



function renderAssetRows() {
  const filters = assetFilters();
  const rows = sortRows(applyFilters(state.assets, filters, ASSET_SEARCH_FIELDS), state.assetSort);
  const count = $('assets-count');
  if (count) {
    count.textContent =
      rows.length !== state.assets.length
        ? `Hiển thị ${rows.length}/${state.assets.length} thiết bị (đang lọc)`
        : `${rows.length} thiết bị trong hệ thống`;
  }
  syncSortCaret('assets-table', state.assetSort);
  if (!rows.length) {
    emptyRow('assets-tbody', 9, state.assets.length ? 'Không có thiết bị nào khớp bộ lọc hiện tại.' : 'Chưa có thiết bị nào. Bấm "+ Thêm Thiết Bị Mới".');
    return;
  }
  $('assets-tbody').innerHTML = rows
    .map((a) => {
      const tagSafe = escapeHtml(a.tag).replace(/'/g, '');
      const retrieve =
        a.status === 'Active'
          ? `<button class="btn btn-sm btn-secondary" onclick="updateAssetStatus(${a.id}, 'In Storage')" title="Thu hồi máy về kho IT">Thu hồi</button>`
          : '';
      const assign =
        a.status === 'In Storage'
          ? `<button class="btn btn-sm btn-primary" onclick="promptAssign(${a.id})" title="Cấp phát cho nhân viên">Cấp phát</button>`
          : '';
      return `
      <tr>
        <td><strong>${escapeHtml(a.tag)}</strong></td>
        <td>${escapeHtml(a.type)}</td>
        <td>${escapeHtml(a.brand)} ${escapeHtml(a.model)}</td>
        <td><code>${escapeHtml(a.serial)}</code></td>
        <td>${escapeHtml(a.assignedTo)}</td>
        <td>${escapeHtml(a.dept)}</td>
        <td><span class="badge ${STATUS_BADGE[a.status] || 'badge-blue'}">${escapeHtml(a.status)}</span></td>
        <td><code>${escapeHtml(a.ip)}</code></td>
        <td class="row-actions">${assign}${retrieve}<button class="btn btn-sm btn-danger" onclick="deleteAsset(${a.id}, '${tagSafe}')" title="Xóa hồ sơ tài sản">Xóa</button></td>
      </tr>`;
    })
    .join('');
}

async function fetchTickets() {
  state.loading.tickets = true;
  skeletonRows('tickets-tbody', 9);
  try {
    state.tickets = await apiJson('/api/tickets');
    renderTicketRows();
    renderRecentTickets();
  } catch (err) {
    emptyRow('tickets-tbody', 9, `Lỗi tải dữ liệu: ${err.message}`);
    toast(`Không tải được danh sách ticket: ${err.message}`, 'error');
  } finally {
    state.loading.tickets = false;
  }
}

function renderRecentTickets() {
  const list = $('recent-tickets-list');
  if (!list) return;
  const recent = [...state.tickets].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 4);
  if (!recent.length) {
    list.innerHTML = '<p class="text-muted pad">Chưa có sự cố nào được ghi nhận.</p>';
    return;
  }
  list.innerHTML = recent
    .map(
      (t) => `
      <div class="ticket-item">
        <div>
          <strong>#${t.id}: ${escapeHtml(t.title)}</strong>
          <p class="item-sub">${escapeHtml(t.requester)} (${escapeHtml(t.dept)}) • ${escapeHtml(t.createdAt)}</p>
        </div>
        <span class="badge ${STATUS_BADGE[t.status] || 'badge-blue'}">${escapeHtml(t.status)}</span>
      </div>`
    )
    .join('');
}

function renderTicketRows() {
  const filters = ticketFilters();
  const rows = sortRows(applyFilters(state.tickets, filters, TICKET_SEARCH_FIELDS), state.ticketSort);
  const count = $('tickets-count');
  if (count) {
    count.textContent =
      rows.length !== state.tickets.length
        ? `Hiển thị ${rows.length}/${state.tickets.length} ticket (đang lọc)`
        : `${rows.length} ticket trong hệ thống`;
  }
  syncSortCaret('tickets-table', state.ticketSort);
  if (!rows.length) {
    emptyRow('tickets-tbody', 9, state.tickets.length ? 'Không có ticket nào khớp bộ lọc.' : 'Chưa có ticket nào.');
    return;
  }
  $('tickets-tbody').innerHTML = rows
    .map((t) => {
      const closed = t.status === 'Resolved' || t.status === 'Closed';
      const action = closed
        ? `<button class="btn btn-sm btn-secondary" onclick="updateTicketStatus(${t.id}, 'In Progress')" title="Mở lại ticket">Mở lại</button>`
        : `<button class="btn btn-sm btn-primary" onclick="updateTicketStatus(${t.id}, 'Resolved')">Đóng Ticket</button>`;
      const urgent = !closed && (t.priority === 'High' || t.priority === 'Critical');
      const alertFlag = urgent ? ' <span class="pulse-dot" title="Ticket khẩn cấp — cảnh báo đã gửi tự động">🔴</span>' : '';
      return `
      <tr class="${urgent ? 'row-urgent' : ''}">
        <td><strong>#${t.id}</strong></td>
        <td class="cell-title">${escapeHtml(t.title)}${alertFlag}</td>
        <td>${escapeHtml(t.requester)}</td>
        <td>${escapeHtml(t.dept)}</td>
        <td><span class="badge ${PRIORITY_BADGE[t.priority] || 'badge-blue'}">${escapeHtml(t.priority)}</span></td>
        <td>${escapeHtml(t.category)}</td>
        <td class="cell-time">${escapeHtml(t.createdAt)}</td>
        <td><span class="badge ${STATUS_BADGE[t.status] || 'badge-blue'}">${escapeHtml(t.status)}</span></td>
        <td class="row-actions"><button class="btn btn-sm btn-ai" onclick="analyzeTicket(${t.id})" title="Phân tích bằng AI local (Ollama) — tóm tắt, chẩn đoán, RCA">🤖 AI</button>${action}</td>
      </tr>`;
    })
    .join('');
}

/**
 * AI Phân Tích Ticket — gọi POST /api/ai/analyze (LLM LOCAL qua Ollama,
 * fallback playbook rule-based khi model không khả dụng). Render kết quả
 * 4 phần ITIL vào modal #ai-modal.
 */
async function analyzeTicket(id) {
  const modal = $('ai-modal');
  const loading = $('ai-loading');
  const body = $('ai-body');
  const errBox = $('ai-error');
  if (!modal) return;

  modal.classList.add('show');
  loading.hidden = false;
  body.hidden = true;
  errBox.hidden = true;

  try {
    const data = await apiJson('/api/ai/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId: id }),
    });

    $('ai-engine').textContent =
      data.engine === 'ollama' ? `LLM local · ${data.model}` : `Playbook offline${data.playbook ? ' · ' + data.playbook : ''}`;
    $('ai-engine').className = `badge ${data.engine === 'ollama' ? 'badge-blue' : 'badge-orange'}`;
    $('ai-summary').textContent = data.summary;
    $('ai-diagnosis').innerHTML = (data.diagnosis || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    $('ai-rca').textContent = data.rca;
    $('ai-prevention').innerHTML = (data.prevention || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    $('ai-meta').textContent =
      `engine: ${data.engine}` +
      (data.fallbackReason ? ` · fallback: ${data.fallbackReason}` : '') +
      ` · tạo lúc ${data.generatedAt}`;
    body.hidden = false;
  } catch (err) {
    errBox.textContent = err && err.message ? err.message : 'Không phân tích được ticket.';
    errBox.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

async function fetchLicenses() {
  try {
    const rows = await apiJson('/api/licenses');
    const tbody = $('licenses-tbody');
    if (!tbody) return;
    if (!rows.length) {
      emptyRow('licenses-tbody', 6, 'Chưa có dữ liệu bản quyền.');
      return;
    }
    tbody.innerHTML = rows
      .map((l) => {
        const pct = l.utilizationPercent ?? (l.total ? Math.round((l.assigned / l.total) * 100) : 0);
        const tone = pct >= 100 ? 'fill-danger' : pct >= 85 ? 'fill-warn' : 'fill-ok';
        return `
        <tr>
          <td><strong>${escapeHtml(l.software)}</strong></td>
          <td>${l.total}</td>
          <td>${l.assigned}</td>
          <td><span class="badge ${l.available > 0 ? 'badge-green' : 'badge-red'}">${l.available > 0 ? l.available : 'Hết'}</span></td>
          <td class="cell-meter"><span class="meter"><span class="meter-fill ${tone}" style="width:${Math.min(100, pct)}%"></span></span><span class="meter-label">${pct}%</span></td>
          <td>${escapeHtml(l.renewalDate)}</td>
        </tr>`;
      })
      .join('');
  } catch (err) {
    toast(`Không tải được dữ liệu bản quyền: ${err.message}`, 'error');
  }
}

async function fetchAlerts() {
  const feed = $('alert-feed');
  if (!feed) return;
  try {
    const data = await apiJson('/api/notifications?limit=4');
    if (!data.items || !data.items.length) {
      feed.innerHTML = '<p class="text-muted pad">Chưa có cảnh báo nào. Ticket High/Critical sẽ xuất hiện tại đây.</p>';
      return;
    }
    feed.innerHTML = data.items
      .map(
        (n) => `
        <div class="ticket-item alert">
          <div>
            <strong>#${n.ticketId} • ${escapeHtml(n.title || '')}</strong>
            <p class="item-sub">${escapeHtml(n.at)} → ${escapeHtml((n.channels || []).join(', '))}</p>
          </div>
          <span class="badge ${PRIORITY_BADGE[n.priority] || 'badge-red'}">${escapeHtml(n.priority)}</span>
        </div>`
      )
      .join('');
  } catch (err) {
    feed.innerHTML = '<p class="text-muted pad">Không đọc được hàng đợi cảnh báo.</p>';
  }
}

// --------------------------- Actions -------------------------------
async function updateAssetStatus(id, status) {
  const asset = state.assets.find((a) => a.id === id);
  if (!asset) return;
  try {
    await apiJson(`/api/assets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    toast(status === 'In Storage' ? `Đã thu hồi ${asset.tag} về kho IT.` : `Đã cập nhật ${asset.tag} → ${status}.`, 'success');
    await Promise.all([fetchAssets(), fetchStats()]);
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

async function promptAssign(id) {
  const asset = state.assets.find((a) => a.id === id);
  if (!asset) return;
  const name = window.prompt(`Cấp phát ${asset.tag} (${asset.brand} ${asset.model}) cho nhân viên nào?`, '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    toast('Tên nhân viên không được để trống.', 'warn');
    return;
  }
  const deptRaw = window.prompt(`Phòng ban của ${trimmed}:`, asset.dept === 'IT Storage' ? 'General' : asset.dept);
  if (deptRaw === null) return;
  try {
    await apiJson(`/api/assets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Active', assignedTo: trimmed, dept: deptRaw.trim() || 'General' }),
    });
    toast(`Đã cấp phát ${asset.tag} cho ${trimmed}.`, 'success');
    await Promise.all([fetchAssets(), fetchStats()]);
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

async function deleteAsset(id, tag) {
  if (!window.confirm(`Xóa hồ sơ tài sản ${tag} (ID ${id})?\nHành động này không thể hoàn tác.`)) return;
  try {
    await apiJson(`/api/assets/${id}`, { method: 'DELETE' });
    toast(`Đã xóa ${tag} khỏi cơ sở dữ liệu.`, 'success');
    await Promise.all([fetchAssets(), fetchStats()]);
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

async function updateTicketStatus(id, status) {
  try {
    await apiJson(`/api/tickets/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    toast(`Ticket #${id} → ${status}.`, 'success');
    await Promise.all([fetchTickets(), fetchStats(), fetchAlerts()]);
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

// ------------------------ CSV export (Yêu cầu #4) ------------------
async function exportCsv(button, path, fallbackName, label) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Đang tạo file...';
  try {
    const file = await downloadFile(path, fallbackName);
    toast(`Đã tải ${file.name}${file.count !== null ? ` (${file.count} bản ghi)` : ''} — mở trực tiếp bằng Excel.`, 'success', 5500);
  } catch (err) {
    toast(`${label} thất bại: ${err.message}`, 'error', 6500);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

const exportAssetsCsv = (button) => exportCsv(button, `/api/assets/export.csv${qs(assetFilters())}`, 'IT-Asset-Audit.csv', 'Xuất danh sách tài sản');
const exportTicketsCsv = (button) => exportCsv(button, `/api/tickets/export.csv${qs(ticketFilters())}`, 'IT-Ticket-Report.csv', 'Xuất báo cáo ticket');

function syncClearFiltersButton() {
  const btn = $('btn-clear-asset-filters');
  if (!btn) return;
  const f = assetFilters();
  btn.hidden = !(f.q || f.type || f.status);
}


// ----------------------------- Toolbar -----------------------------
function setupToolbar() {
  const rerenderAssets = () => {
    renderAssetRows();
    syncClearFiltersButton();
  };

  $('asset-search').oninput = debounce(rerenderAssets, 250);
  $('asset-filter-type').onchange = rerenderAssets;
  $('asset-filter-status').onchange = rerenderAssets;
  $('btn-clear-asset-filters').onclick = () => {
    $('asset-search').value = '';
    $('asset-filter-type').value = '';
    $('asset-filter-status').value = '';
    rerenderAssets();
  };

  $('ticket-search').oninput = debounce(renderTicketRows, 250);
  $('ticket-filter-status').onchange = renderTicketRows;
  $('ticket-filter-priority').onchange = renderTicketRows;
  $('btn-clear-ticket-filters').onclick = () => {
    $('ticket-search').value = '';
    $('ticket-filter-status').value = '';
    $('ticket-filter-priority').value = '';
    renderTicketRows();
  };

  $('btn-export-assets').onclick = (e) => exportAssetsCsv(e.currentTarget);
  $('btn-export-tickets').onclick = (e) => exportTicketsCsv(e.currentTarget);

  $('btn-refresh-assets').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    await Promise.all([fetchStats(), fetchAssets(), fetchTickets(), fetchLicenses(), fetchAlerts()]);
    btn.disabled = false;
    toast('Đã đồng bộ lại dữ liệu từ máy chủ.', 'info', 2200);
  };

  const retry = $('btn-retry-connection');
  if (retry) retry.onclick = () => Promise.all([fetchStats(), fetchAssets(), fetchTickets(), fetchLicenses()]);

  const wireSort = (tableId, stateKey, rerender) => {
    const table = $(tableId);
    if (!table) return;
    table.querySelectorAll('th.sortable').forEach((th) =>
      th.addEventListener('click', () => {
        const st = state[stateKey];
        if (st.key === th.dataset.sort) st.dir = -st.dir;
        else {
          st.key = th.dataset.sort;
          st.dir = 1;
        }
        rerender();
      })
    );
  };
  wireSort('assets-table', 'assetSort', renderAssetRows);
  wireSort('tickets-table', 'ticketSort', renderTicketRows);
}

// ------------------------------ Boot -------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupModals();
  setupToolbar();

  fetchStats();
  fetchAssets();
  fetchTickets();
  fetchLicenses();
  fetchAlerts();

  const clock = $('clock');
  setInterval(() => {
    if (clock && $('offline-banner') && $('offline-banner').hidden) clock.textContent = new Date().toLocaleTimeString('vi-VN');
  }, 1000);
});

