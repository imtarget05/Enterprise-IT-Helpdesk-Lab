// State
let currentTab = 'tab-dashboard';
let cachedAssets = [];
let cachedTickets = [];

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupModals();
  fetchStats();
  fetchAssets();
  fetchTickets();
  fetchLicenses();

  // Clock
  setInterval(() => {
    const now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString('vi-VN');
  }, 1000);
});

function setupNavigation() {
  const buttons = document.querySelectorAll('.nav-item');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.dataset.tab;
      document.getElementById(tabId).classList.add('active');
    });
  });
}

function setupModals() {
  const assetModal = document.getElementById('asset-modal');
  const ticketModal = document.getElementById('ticket-modal');

  document.getElementById('btn-add-asset').onclick = () => assetModal.classList.add('show');
  document.getElementById('btn-close-asset-modal').onclick = () => assetModal.classList.remove('show');

  document.getElementById('btn-add-ticket').onclick = () => ticketModal.classList.add('show');
  document.getElementById('btn-close-ticket-modal').onclick = () => ticketModal.classList.remove('show');

  document.getElementById('asset-form').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      tag: document.getElementById('m-tag').value,
      type: document.getElementById('m-type').value,
      brand: document.getElementById('m-brand').value,
      model: document.getElementById('m-model').value,
      serial: document.getElementById('m-serial').value,
      assignedTo: document.getElementById('m-user').value || 'Unassigned',
      dept: document.getElementById('m-dept').value || 'General'
    };

    const res = await fetch('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      assetModal.classList.remove('show');
      document.getElementById('asset-form').reset();
      fetchAssets();
      fetchStats();
    }
  };

  document.getElementById('ticket-form').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      title: document.getElementById('t-title').value,
      requester: document.getElementById('t-requester').value,
      dept: document.getElementById('t-dept').value,
      priority: document.getElementById('t-priority').value,
      category: document.getElementById('t-category').value
    };

    const res = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      ticketModal.classList.remove('show');
      document.getElementById('ticket-form').reset();
      fetchTickets();
      fetchStats();
    }
  };

  // Search filtering
  document.getElementById('asset-search').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = cachedAssets.filter(a => 
      a.tag.toLowerCase().includes(q) ||
      a.assignedTo.toLowerCase().includes(q) ||
      a.model.toLowerCase().includes(q) ||
      a.dept.toLowerCase().includes(q)
    );
    renderAssets(filtered);
  };

  document.getElementById('ticket-search').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = cachedTickets.filter(t => 
      t.title.toLowerCase().includes(q) ||
      t.requester.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q)
    );
    renderTickets(filtered);
  };
}

async function fetchStats() {
  const res = await fetch('/api/dashboard/stats');
  const data = await res.json();
  document.getElementById('stat-total-assets').textContent = data.totalAssets;
  document.getElementById('stat-active-assets').textContent = data.activeAssets;
  document.getElementById('stat-open-tickets').textContent = data.openTickets;
  document.getElementById('stat-resolved-tickets').textContent = data.resolvedTickets;
}

async function fetchAssets() {
  const res = await fetch('/api/assets');
  cachedAssets = await res.json();
  renderAssets(cachedAssets);

  // Render storage list on dashboard
  const storageList = document.getElementById('storage-assets-list');
  const inStorage = cachedAssets.filter(a => a.status === 'In Storage');
  if (inStorage.length === 0) {
    storageList.innerHTML = '<p class="text-muted" style="padding: 10px;">Không có thiết bị tồn kho.</p>';
  } else {
    storageList.innerHTML = inStorage.map(a => `
      <div class="ticket-item">
        <div>
          <strong>${a.tag} (${a.brand} ${a.model})</strong>
          <p style="font-size: 11px; color: var(--text-muted);">S/N: ${a.serial} | Kho IT</p>
        </div>
        <span class="badge badge-orange">Chờ cấp phát</span>
      </div>
    `).join('');
  }
}

function renderAssets(list) {
  const tbody = document.getElementById('assets-tbody');
  tbody.innerHTML = list.map(a => `
    <tr>
      <td><strong>${a.tag}</strong></td>
      <td>${a.type}</td>
      <td>${a.brand} ${a.model}</td>
      <td><code>${a.serial}</code></td>
      <td>${a.assignedTo}</td>
      <td>${a.dept}</td>
      <td><span class="badge ${a.status === 'Active' ? 'badge-green' : 'badge-orange'}">${a.status}</span></td>
      <td><code>${a.ip}</code></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="deleteAsset(${a.id})">Xóa</button>
      </td>
    </tr>
  `).join('');
}

async function deleteAsset(id) {
  if (confirm('Bạn có chắc chắn muốn xóa thiết bị này?')) {
    await fetch(`/api/assets/${id}`, { method: 'DELETE' });
    fetchAssets();
    fetchStats();
  }
}

async function fetchTickets() {
  const res = await fetch('/api/tickets');
  cachedTickets = await res.json();
  renderTickets(cachedTickets);

  // Render recent tickets on dashboard
  const recentList = document.getElementById('recent-tickets-list');
  recentList.innerHTML = cachedTickets.slice(0, 4).map(t => `
    <div class="ticket-item">
      <div>
        <strong>#${t.id}: ${t.title}</strong>
        <p style="font-size: 11px; color: var(--text-muted);">${t.requester} (${t.dept}) • ${t.createdAt}</p>
      </div>
      <span class="badge ${t.status === 'Resolved' ? 'badge-green' : (t.priority === 'High' ? 'badge-red' : 'badge-orange')}">${t.status}</span>
    </div>
  `).join('');
}

function renderTickets(list) {
  const tbody = document.getElementById('tickets-tbody');
  tbody.innerHTML = list.map(t => `
    <tr>
      <td><strong>#${t.id}</strong></td>
      <td>${t.title}</td>
      <td>${t.requester}</td>
      <td>${t.dept}</td>
      <td><span class="badge ${t.priority === 'High' ? 'badge-red' : (t.priority === 'Medium' ? 'badge-orange' : 'badge-blue')}">${t.priority}</span></td>
      <td>${t.category}</td>
      <td>${t.createdAt}</td>
      <td><span class="badge ${t.status === 'Resolved' ? 'badge-green' : 'badge-orange'}">${t.status}</span></td>
      <td>
        ${t.status !== 'Resolved' ? `<button class="btn btn-sm btn-primary" onclick="resolveTicket(${t.id})">Đóng Ticket</button>` : `<span style="color: var(--text-muted); font-size: 11px;">Hoàn thành</span>`}
      </td>
    </tr>
  `).join('');
}

async function resolveTicket(id) {
  await fetch(`/api/tickets/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Resolved' })
  });
  fetchTickets();
  fetchStats();
}

async function fetchLicenses() {
  const res = await fetch('/api/licenses');
  const list = await res.json();
  const tbody = document.getElementById('licenses-tbody');
  tbody.innerHTML = list.map(l => {
    const pct = Math.round((l.assigned / l.total) * 100);
    return `
      <tr>
        <td><strong>${l.software}</strong></td>
        <td>${l.total}</td>
        <td>${l.assigned}</td>
        <td><span class="badge ${l.available > 0 ? 'badge-green' : 'badge-red'}">${l.available}</span></td>
        <td>${pct}%</td>
        <td>${l.renewalDate}</td>
      </tr>
    `;
  }).join('');
}
