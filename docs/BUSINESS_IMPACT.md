# Business Impact — Enterprise IT Helpdesk Lab (Internal Portal + Automation)

Domain facts: Node.js portal (assets, ITIL tickets, RBAC, audit, offline ITIL
playbook AI fallback), 20 ITIL ticket scenarios, PowerShell AD/network/asset
automation, 269 portal tests + 68 API smoke checks. See `README.md`.

## Problem (cost of status quo)

A 1–3 person IT team loses time to: unknown asset ownership (Excel drift),
repeat diagnosis of known issues (no runbooks), and ~20 min manual onboarding
per employee (OU/group errors).

## Solution (what the system does)

Portal as control plane (asset/ticket/license/problem/change/access lifecycle,
SLA tracking, CSV export, AI-assisted diagnosis with offline fallback) +
scripted provisioning/diagnostics/backup + 20 reusable ITIL runbooks.

## Impact

| Metric | Before | After | How measured |
|---|---|---|---|
| L1 deflection (AI + runbooks) | 0% | 42% | ESTIMATE — plan target; pending ticket-tagged A/B counts. Not measured here. |
| Onboarding time | ~20 min manual | scripted minutes | ESTIMATE — pending timed runs of `New-CompanyUser.ps1`. |
| Portal health latency (200 reqs, local ephemeral) | — | mean 7.84 ms, p95 10.26 ms | MEASURED by `scripts/bench-portal.js` (mode: portal modules via `createApp`, temp dataDir), this machine 2026-09-27. |
| Store ops append (500 ops, local) | — | mean 0.0005 ms, p95 0.002 ms | MEASURED by `scripts/bench-portal.js`, same run. In-memory append only, not persisted write. |

No other number in this file is a production measurement.

## Guardrails / SLO links

- Atomic JSON writes + serialized commit chain + corrupt-safe fallback; RBAC;
  audit log for High/Critical tickets.
- SLOs: `observability/slo.yaml` (jobs `helpdesk-node` :3000, `helpdesk-flask` :5001).
- Test gates: `npm test` (269), `./test-api.sh` (68).

## Reproduce

```bash
cd Enterprise-IT-Helpdesk-Lab
node scripts/bench-portal.js
cd internal-portal && npm test
```
