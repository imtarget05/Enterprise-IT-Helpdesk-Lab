const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mock In-Memory Database (Pre-seeded with realistic enterprise records)
let assets = [
  { id: 1, tag: "LP-IT-001", type: "Laptop", brand: "Lenovo", model: "ThinkPad T14 Gen 4", serial: "PF-39X8K2", assignedTo: "Mai Nguyen Binh Tan", dept: "IT Support", status: "Active", ip: "192.168.10.101" },
  { id: 2, tag: "LP-ACC-012", type: "Laptop", brand: "Dell", model: "Latitude 5420", serial: "8H2K9L3", assignedTo: "Nguyen Thi Mai", dept: "Accounting", status: "Active", ip: "192.168.10.124" },
  { id: 3, tag: "PC-HR-004", type: "Desktop PC", brand: "HP", model: "ProDesk 400 G7", serial: "CZC12458TY", assignedTo: "Tran Van Binh", dept: "HR", status: "Active", ip: "192.168.10.110" },
  { id: 4, tag: "PRN-FL2-01", type: "Printer", brand: "HP", model: "LaserJet Enterprise M608", serial: "VNC398412", assignedTo: "Shared", dept: "Administration", status: "Active", ip: "192.168.10.25" },
  { id: 5, tag: "SW-CR-01", type: "Network Switch", brand: "Cisco", model: "Catalyst 2960X 48P", serial: "FCW2048G01", assignedTo: "Infrastructure", dept: "Server Room", status: "Active", ip: "192.168.10.2" },
  { id: 6, tag: "LP-SPARE-01", type: "Laptop", brand: "Dell", model: "Latitude 5420", serial: "7K9M2P1", assignedTo: "Unassigned", dept: "IT Storage", status: "In Storage", ip: "-" }
];

let tickets = [
  { id: 1001, title: "Cannot access Internet due to APIPA IP", requester: "Nguyen Thi Mai", dept: "Accounting", priority: "High", status: "Resolved", category: "Network", createdAt: "2026-09-23 08:30" },
  { id: 1002, title: "Cannot resolve internal DNS domain", requester: "Le Hoang Nam", dept: "Sales", priority: "Medium", status: "Resolved", category: "DNS", createdAt: "2026-09-23 09:15" },
  { id: 1003, title: "AD Account locked after password change", requester: "Tran Van Binh", dept: "HR", priority: "High", status: "Resolved", category: "Active Directory", createdAt: "2026-09-23 10:00" },
  { id: 1004, title: "Access denied on \\\\FS01\\HR share", requester: "Dang Thi Thu", dept: "HR", priority: "Medium", status: "Resolved", category: "File Server", createdAt: "2026-09-23 11:20" },
  { id: 1005, title: "Network Printer HP M608 Offline", requester: "Nguyen Van Cuong", dept: "Admin", priority: "High", status: "Resolved", category: "Hardware", createdAt: "2026-09-23 13:45" },
  { id: 1006, title: "Request new mouse and HDMI cable", requester: "Vo Thi Kim Cuc", dept: "Customer Service", priority: "Low", status: "Open", category: "Hardware Request", createdAt: "2026-09-23 14:10" }
];

let licenses = [
  { id: 1, software: "Microsoft 365 Business Standard", total: 100, assigned: 84, available: 16, renewalDate: "2027-01-15" },
  { id: 2, software: "Kaspersky Endpoint Security Cloud", total: 120, assigned: 110, available: 10, renewalDate: "2026-12-31" },
  { id: 3, software: "Adobe Creative Cloud All Apps", total: 10, assigned: 8, available: 2, renewalDate: "2026-11-20" },
  { id: 4, software: "AutoCAD 2026 Commercial", total: 15, assigned: 15, available: 0, renewalDate: "2026-10-30" }
];

// ==========================================
// REST API Routes
// ==========================================

// 1. Dashboard Metrics Summary
app.get('/api/dashboard/stats', (req, res) => {
  const totalAssets = assets.length;
  const activeAssets = assets.filter(a => a.status === 'Active').length;
  const storageAssets = assets.filter(a => a.status === 'In Storage').length;
  const openTickets = tickets.filter(t => t.status === 'Open' || t.status === 'In Progress').length;
  const resolvedTickets = tickets.filter(t => t.status === 'Resolved').length;

  res.json({
    totalAssets,
    activeAssets,
    storageAssets,
    openTickets,
    resolvedTickets,
    criticalAlerts: 0
  });
});

// 2. IT Assets Endpoints
app.get('/api/assets', (req, res) => {
  res.json(assets);
});

app.post('/api/assets', (req, res) => {
  const newAsset = {
    id: assets.length > 0 ? Math.max(...assets.map(a => a.id)) + 1 : 1,
    tag: req.body.tag,
    type: req.body.type || 'Laptop',
    brand: req.body.brand,
    model: req.body.model,
    serial: req.body.serial,
    assignedTo: req.body.assignedTo || 'Unassigned',
    dept: req.body.dept || 'General',
    status: req.body.status || 'Active',
    ip: req.body.ip || '-'
  };
  assets.unshift(newAsset);
  res.status(201).json(newAsset);
});

app.delete('/api/assets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  assets = assets.filter(a => a.id !== id);
  res.json({ success: true, message: `Asset ${id} deleted.` });
});

// 3. Helpdesk Tickets Endpoints
app.get('/api/tickets', (req, res) => {
  res.json(tickets);
});

app.post('/api/tickets', (req, res) => {
  const newTicket = {
    id: tickets.length > 0 ? Math.max(...tickets.map(t => t.id)) + 1 : 1001,
    title: req.body.title,
    requester: req.body.requester,
    dept: req.body.dept,
    priority: req.body.priority || 'Medium',
    status: 'Open',
    category: req.body.category || 'General',
    createdAt: new Date().toISOString().replace('T', ' ').substring(0, 16)
  };
  tickets.unshift(newTicket);
  res.status(201).json(newTicket);
});

app.patch('/api/tickets/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  const ticket = tickets.find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  ticket.status = req.body.status || 'Resolved';
  res.json(ticket);
});

// 4. Software Licenses Endpoints
app.get('/api/licenses', (req, res) => {
  res.json(licenses);
});

app.listen(PORT, () => {
  console.log(`[BMC IT PORTAL] Server running at http://localhost:${PORT}`);
});
