# 🏢 Enterprise IT Helpdesk Lab

A lightweight, production‑ready lab that simulates an **enterprise IT Helpdesk** on Windows Server 2022. It provides concrete, measurable artifacts that demonstrate real‑world readiness:

- **Test Coverage**: 104 unit/integration tests + 68 curl API tests – **0 failures**.
- **Demo Data** (running container): 6 assets, 6 tickets, 4 licenses.
- **CI Status**: GitHub Actions badge reflects a *passing* build on Node 18/20/22.
- **PowerShell Automation**: 3 scripts parsed with an official AST parser – **0 parse errors**.
- **Dockerised**: Non‑root, read‑only, health‑checked container (healthy in < 1 s).

## Quick Start (under 2 min)
```bash
# Clone & run the portal (fastest)
git clone https://github.com/imtarget05/Enterprise-IT-Helpdesk-Lab.git
cd Enterprise-IT-Helpdesk-Lab/internal-portal
npm ci && npm start   # → http://localhost:3000
```
Or launch the production environment with Docker:
```bash
cd internal-portal
docker compose up -d --wait   # http://localhost:3000
```

## Core Features (key numbers)
- **Dashboard** – KPI cards for total devices, allocated devices, open tickets, resolved tickets.
- **Asset Management** – Unique Asset‑Tag & Serial enforcement (409 on duplicate), CSV export (RFC‑4180, UTF‑8 BOM) ready for Excel.
- **Ticket System** – 20 ITIL‑style scenarios (incl. high/critical alerts) with automatic webhook mock.
- **AI Assistant** – Local LLM (Ollama) analyses tickets; falls back to rule‑based playbooks.
- **PowerShell Tools** – User provisioning, asset audit, network health checks.

## Running the Test Suite
```bash
cd internal-portal
npm test                # 104 tests – all pass
./test-api.sh           # 68 curl tests – all pass
bash scripts/verify-ps1-syntax.sh   # 3 PowerShell scripts parsed without error
```
All tests must report **0 failures**.

## Documentation
- Lab topology & VM config – `docs/01-lab-topology-vmware.md`
- AD / DNS / DHCP setup – `docs/02-ad-dns-dhcp-setup.md`
- GPO security matrix – `docs/03-gpo-security-matrix.md`
- Ticket examples – `tickets/` (20 ITIL cases)

## License
MIT – free for learning, training, and commercial use.
